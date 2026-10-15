// Sends a web push for one inbox row or one chat message.
//
// The database calls this after the row is saved (header X-Kursi-Token).
// Turn OFF Enforce JWT verification when deploying. This function checks
// the caller itself.
//
// Secrets on the function, never in the browser:
//   VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT   (mailto:…)
// The same public key is VITE_VAPID_PUBLIC_KEY on Vercel.
//
// Inbox rows already written by private.inbox_add are delivered as they are.
// Chat is delivered to the recipient. An analyst does not use chat, so a
// chat row addressed to an analyst is not pushed. An inbox row is pushed
// when it names that person or their role.
// A dead subscription (404 or 410) is deleted. A send failure does not
// change the inbox row or the chat message; those are already saved.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

interface WebPushError extends Error {
  statusCode?: number;
}

interface WebPush {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options?: { TTL?: number; urgency?: "high" | "normal" | "low" | "very-low" },
  ): Promise<unknown>;
}

const push = webpush as WebPush;

interface ProfileHit {
  id: string;
  role: string;
  active?: boolean;
  full_name?: string | null;
}

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  lang: string | null;
  profile_id: string;
}

interface NoteText {
  title: string;
  body: string;
  path: string;
  tag: string;
  lang: "ka" | "en";
}

function serviceKeys(): string[] {
  const keys = [Deno.env.get("SUPABASE_SECRET_KEY"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")]
    .filter((value): value is string => !!value);
  try {
    const parsed = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>;
    for (const value of Object.values(parsed)) {
      if (typeof value === "string" && value) keys.push(value);
    }
  } catch {
    // ignore a malformed key list
  }
  return keys;
}

function serviceKey(): string {
  return serviceKeys()[0] ?? "";
}

function sameSecret(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  if (left.length === 0 || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

function reply(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function outcome(result: { sent: number; removed: number; failed: number }): Response {
  const ok = result.failed === 0 || result.sent > 0;
  return reply({ ok, ...result }, ok ? 200 : 500);
}

function statusOf(err: unknown): number | null {
  if (err && typeof err === "object" && "statusCode" in err) {
    const code = (err as WebPushError).statusCode;
    if (typeof code === "number") return code;
  }
  return null;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + "…";
}

function preview(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  return text.length > 80 ? text.slice(0, 79) + "…" : text;
}

function subjectOf(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("mailto:") || value.startsWith("https:")) return value;
  if (value.includes("@")) return "mailto:" + value;
  return value;
}

// Same places the bell already opens, plus the lost-requests page when the
// person who receives a loss approval can open that page.
function inboxPath(role: string, event: string): string {
  if (event === "loss.approved" && role !== "kam") return "/lost-requests";
  if (role === "treasury") return "/rate-desk";
  if (role === "kam") return "/requests";
  if (event === "client.approved") return "/requests";
  return "/log";
}

function langOf(value: string | null): "ka" | "en" {
  return value === "en" ? "en" : "ka";
}

async function inboxTargets(admin: SupabaseClient, id: number): Promise<{ targets: ProfileHit[]; event: string; titleKa: string; titleEn: string; bodyKa: string; bodyEn: string } | null> {
  const { data, error } = await admin
    .from("user_notifications")
    .select("id, audience, profile_id, event_type, title_ka, title_en, body_ka, body_en")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  let targets: ProfileHit[] = [];
  if (data.profile_id) {
    const { data: person, error: personError } = await admin
      .from("profiles")
      .select("id, role, active")
      .eq("id", data.profile_id)
      .maybeSingle();
    if (personError) throw new Error(personError.message);
    if (person?.active) targets = [person as ProfileHit];
  } else if (data.audience) {
    const { data: people, error: peopleError } = await admin
      .from("profiles")
      .select("id, role")
      .eq("role", data.audience)
      .eq("active", true);
    if (peopleError) throw new Error(peopleError.message);
    targets = (people ?? []) as ProfileHit[];
  }

  return {
    targets,
    event: String(data.event_type ?? ""),
    titleKa: String(data.title_ka ?? ""),
    titleEn: String(data.title_en ?? ""),
    bodyKa: String(data.body_ka ?? ""),
    bodyEn: String(data.body_en ?? ""),
  };
}

async function subscriptions(admin: SupabaseClient, ids: string[]): Promise<SubRow[]> {
  if (!ids.length) return [];
  const { data, error } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth, lang, profile_id")
    .in("profile_id", ids);
  if (error) throw new Error(error.message);
  return (data ?? []) as SubRow[];
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405);

  const key = serviceKey();
  if (!SUPABASE_URL || !key) return reply({ error: "The function has no database key" }, 500);
  const admin = createClient(SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const cronToken = req.headers.get("X-Kursi-Token") ?? "";
  const serviceCall = !cronToken && !!bearer && serviceKeys().some((candidate) => sameSecret(bearer, candidate));
  if (cronToken) {
    const { data, error } = await admin.rpc("push_dispatch_secret");
    if (error || typeof data !== "string" || !sameSecret(cronToken, data)) {
      return reply({ error: "Sign in first" }, 401);
    }
  } else if (!serviceCall) {
    return reply({ error: "Sign in first" }, 401);
  }

  const publicKey = (Deno.env.get("VAPID_PUBLIC_KEY") ?? "").trim();
  const privateKey = (Deno.env.get("VAPID_PRIVATE_KEY") ?? "").trim();
  const subject = subjectOf(Deno.env.get("VAPID_SUBJECT") ?? "");
  if (!publicKey || !privateKey || !subject) {
    return reply({ error: "VAPID keys are not set" }, 500);
  }

  let body: { kind?: unknown; id?: unknown };
  try {
    body = await req.json();
  } catch {
    return reply({ error: "Bad request" }, 400);
  }
  const kind = body.kind === "inbox" || body.kind === "chat" ? body.kind : null;
  const id = typeof body.id === "number"
    ? body.id
    : typeof body.id === "string" && /^\d+$/.test(body.id) ? Number(body.id) : null;
  if (!kind || id === null || !Number.isSafeInteger(id)) return reply({ error: "Bad request" }, 400);

  try {
    push.setVapidDetails(subject, publicKey, privateKey);

    if (kind === "chat") {
      const { data: message, error: messageError } = await admin
        .from("staff_messages")
        .select("id, sender_id, recipient_id, body")
        .eq("id", id)
        .maybeSingle();
      if (messageError) throw new Error(messageError.message);
      if (!message) return reply({ ok: true, sent: 0 }, 200);

      const { data: people, error: peopleError } = await admin
        .from("profiles")
        .select("id, full_name, role, active")
        .in("id", [message.sender_id, message.recipient_id]);
      if (peopleError) throw new Error(peopleError.message);
      const rows = (people ?? []) as ProfileHit[];
      const sender = rows.find((person) => person.id === message.sender_id);
      const recipient = rows.find((person) => person.id === message.recipient_id);
      if (!recipient?.active || recipient.role === "analyst") {
        return reply({ ok: true, sent: 0 }, 200);
      }

      const subs = await subscriptions(admin, [recipient.id]);
      const text = preview(String(message.body ?? ""));
      const path = "/chat?with=" + encodeURIComponent(String(message.sender_id));
      const tag = "chat-" + id;
      const result = await deliver(admin, subs, (lang) => {
        const name = clip(sender?.full_name ?? "", 80) || (lang === "en" ? "A colleague" : "კოლეგა");
        const sentence = lang === "en" ? `${name} wrote to you: ${text}` : `${name} გწერთ: ${text}`;
        return { title: name, body: sentence, path, tag, lang };
      });
      return outcome(result);
    }

    const inbox = await inboxTargets(admin, id);
    if (!inbox) return reply({ ok: true, sent: 0 }, 200);
    const subs = await subscriptions(admin, inbox.targets.map((person) => person.id));
    const roleOf = new Map(inbox.targets.map((person) => [person.id, person.role]));
    const tag = "inbox-" + id;
    const result = await deliver(
      admin,
      subs,
      (lang) => ({
        title: clip(lang === "en" ? inbox.titleEn : inbox.titleKa, 80) || "kursi",
        body: clip(lang === "en" ? inbox.bodyEn : inbox.bodyKa, 180),
        path: "/log",
        tag,
        lang,
      }),
      (row) => inboxPath(roleOf.get(row.profile_id) ?? "", inbox.event),
    );
    return outcome(result);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "push failed");
    return reply({ error: "Push was not sent" }, 500);
  }
});

async function deliver(
  admin: SupabaseClient,
  subs: SubRow[],
  build: (lang: "ka" | "en") => NoteText,
  pathFor?: (row: SubRow) => string,
): Promise<{ sent: number; removed: number; failed: number }> {
  const cache = new Map<"ka" | "en", NoteText>();
  let sent = 0;
  let removed = 0;
  let failed = 0;

  await Promise.all(subs.map(async (row) => {
    if (!row.endpoint || !row.p256dh || !row.auth) return;
    const lang = langOf(row.lang);
    let note = cache.get(lang);
    if (!note) {
      note = build(lang);
      cache.set(lang, note);
    }
    const path = pathFor ? pathFor(row) : note.path;
    const payload = JSON.stringify({
      title: note.title,
      body: note.body,
      path,
      tag: note.tag,
      lang,
    });
    try {
      await push.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        payload,
        { TTL: 12 * 60 * 60, urgency: "high" },
      );
      sent += 1;
    } catch (err) {
      const status = statusOf(err);
      if (status === 404 || status === 410) {
        const { error } = await admin.from("push_subscriptions").delete().eq("endpoint", row.endpoint);
        if (error) failed += 1;
        else removed += 1;
      } else {
        failed += 1;
        console.error("push failed", status ?? "unknown");
      }
    }
  }));

  return { sent, removed, failed };
}

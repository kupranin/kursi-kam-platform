// =====================================================================
// admin-users: the only place logins are created or switched off.
//
// Called from the admin screen with the admin's own session:
//   supabase.functions.invoke('admin-users', { body: { action: 'invite', ... } })
//
// Actions
//   list                                     everyone, with login status
//   invite      { email, full_name, role, phone?, channels? }   sends a "set your password" email
//   set_contact { profile_id, phone, channels }   where this person gets messages (email, sms, whatsapp)
//   set_role    { profile_id, role }
//   deactivate  { profile_id }               login stops working at once
//   reactivate  { profile_id }
//   send_password_reset { profile_id }       emails a reset link
//
// Nobody, including admins, ever sees or sets another person's password.
// Required secrets: APP_URL (e.g. https://kam.kursi.ge),
// optional ALLOWED_EMAIL_DOMAIN (default kursi.ge), ALLOWED_ORIGINS.
// =====================================================================

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// Supabase provides these automatically. Newer projects may also offer the
// renamed keys, so both names are accepted.
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const APP_URL = (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");
const ALLOWED_DOMAIN = (Deno.env.get("ALLOWED_EMAIL_DOMAIN") ?? "kursi.ge").toLowerCase();
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? APP_URL)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ROLES = ["admin", "manager", "treasury", "kam"] as const;
type Role = (typeof ROLES)[number];

type Profile = {
  id: string;
  auth_user_id: string | null;
  email: string;
  full_name: string;
  role: Role;
  active: boolean;
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function corsHeaders(origin: string): Record<string, string> {
  // With no list configured, answer the caller's own origin: every action
  // still requires a signed-in admin, so this only affects browsers.
  const allowed = !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function reply(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

function jwtClaim(token: string, claim: string): unknown {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = part.padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(atob(padded))[claim];
  } catch {
    return undefined;
  }
}

function asRole(value: unknown): Role {
  if (typeof value === "string" && (ROLES as readonly string[]).includes(value)) return value as Role;
  throw new HttpError(400, "Role must be admin, manager, treasury or kam");
}

const CHANNELS = ["email", "sms", "whatsapp"];

function asPhone(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const phone = String(value).replace(/[\s-]/g, "");
  if (!/^\+[0-9]{8,15}$/.test(phone)) throw new HttpError(400, "Write the phone with the country code, e.g. +995599123456");
  return phone;
}

function asChannels(value: unknown, phone: string | null): string[] {
  const list = Array.isArray(value) && value.length ? value.map(String) : ["email"];
  if (!list.every((c) => CHANNELS.includes(c))) throw new HttpError(400, "Channels can be email, sms or whatsapp");
  if (!phone && list.some((c) => c !== "email")) throw new HttpError(400, "Add a phone number for SMS or WhatsApp");
  return [...new Set(list)];
}

function asText(value: unknown, field: string, max = 200): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) throw new HttpError(400, `Enter ${field}`);
  return text;
}

async function getProfile(admin: SupabaseClient, id: unknown): Promise<Profile> {
  if (typeof id !== "string") throw new HttpError(400, "profile_id is missing");
  const { data, error } = await admin
    .from("profiles")
    .select("id, auth_user_id, email, full_name, role, active")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "Person not found");
  return data as Profile;
}

async function activeAdminCount(admin: SupabaseClient): Promise<number> {
  const { count, error } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin")
    .eq("active", true);
  if (error) throw new HttpError(500, error.message);
  return count ?? 0;
}

async function audit(
  admin: SupabaseClient,
  actorId: string,
  action: string,
  rowKey: string,
  details: Record<string, unknown>,
) {
  await admin.from("audit_log").insert({
    actor_profile_id: actorId,
    action,
    table_name: "profiles",
    row_key: rowKey,
    new_data: details,
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") ?? "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405, origin);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // 1. Who is calling? Must be a signed-in, active admin.
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) throw new HttpError(401, "Sign in first");
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData?.user) throw new HttpError(401, "Your session has ended. Sign in again.");

    const { data: me } = await admin
      .from("profiles")
      .select("id, role, active")
      .eq("auth_user_id", userData.user.id)
      .maybeSingle();
    if (!me || !me.active || me.role !== "admin") throw new HttpError(403, "Only admins can manage people");

    const { data: rules } = await admin.from("rules").select("admin_requires_mfa").single();
    if (rules?.admin_requires_mfa && jwtClaim(token, "aal") !== "aal2") {
      throw new HttpError(403, "Confirm with your authenticator app first");
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "The request could not be read");
    }

    switch (body.action) {
      case "list": {
        const { data: people, error } = await admin
          .from("profiles")
          .select("id, auth_user_id, email, full_name, role, active, created_at, phone, notify_channels")
          .order("full_name");
        if (error) throw new HttpError(500, error.message);
        const { data: users, error: usersError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        if (usersError) throw new HttpError(500, usersError.message);
        const byId = new Map(users.users.map((u) => [u.id, u]));
        return reply({
          people: (people ?? []).map((p) => {
            const u = p.auth_user_id ? byId.get(p.auth_user_id) : undefined;
            return {
              ...p,
              has_login: Boolean(u),
              password_set: Boolean(u?.last_sign_in_at),
              last_sign_in_at: u?.last_sign_in_at ?? null,
            };
          }),
        }, 200, origin);
      }

      case "invite": {
        const email = asText(body.email, "an email address").toLowerCase();
        const fullName = asText(body.full_name, "the full name", 100);
        const role = asRole(body.role);
        const phone = asPhone(body.phone);
        const channels = asChannels(body.channels, phone);
        if (!/^[^@\s]+@[^@\s]+$/.test(email) || !email.endsWith("@" + ALLOWED_DOMAIN)) {
          throw new HttpError(400, `Use a work address ending in @${ALLOWED_DOMAIN}`);
        }
        if (!APP_URL) throw new HttpError(500, "APP_URL is not set for this function");

        // A past KAM from the imported history may already have a profile
        const { data: existing } = await admin
          .from("profiles")
          .select("id, auth_user_id")
          .eq("email", email)
          .maybeSingle();
        if (existing?.auth_user_id) throw new HttpError(409, "This person already has a login");

        const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
          redirectTo: `${APP_URL}/set-password`,
        });
        if (inviteError || !invited?.user) throw new HttpError(400, inviteError?.message ?? "Invite failed");

        const write = existing
          ? admin.from("profiles")
              .update({ auth_user_id: invited.user.id, full_name: fullName, role, active: true, phone, notify_channels: channels })
              .eq("id", existing.id)
              .select("id")
              .single()
          : admin.from("profiles")
              .insert({ auth_user_id: invited.user.id, email, full_name: fullName, role, phone, notify_channels: channels })
              .select("id")
              .single();
        const { data: profile, error: profileError } = await write;
        if (profileError || !profile) {
          await admin.auth.admin.deleteUser(invited.user.id); // no login without a profile
          throw new HttpError(500, profileError?.message ?? "Could not save the profile");
        }
        await audit(admin, me.id, "invite_user", profile.id, { email, role });
        return reply({ ok: true, profile_id: profile.id }, 200, origin);
      }

      case "set_contact": {
        const target = await getProfile(admin, body.profile_id);
        const phone = asPhone(body.phone);
        const channels = asChannels(body.channels, phone);
        const { error } = await admin.from("profiles").update({ phone, notify_channels: channels }).eq("id", target.id);
        if (error) throw new HttpError(500, error.message);
        await audit(admin, me.id, "set_contact", target.id, { channels });
        return reply({ ok: true }, 200, origin);
      }

      case "set_role": {
        const target = await getProfile(admin, body.profile_id);
        const role = asRole(body.role);
        if (target.role === "admin" && role !== "admin" && target.active && (await activeAdminCount(admin)) <= 1) {
          throw new HttpError(409, "There must always be at least one admin");
        }
        const { error } = await admin.from("profiles").update({ role }).eq("id", target.id);
        if (error) throw new HttpError(500, error.message);
        await audit(admin, me.id, "set_role", target.id, { from: target.role, to: role });
        return reply({ ok: true }, 200, origin);
      }

      case "deactivate": {
        const target = await getProfile(admin, body.profile_id);
        if (target.id === me.id) throw new HttpError(409, "You cannot switch off your own login");
        if (target.role === "admin" && target.active && (await activeAdminCount(admin)) <= 1) {
          throw new HttpError(409, "There must always be at least one admin");
        }
        // Data access stops at once (every access rule checks active);
        // the ban stops new sign-ins and session refreshes.
        const { error } = await admin.from("profiles").update({ active: false }).eq("id", target.id);
        if (error) throw new HttpError(500, error.message);
        if (target.auth_user_id) {
          const { error: banError } = await admin.auth.admin.updateUserById(target.auth_user_id, {
            ban_duration: "876000h",
          });
          if (banError) throw new HttpError(500, banError.message);
        }
        await audit(admin, me.id, "deactivate_user", target.id, { email: target.email });
        return reply({ ok: true }, 200, origin);
      }

      case "reactivate": {
        const target = await getProfile(admin, body.profile_id);
        const { error } = await admin.from("profiles").update({ active: true }).eq("id", target.id);
        if (error) throw new HttpError(500, error.message);
        if (target.auth_user_id) {
          const { error: banError } = await admin.auth.admin.updateUserById(target.auth_user_id, {
            ban_duration: "none",
          });
          if (banError) throw new HttpError(500, banError.message);
        }
        await audit(admin, me.id, "reactivate_user", target.id, { email: target.email });
        return reply({ ok: true }, 200, origin);
      }

      case "send_password_reset": {
        const target = await getProfile(admin, body.profile_id);
        if (!target.auth_user_id || !target.active) throw new HttpError(409, "This person has no active login");
        const publicClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
        const { error } = await publicClient.auth.resetPasswordForEmail(target.email, {
          redirectTo: `${APP_URL}/set-password`,
        });
        if (error) throw new HttpError(400, error.message);
        await audit(admin, me.id, "send_password_reset", target.id, { email: target.email });
        return reply({ ok: true }, 200, origin);
      }

      default:
        throw new HttpError(400, "Unknown action");
    }
  } catch (err) {
    if (err instanceof HttpError) return reply({ error: err.message }, err.status, origin);
    console.error(err);
    return reply({ error: "Something went wrong. Try again." }, 500, origin);
  }
});

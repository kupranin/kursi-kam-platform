// Fetches public buy/sell rates and stores them in public.market_rates.
//
// Called two ways:
//   the Update rates button (an admin or treasury session)
//   every 30 minutes from the database (header X-Kursi-Token)
//
// Turn OFF Enforce JWT verification when deploying. This function
// checks the caller itself.
//
// Each board and bank fetch is appended. Rows already stored stay, so
// Download rates can show 11:00, 13:00, 15:00, 17:00 and 19:00.
// Kiosks stay as the latest row only; they are not on the page or in
// the download. Paste 7_market_rates_history.sql once so the table can
// keep more than one snapshot. Until that is pasted, a new fetch is
// not saved over the previous one.
//
// Sources
//   kursi           api-core.kursi.ge public currencies.
//                   baseCurrencyCode is the quote (GEL, or a cross such as USD).
//   rico            Rico board (RUR is stored as RUB)
//   myvaluta        every bank and kiosk table on myvaluta.ge
//   valuto          Valuto's currency list
//   expresslombard  Express Lombard board
//   crystal         Crystal board (RUB is published per 100 and stored per 1)
//   girocredit      Giro Credit board (RUB is published per 100 and stored per 1)
//   fxhub           FX Hub cashless board and its crosses. The cash tab is a kiosk
//                   and is not stored.
//
// The table only accepts known source names. Paste
// setup/10_market_rate_sources.sql once so crystal, girocredit and fxhub
// can be saved. Until then those three report a problem and the others
// still save.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

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

const HEADERS: Record<string, string> = {
  "User-Agent": "KursiKAM/1.0 (rate board)",
  Accept: "application/json, text/html",
};

type Row = {
  source: string;
  venue: string;
  venue_kind: "board" | "bank" | "kiosk";
  currency: string;
  quote_currency: string;
  buy: number | null;
  sell: number | null;
  official: number | null;
};

const CURRENCY_HEADS: [string, string][] = [
  ["ავსტრალიური დოლარის კურსი", "AUD"],
  ["კანადური დოლარის კურსი", "CAD"],
  ["ჩეხური კრონის კურსი", "CZK"],
  ["დანიური კრონის კურსი", "DKK"],
  ["ნორვეგიული კრონის კურსი", "NOK"],
  ["შვედური კრონის კურსი", "SEK"],
  ["დოლარის კურსი", "USD"],
  ["ევროს კურსი", "EUR"],
  ["ფუნტის კურსი", "GBP"],
  ["რუბლის კურსი", "RUB"],
  ["ლირას კურსი", "TRY"],
  ["დრამის კურსი", "AMD"],
  ["მანათის კურსი", "AZN"],
  ["ტენგეს კურსი", "KZT"],
  ["ფრანკის კურსი", "CHF"],
  ["იუანის კურსი", "CNY"],
  ["დირჰამის კურსი", "AED"],
  ["შეკელის კურსი", "ILS"],
  ["იენის კურსი", "JPY"],
  ["ზლოტის კურსი", "PLN"],
];

function cors(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function reply(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

function textify(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function num(text: string): number | null {
  const cleaned = text.replace(/საუკეთესო/g, "");
  const match = cleaned.match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const value = Number(match[0].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

function appNum(text: string): number | null {
  const match = text.match(/აპლიკაციაში:\s*(-?\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

function code(value: string): string {
  const upper = value.toUpperCase();
  return upper === "RUR" ? "RUB" : upper;
}

const BOARD_CCY = new Set(["USD", "EUR", "RUB", "CNY"]);

function keepPair(currency: string, quote: string): boolean {
  return BOARD_CCY.has(currency) && (quote === "GEL" || BOARD_CCY.has(quote));
}

function asRate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return num(value);
  return null;
}

function divide(value: number | null, unit: number): number | null {
  if (value == null) return null;
  if (unit === 1) return value;
  return Math.round((value / unit) * 1e8) / 1e8;
}

// Some boards quote a bundle (100 RUB, 10 ILS). Keep lari per 1 unit when
// dividing by 10, 100 or 1000 lands in the pair's usual range.
function quoteUnit(pair: string, buy: number | null, sell: number | null): number {
  const probe = { source: "", venue: "", venue_kind: "board" as const, currency: "", quote_currency: "", buy, sell, official: null };
  if (sidesInPair(pair, probe)) return 1;
  for (const unit of [10, 100, 1000]) {
    if (sidesInPair(pair, { ...probe, buy: divide(buy, unit), sell: divide(sell, unit) })) return unit;
  }
  return 1;
}

function boardRow(
  source: string,
  venue: string,
  currency: string,
  quote: string,
  buy: number | null,
  sell: number | null,
  official: number | null,
): Row | null {
  const base = code(currency);
  const quoted = code(quote || "GEL");
  if (!keepPair(base, quoted) || (buy == null && sell == null)) return null;
  const unit = quoted === "GEL" ? quoteUnit(base + "/" + quoted, buy, sell) : 1;
  const nbg = official != null && official > 0 ? divide(official, unit) : null;
  return {
    source,
    venue,
    venue_kind: "board",
    currency: base,
    quote_currency: quoted,
    buy: divide(buy, unit),
    sell: divide(sell, unit),
    official: nbg,
  };
}

// Same pair rule as src/lib/rateGrid.ts. BASE/QUOTE is quote per 1 base.
// GEL pairs are foreign/GEL. Crosses stay EUR/USD, EUR/RUB, USD/RUB, USD/CNY, EUR/CNY.
// An opposite pair is inverted and buy is swapped with sell. A backwards label
// that already has the canonical number is only relabeled.
const PAIR_SCALE: Record<string, [number, number]> = {
  "USD/GEL": [1.5, 4.2],
  "EUR/GEL": [1.6, 4.8],
  "RUB/GEL": [0.008, 0.15],
  "CNY/GEL": [0.15, 0.8],
  "EUR/USD": [0.95, 1.55],
  "EUR/RUB": [40, 200],
  "USD/RUB": [40, 200],
  "USD/CNY": [4.5, 12],
  "EUR/CNY": [5, 14],
};
const CANONICAL_PAIRS = new Set(Object.keys(PAIR_SCALE));

function pairSides(row: Row): number[] {
  return [row.buy, row.sell].filter((value): value is number => value != null && value > 0);
}

function inPairScale(pair: string, value: number): boolean {
  const band = PAIR_SCALE[pair];
  return !!band && value >= band[0] && value <= band[1];
}

function sidesInPair(pair: string, row: Row): boolean {
  const values = pairSides(row);
  return values.length > 0 && values.every((value) => inPairScale(pair, value));
}

function invertRate(value: number | null): number | null {
  if (value == null || value === 0) return null;
  return 1 / value;
}

function invertRowSides(row: Row): Row {
  if (row.buy != null && row.sell != null) return { ...row, buy: invertRate(row.sell), sell: invertRate(row.buy) };
  return { ...row, buy: invertRate(row.buy), sell: invertRate(row.sell) };
}

function rowLooksReciprocal(pair: string, row: Row): boolean {
  const values = pairSides(row);
  if (!values.length || values.some((value) => inPairScale(pair, value))) return false;
  return values.every((value) => inPairScale(pair, 1 / value));
}

function orientRow(row: Row): Row {
  if (row.source === "kursi" && row.quote_currency === "GEL" && !sidesInPair(row.currency + "/GEL", row)) {
    if (row.currency === "USD" && sidesInPair("USD/CNY", row)) return { ...row, quote_currency: "CNY" };
    if (row.currency === "USD" && sidesInPair("USD/RUB", row)) return { ...row, quote_currency: "RUB" };
    if (row.currency === "EUR" && sidesInPair("EUR/USD", row)) return { ...row, quote_currency: "USD" };
    if (row.currency === "EUR" && sidesInPair("EUR/RUB", row)) return { ...row, quote_currency: "RUB" };
  }
  const pair = row.currency + "/" + row.quote_currency;
  const flipped = row.quote_currency + "/" + row.currency;
  if (CANONICAL_PAIRS.has(pair)) return rowLooksReciprocal(pair, row) ? invertRowSides(row) : row;
  if (!CANONICAL_PAIRS.has(flipped)) return row;
  if (sidesInPair(flipped, row)) return { ...row, currency: row.quote_currency, quote_currency: row.currency };
  const relabeled = { ...row, currency: row.quote_currency, quote_currency: row.currency };
  if (rowLooksReciprocal(flipped, relabeled)) return invertRowSides(relabeled);
  return row;
}

function parseMyvaluta(html: string, kind: "bank" | "kiosk"): Row[] {
  const tokens = html.match(/<h2[^>]*>[\s\S]*?<\/h2>|<table[\s\S]*?<\/table>/g) ?? [];
  let currency: string | null = null;
  const rows: Row[] = [];
  for (const token of tokens) {
    if (token.startsWith("<h2")) {
      const label = textify(token);
      currency = null;
      for (const [phrase, iso] of CURRENCY_HEADS) {
        if (label.includes(phrase)) {
          currency = iso;
          break;
        }
      }
      continue;
    }
    if (!currency) continue;
    const trs = token.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
    for (const tr of trs.slice(1)) {
      const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => textify(m[1]));
      if (cells.length < 3) continue;
      const name = cells[0];
      if (!name || name === "ბანკი" || name === "ჯიხური") continue;
      const buy = num(cells[1]);
      const sell = num(cells[2]);
      if (buy == null && sell == null) continue;
      rows.push({ source: "myvaluta", venue: name.slice(0, 80), venue_kind: kind, currency, quote_currency: "GEL", buy, sell, official: null });
      const appBuy = appNum(cells[1]);
      const appSell = appNum(cells[2]);
      if (appBuy != null || appSell != null) {
        rows.push({
          source: "myvaluta",
          venue: (name + " app").slice(0, 80),
          venue_kind: kind,
          currency,
          quote_currency: "GEL",
          buy: appBuy,
          sell: appSell,
          official: null,
        });
      }
    }
  }
  return rows;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(url + " returned " + res.status);
  return res.json();
}

async function kursi(): Promise<Row[]> {
  const data = await getJson("https://api-core.kursi.ge/api/public/currencies") as {
    baseCurrencyCode?: string;
    secondaryCurrencyCode: string;
    buyRate: number;
    sellRate: number;
    nbgRate: number;
    bankRates?: Record<string, { buyRate?: number; sellRate?: number }>;
  }[];
  const rows: Row[] = [];
  for (const item of data) {
    const currency = code(item.secondaryCurrencyCode);
    const quote = code(item.baseCurrencyCode || "GEL");
    if (!currency || currency === quote) continue;
    const buy = item.buyRate ?? null;
    const sell = item.sellRate ?? null;
    const official = item.nbgRate > 0 ? item.nbgRate : null;
    if (buy == null && sell == null && official == null) continue;
    rows.push({
      source: "kursi", venue: "Kursi", venue_kind: "board", currency, quote_currency: quote,
      buy, sell, official,
    });
    for (const [bank, rates] of Object.entries(item.bankRates ?? {})) {
      if (rates.buyRate == null && rates.sellRate == null) continue;
      rows.push({
        source: "kursi", venue: bank, venue_kind: "bank", currency, quote_currency: quote,
        buy: rates.buyRate ?? null, sell: rates.sellRate ?? null, official: null,
      });
    }
  }
  return rows;
}

async function rico(): Promise<Row[]> {
  const data = await getJson("https://api.ricofx.ge/api/v1/Currency/rates") as {
    Data?: { CurrencyName: string; Buy: number; Sell: number }[];
  };
  return (data.Data ?? []).map((item) => ({
    source: "rico", venue: "Rico", venue_kind: "board" as const, currency: code(item.CurrencyName), quote_currency: "GEL",
    buy: item.Buy ?? null, sell: item.Sell ?? null, official: null,
  }));
}

async function valuto(): Promise<Row[]> {
  const data = await getJson("https://valuto.ge/wp-json/rest-currency-list/v3/currencies") as {
    data?: { currencies?: Record<string, { CcFrom: string; CcTo: string; buy: number; sell: number; nbg: number }> };
  };
  const list = data.data?.currencies ?? {};
  return Object.values(list).map((item) => ({
    source: "valuto",
    venue: "Valuto",
    venue_kind: "board" as const,
    currency: code(item.CcFrom),
    quote_currency: code(item.CcTo),
    buy: item.buy ?? null,
    sell: item.sell ?? null,
    official: item.nbg > 0 ? item.nbg : null,
  }));
}

async function crystal(): Promise<Row[]> {
  const body = await getJson("https://crystal.ge/api/wi/rate/v1/cryst?key=52ef35743f3c4f5027d82f051c258241") as { data?: unknown };
  let payload = body.data;
  if (typeof payload === "string") payload = JSON.parse(payload) as unknown;
  const list = (payload as { data?: { CurrencyRate?: { ISO?: string; AMOUNT_BUY?: unknown; AMOUNT_SELL?: unknown; NBGRate?: unknown }[] } })?.data?.CurrencyRate ?? [];
  const rows: Row[] = [];
  for (const item of list) {
    const row = boardRow("crystal", "Crystal", item.ISO ?? "", "GEL", asRate(item.AMOUNT_BUY), asRate(item.AMOUNT_SELL), asRate(item.NBGRate));
    if (row) rows.push(row);
  }
  return rows;
}

async function giro(): Promise<Row[]> {
  const data = await getJson("https://girocredit.ge/wp-json/currency/rates") as Record<string, {
    currency_code?: string;
    buy_price?: unknown;
    sell_price?: unknown;
    nbg?: unknown;
  }>;
  const rows: Row[] = [];
  for (const item of Object.values(data)) {
    const row = boardRow("girocredit", "Giro Credit", item.currency_code ?? "", "GEL", asRate(item.buy_price), asRate(item.sell_price), asRate(item.nbg));
    if (row) rows.push(row);
  }
  return rows;
}

async function fxhub(): Promise<Row[]> {
  const data = await getJson("https://fxhub.ge/api/rates/all") as {
    cashless?: Record<string, { buy?: unknown; sell?: unknown }>;
    crossRates?: Record<string, { buy?: unknown; sell?: unknown }>;
  };
  const rows: Row[] = [];
  const take = (table: Record<string, { buy?: unknown; sell?: unknown }> | undefined) => {
    for (const [pair, quote] of Object.entries(table ?? {})) {
      const [currency, quoted] = pair.split("/");
      if (!currency || !quoted || pair.split("/").length !== 2) continue;
      const row = boardRow("fxhub", "FX Hub", currency, quoted, asRate(quote.buy), asRate(quote.sell), null);
      if (row) rows.push(row);
    }
  };
  take(data.cashless);
  take(data.crossRates);
  return rows;
}

async function lombard(): Promise<Row[]> {
  const res = await fetch("https://expresslombard.ge/api/currencies/get-currencies", {
    headers: { ...HEADERS, "x-lang": "GE" },
  });
  if (!res.ok) throw new Error("expresslombard returned " + res.status);
  const data = await res.json() as { result?: { currency: string; rateBuy: number; rateSell: number; rateNbg: number }[] };
  return (data.result ?? []).map((item) => ({
    source: "expresslombard", venue: "Express Lombard", venue_kind: "board" as const,
    currency: code(item.currency), quote_currency: "GEL",
    buy: item.rateBuy ?? null, sell: item.rateSell ?? null, official: item.rateNbg ?? null,
  }));
}

async function replaceLatest(
  admin: ReturnType<typeof createClient>,
  source: string,
  kind: "bank" | "kiosk" | null,
  payload: (Row & { fetched_at: string })[],
) {
  const removal = kind
    ? admin.from("market_rates").delete().eq("source", source).eq("venue_kind", kind)
    : admin.from("market_rates").delete().eq("source", source);
  const { error: deleteError } = await removal;
  if (deleteError) throw new Error(deleteError.message);
  const { error } = await admin.from("market_rates").insert(payload);
  if (error) throw new Error(error.message);
}

async function myvaluta(kind: "bank" | "kiosk"): Promise<Row[]> {
  const url = kind === "bank"
    ? "https://myvaluta.ge/valutis-kursi-bankebshi"
    : "https://myvaluta.ge/valutis-kursi-jixurebshi";
  const res = await fetch(url, { headers: { ...HEADERS, Accept: "text/html" } });
  if (!res.ok) throw new Error(url + " returned " + res.status);
  return parseMyvaluta(await res.text(), kind);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") ?? "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405, origin);

  const key = serviceKey();
  if (!SUPABASE_URL || !key) return reply({ error: "The function has no database key" }, 500, origin);
  const admin = createClient(SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const cronToken = req.headers.get("X-Kursi-Token") ?? "";
    // The 30-minute job sends the token created in 6_market_rates_schedule.sql.
    // A call with the service key is accepted too. Everyone else must be
    // a signed-in admin or treasury, which is what Update rates sends.
    const serviceCall = !cronToken && !!bearer && serviceKeys().some((candidate) => sameSecret(bearer, candidate));
    if (cronToken) {
      const { data, error } = await admin.rpc("market_rates_cron_secret");
      if (error || typeof data !== "string" || !sameSecret(cronToken, data)) {
        return reply({ error: "Sign in first" }, 401, origin);
      }
    } else if (!serviceCall) {
      if (!bearer) return reply({ error: "Sign in first" }, 401, origin);
      const { data: userData, error: userError } = await admin.auth.getUser(bearer);
      if (userError || !userData?.user) return reply({ error: "Your session has ended. Sign in again." }, 401, origin);
      const { data: me } = await admin.from("profiles").select("role, active").eq("auth_user_id", userData.user.id).maybeSingle();
      if (!me?.active || (me.role !== "admin" && me.role !== "treasury")) {
        return reply({ error: "Only an admin or treasury can refresh rates" }, 403, origin);
      }
    }

    const jobs: [string, () => Promise<Row[]>][] = [
      ["Kursi", kursi],
      ["Rico", rico],
      ["Valuto", valuto],
      ["Express Lombard", lombard],
      ["Crystal", crystal],
      ["Giro Credit", giro],
      ["FX Hub", fxhub],
      ["Myvaluta banks", () => myvaluta("bank")],
      ["Myvaluta kiosks", () => myvaluta("kiosk")],
    ];
    const problems: string[] = [];
    let saved = 0;
    for (const [name, load] of jobs) {
      try {
        const rows = await load();
        const unique = new Map<string, Row>();
        for (const row of rows) {
          const oriented = orientRow(row);
          unique.set([oriented.source, oriented.venue, oriented.currency, oriented.quote_currency].join("|"), oriented);
        }
        const clean = [...unique.values()];
        if (!clean.length) {
          problems.push(name + " returned no rates");
          continue;
        }
        const source = clean[0].source;
        const kind = name.startsWith("Myvaluta") ? (name.includes("bank") ? "bank" : "kiosk") : null;
        const fetchedAt = new Date().toISOString();
        const payload = clean.map((r) => ({ ...r, fetched_at: fetchedAt }));
        // Kiosks are not on the grid. Keep only their latest rows.
        if (kind === "kiosk") {
          await replaceLatest(admin, source, kind, payload);
          saved += clean.length;
          continue;
        }
        const { error } = await admin.from("market_rates").insert(payload);
        if (!error) {
          saved += clean.length;
          continue;
        }
        const detail = `${error.message} ${error.details ?? ""}`;
        const duplicate = error.code === "23505" || /duplicate key/i.test(detail);
        // This exact snapshot is already stored. Leave every older row in place.
        if (duplicate && /fetched_at/i.test(detail)) {
          saved += clean.length;
          continue;
        }
        // The old key allows one row per pair. Do not delete it: that would
        // wipe the download log. History SQL adds fetched_at to the key.
        if (duplicate) {
          problems.push(name + " was not saved. Paste 7_market_rates_history.sql so each refresh is kept, then update again.");
          continue;
        }
        throw new Error(error.message);
      } catch (err) {
        problems.push(name + ": " + (err instanceof Error ? err.message : "failed"));
      }
    }
    return reply({ ok: problems.length === 0, saved, problems }, 200, origin);
  } catch (err) {
    console.error(err);
    return reply({ error: "Something went wrong. Try again." }, 500, origin);
  }
});

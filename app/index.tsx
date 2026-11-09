// Vouch — sealed, human-reviewed claims for AI-assisted work.
// One file, Bun runtime, Postgres via Bun.sql. Deployed as a Railway Function.
import { SQL } from "bun";

const env = Bun.env;
const PORT = Number(env.PORT || 3000);
const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const WHOP_API_KEY = env.WHOP_API_KEY || "";
const WHOP_PRODUCT_URL = env.WHOP_PRODUCT_URL || "https://whop.com";
const WHOP_FREE_URL = env.WHOP_FREE_URL || WHOP_PRODUCT_URL;
const PRO_PLAN_IDS = (env.PRO_PLAN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const DEV_KEYS = (env.DEV_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
const ADMIN_KEY = env.ADMIN_KEY || "";
const STARTER_LIMIT = Number(env.STARTER_MONTHLY_LIMIT || 20);
const FREE_LIMIT = Number(env.FREE_MONTHLY_LIMIT || 3);
const PRO_MIN_PRICE = Number(env.PRO_MIN_PRICE || 29);
const limitFor = (plan: string) => (plan === "pro" ? null : plan === "starter" ? STARTER_LIMIT : FREE_LIMIT);
const PLAN_LABEL: Record<string, string> = { free: "Free", starter: "Starter", pro: "Pro" };
const WHOP_RECHECK_MS = 6 * 60 * 60 * 1000;
const VERSION = "0.3.0-dev";
// v2: listings watched per plan (null = no cap)
const LISTING_LIMITS: Record<string, number> = {
  free: Number(env.FREE_LISTING_LIMIT || 1),
  starter: Number(env.STARTER_LISTING_LIMIT || 3),
  pro: Number(env.PRO_LISTING_LIMIT || 15),
};
const listingLimitFor = (plan: string) => LISTING_LIMITS[plan] ?? LISTING_LIMITS.free;
const CAPTURE_UA = "VouchBot/1.0 (+https://vouch-app-production.up.railway.app)";
const STALE_AFTER_FAILURES = 2;
// Test-only: JSON file mapping URL -> local HTML file, used instead of fetching. Unset in production.
const CAPTURE_FIXTURES = env.CAPTURE_FIXTURES || "";
// Connect your Whop: the Whop app (dashboard view) and the signed hand-off link.
const WHOP_APP_API_KEY = env.WHOP_APP_API_KEY || "";
const WHOP_APP_ID = env.WHOP_APP_ID || "";
const LINK_SECRET = env.LINK_SECRET || "";
const WHOP_API_BASE = (env.WHOP_API_BASE || "https://api.whop.com").replace(/\/$/, ""); // overridden only in tests
const WHOP_JWKS_URL = env.WHOP_JWKS_URL || `${WHOP_API_BASE}/.well-known/jwks.json`;
const WHOP_TOKEN_ISS = "urn:whopcom:exp-proxy";
const LINK_TTL_SECONDS = 10 * 60;
const FRAME_CSP = "frame-ancestors https://whop.com https://*.whop.com";
// Unit tests import this file for its pure functions: no schema setup, no server.
const UNIT_TEST = env.VOUCH_UNIT_TEST === "1";

const sql = new SQL(env.DATABASE_URL || "postgres://postgres@localhost:5432/vouch");

// ---------- schema ----------
if (!UNIT_TEST) {
await sql`create table if not exists accounts (
  key_hash text primary key,
  plan text not null default 'starter',
  status text not null default 'active',
  whop_membership_id text,
  display_name text,
  slug text unique,
  created_at timestamptz not null default now(),
  checked_at timestamptz not null default now()
)`;
await sql`create table if not exists reviews (
  id text primary key,
  account_key_hash text not null references accounts(key_hash),
  token text not null,
  code text unique,
  title text not null,
  product_name text,
  source text not null default 'paste',
  created_at timestamptz not null default now(),
  opened_at timestamptz,
  sealed_at timestamptz,
  review_seconds integer,
  seller_name text,
  seller_slug text,
  purpose text,
  prev_hash text,
  seal_hash text,
  sealed_payload text
)`;
await sql`create table if not exists claims (
  review_id text not null references reviews(id) on delete cascade,
  idx integer not null,
  text text not null,
  verdict text,
  fix_text text,
  primary key (review_id, idx)
)`;
await sql`create table if not exists files (
  review_id text not null references reviews(id) on delete cascade,
  idx integer not null,
  name text not null,
  sha256 text not null,
  mime text,
  primary key (review_id, idx)
)`;
await sql`create table if not exists views (
  code text not null,
  referrer_host text,
  viewed_at timestamptz not null default now()
)`;
await sql`create table if not exists events (
  name text not null,
  review_id text,
  meta text,
  at timestamptz not null default now()
)`;
await sql`create table if not exists listings (
  id text primary key,
  account_key_hash text not null references accounts(key_hash),
  url text not null,
  product_id text,
  title text,
  owner_verified boolean not null default false,
  status text not null default 'active',
  fail_count integer not null default 0,
  last_error text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (account_key_hash, url)
)`;
await sql`create table if not exists listing_versions (
  id text primary key,
  listing_id text not null references listings(id) on delete cascade,
  version_no integer not null,
  listing_hash text not null,
  text text not null,
  title text,
  default_plan text,
  plans_count integer,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  source text not null default 'captured',
  sealed_at timestamptz not null default now(),
  prev_hash text,
  seal_hash text,
  sealed_payload text,
  unique (listing_id, version_no)
)`;
await sql`create index if not exists listing_versions_sealed_idx on listing_versions (sealed_at)`;
await sql`create index if not exists reviews_seller_idx on reviews (seller_slug) where code is not null`;
await sql`create index if not exists reviews_account_idx on reviews (account_key_hash, created_at)`;
// Connect your Whop: one linked business per account; listings remember which business verified them.
await sql`alter table accounts add column if not exists whop_biz_id text`;
await sql`alter table accounts add column if not exists whop_user_id text`;
await sql`alter table accounts add column if not exists linked_at timestamptz`;
await sql`alter table listings add column if not exists whop_biz_id text`;
await sql`alter table listing_versions add column if not exists plans text`;
}

// ---------- helpers ----------
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randCode(n: number) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let out = "";
  for (const x of b) out += ALPHA[x % ALPHA.length];
  return out;
}
function randToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "seller";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
async function logEvent(name: string, reviewId: string | null, meta: Record<string, unknown> = {}) {
  try { await sql`insert into events (name, review_id, meta) values (${name}, ${reviewId}, ${JSON.stringify(meta)})`; } catch {}
}
function fmtDuration(sec: number | null) {
  if (sec == null) return "";
  if (sec < 60) return `${sec} sec`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
function fmtDate(d: Date | string | null) {
  if (!d) return "";
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" });
}

// Split pasted text into checkable claims when the caller didn't send a list.
function splitClaims(text: string): string[] {
  const lines = text.replace(/\r/g, "").split(/\n+/).map((l) => l.replace(/^\s*([-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    const parts = line.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [line];
    for (const p of parts) {
      const t = p.trim();
      if (t.length >= 12) out.push(t);
    }
  }
  return out.slice(0, 40);
}

// ---------- auth (Whop license key = account key) ----------
type Account = { key_hash: string; plan: string; status: string; display_name: string | null; slug: string | null; whop_biz_id?: string | null; whop_user_id?: string | null; linked_at?: Date | null };

async function whopLookup(key: string): Promise<{ ok: boolean; plan: string; membershipId: string | null } | null> {
  if (!WHOP_API_KEY) return null;
  try {
    const r = await fetch(`https://api.whop.com/api/v1/memberships/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${WHOP_API_KEY}`, "Api-Version-Date": "2026-08-21-1" },
    });
    if (!r.ok) return { ok: false, plan: "free", membershipId: null };
    const m: any = await r.json();
    const ok = ["active", "trialing"].includes(String(m.status));
    const planId = String(m.plan?.id || m.plan_id || m.plan || "");
    console.log("whop membership shape", JSON.stringify({ keys: Object.keys(m), status: m.status, planId }));
    return { ok, plan: await planTier(planId), membershipId: m.id || null };
  } catch {
    return null; // Whop unreachable: fall back to cached status
  }
}

// Tier from the Whop plan: listed in PRO_PLAN_IDS → pro; otherwise by price:
// $0 → free, under PRO_MIN_PRICE → starter, at or above → pro. Lookup failure → free (least access).
const planTierCache = new Map<string, string>();
async function planTier(planId: string): Promise<string> {
  if (!planId) return "free";
  if (PRO_PLAN_IDS.includes(planId)) return "pro";
  if (planTierCache.has(planId)) return planTierCache.get(planId)!;
  try {
    const r = await fetch(`https://api.whop.com/api/v1/plans/${encodeURIComponent(planId)}`, {
      headers: { Authorization: `Bearer ${WHOP_API_KEY}`, "Api-Version-Date": "2026-08-21-1" },
    });
    if (!r.ok) { console.log("whop plan lookup failed", r.status); return "free"; }
    const p: any = await r.json();
    const price = Number(p.renewal_price ?? p.initial_price ?? p.price ?? 0);
    const tier = price <= 0 ? "free" : price >= PRO_MIN_PRICE ? "pro" : "starter";
    console.log("whop plan tier", JSON.stringify({ planId, price, tier }));
    planTierCache.set(planId, tier);
    return tier;
  } catch {
    return "free";
  }
}

async function authenticate(key: string | null): Promise<Account | null> {
  if (!key || key.length < 6 || key.length > 200) return null;
  const keyHash = sha256(key);
  const rows = await sql`select * from accounts where key_hash = ${keyHash}`;
  let acct = rows[0] as any;
  const isDev = DEV_KEYS.includes(key);
  const stale = !acct || Date.now() - new Date(acct.checked_at).getTime() > WHOP_RECHECK_MS;

  if (isDev) {
    if (!acct) {
      [acct] = await sql`insert into accounts (key_hash, plan, status) values (${keyHash}, 'pro', 'active') returning *`;
    }
    return acct;
  }
  if (stale) {
    const w = await whopLookup(key);
    if (w) {
      if (!acct) {
        if (!w.ok) return null;
        [acct] = await sql`insert into accounts (key_hash, plan, status, whop_membership_id) values (${keyHash}, ${w.plan}, 'active', ${w.membershipId}) returning *`;
      } else {
        [acct] = await sql`update accounts set plan = ${w.plan}, status = ${w.ok ? "active" : "inactive"}, checked_at = now() where key_hash = ${keyHash} returning *`;
      }
    } else if (!acct) {
      return null;
    }
  }
  return acct && acct.status === "active" ? acct : null;
}

function keyFrom(req: Request, url: URL) {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  return url.searchParams.get("key");
}

async function monthlyCount(keyHash: string) {
  const [r] = await sql`select count(*)::int as n from reviews where account_key_hash = ${keyHash} and created_at >= date_trunc('month', now())`;
  return r.n as number;
}

// ---------- core actions ----------
type ReviewInput = {
  title?: string; product_name?: string; content?: string; claims?: string[];
  files?: { name?: string; sha256?: string; mime?: string }[]; seller_name?: string; source?: string;
};

async function createReview(acct: Account, input: ReviewInput) {
  const title = String(input.title || "").trim().slice(0, 140);
  if (!title) return { error: "title is required" };
  let claims = Array.isArray(input.claims) ? input.claims.map((c) => String(c).trim()).filter(Boolean) : [];
  if (!claims.length && input.content) claims = splitClaims(String(input.content));
  claims = claims.map((c) => c.slice(0, 600)).slice(0, 40);
  const files = (Array.isArray(input.files) ? input.files : [])
    .filter((f) => f && /^[a-f0-9]{64}$/i.test(String(f.sha256 || "")))
    .slice(0, 10)
    .map((f) => ({ name: String(f.name || "file").slice(0, 160), sha256: String(f.sha256).toLowerCase(), mime: String(f.mime || "").slice(0, 80) }));
  if (!claims.length) return { error: "nothing to review: send claims, or content with at least one full sentence" };

  const limit = limitFor(acct.plan);
  if (limit !== null) {
    const n = await monthlyCount(acct.key_hash);
    if (n >= limit) return { error: `${PLAN_LABEL[acct.plan] || "Your plan"} includes ${limit} reviews a month and this account has used them. Upgrade for more: ${WHOP_PRODUCT_URL}`, status: 402 };
  }
  if (input.seller_name && !acct.display_name) await setDisplayName(acct, String(input.seller_name));

  const id = randCode(10);
  const token = randToken();
  const source = input.source === "mcp" ? "mcp" : "paste";
  await sql.begin(async (tx) => {
    await tx`insert into reviews (id, account_key_hash, token, title, product_name, source)
      values (${id}, ${acct.key_hash}, ${token}, ${title}, ${input.product_name ? String(input.product_name).slice(0, 140) : null}, ${source})`;
    for (let i = 0; i < claims.length; i++) await tx`insert into claims (review_id, idx, text) values (${id}, ${i}, ${claims[i]})`;
    for (let i = 0; i < files.length; i++) await tx`insert into files (review_id, idx, name, sha256, mime) values (${id}, ${i}, ${files[i].name}, ${files[i].sha256}, ${files[i].mime})`;
  });
  await logEvent("review_created", id, { source, claims: claims.length, files: files.length, kind: files.length ? "file" : "text" });
  return { id, review_url: `${BASE_URL}/r/${id}?t=${token}`, claims: claims.length, files: files.length };
}

async function setDisplayName(acct: Account, name: string) {
  const clean = name.trim().slice(0, 80);
  if (!clean) return acct;
  let slug = slugify(clean);
  const taken = await sql`select key_hash from accounts where slug = ${slug} and key_hash <> ${acct.key_hash}`;
  if (taken.length) slug = `${slug}-${randCode(4).toLowerCase()}`;
  const [a] = await sql`update accounts set display_name = ${clean}, slug = ${slug} where key_hash = ${acct.key_hash} returning *`;
  return a as Account;
}

function buildPayload(r: any, claims: any[], files: any[]) {
  return JSON.stringify({
    v: 1,
    code: r.code,
    title: r.title,
    product: r.product_name || null,
    seller: r.seller_name || null,
    created_at: new Date(r.created_at).toISOString(),
    sealed_at: new Date(r.sealed_at).toISOString(),
    review_seconds: r.review_seconds,
    claims: claims.map((c) => ({ i: c.idx, text: c.text, verdict: c.verdict, fix: c.fix_text || null })),
    files: files.map((f) => ({ name: f.name, sha256: f.sha256 })),
  });
}

async function sealReview(id: string, token: string, verdicts: { idx: number; verdict: string; fix_text?: string }[]) {
  const [r] = await sql`select * from reviews where id = ${id}`;
  if (!r || r.token !== token) return { error: "review not found", status: 404 };
  if (r.code) return { code: r.code, already: true };
  const claims = await sql`select * from claims where review_id = ${id} order by idx`;
  const byIdx = new Map(verdicts.map((v) => [Number(v.idx), v]));
  for (const c of claims) {
    const v = byIdx.get(c.idx);
    if (!v || !["confirm", "fix", "flag"].includes(v.verdict)) return { error: "every claim needs a verdict before sealing", status: 400 };
    if (v.verdict === "fix" && !String(v.fix_text || "").trim()) return { error: "a fixed claim needs the corrected wording", status: 400 };
  }
  const acct = (await sql`select * from accounts where key_hash = ${r.account_key_hash}`)[0];
  const code = randCode(6);
  const result = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(424242)`;
    for (const c of claims) {
      const v = byIdx.get(c.idx)!;
      await tx`update claims set verdict = ${v.verdict}, fix_text = ${v.verdict === "fix" ? String(v.fix_text).trim().slice(0, 600) : null} where review_id = ${id} and idx = ${c.idx}`;
    }
    const prevHash = await chainHead(tx);
    const [upd] = await tx`update reviews set
        code = ${code}, sealed_at = clock_timestamp(),
        review_seconds = greatest(1, extract(epoch from (now() - coalesce(opened_at, created_at)))::int),
        seller_name = ${acct?.display_name || null}, seller_slug = ${acct?.slug || null}, prev_hash = ${prevHash}
      where id = ${id} returning *`;
    const fresh = await tx`select * from claims where review_id = ${id} order by idx`;
    const fileRows = await tx`select * from files where review_id = ${id} order by idx`;
    const payload = buildPayload(upd, fresh, fileRows);
    const sealHash = sha256(prevHash + payload);
    await tx`update reviews set seal_hash = ${sealHash}, sealed_payload = ${payload} where id = ${id}`;
    return { code, fresh, secs: upd.review_seconds };
  });
  const fixes = result.fresh.filter((c: any) => c.verdict === "fix").length;
  const flags = result.fresh.filter((c: any) => c.verdict === "flag").length;
  await logEvent("review_sealed", id, { seconds: result.secs, claims: result.fresh.length, fixes, flags, stamp: fixes + flags === 0 && result.secs < 60 });
  return { code: result.code };
}

async function loadRecord(code: string) {
  const [r] = await sql`select * from reviews where code = ${code}`;
  if (!r) return null;
  const claims = await sql`select * from claims where review_id = ${r.id} order by idx`;
  const files = await sql`select * from files where review_id = ${r.id} order by idx`;
  const acct = (await sql`select plan from accounts where key_hash = ${r.account_key_hash}`)[0];
  const recomputed = r.sealed_payload ? sha256((r.prev_hash || "") + buildPayload(r, claims, files)) : null;
  const intact = !!recomputed && recomputed === r.seal_hash && buildPayload(r, claims, files) === r.sealed_payload;
  return { r, claims, files, intact, plan: acct?.plan || "starter" };
}

function summarize(claims: any[]) {
  return {
    confirmed: claims.filter((c) => c.verdict === "confirm").length,
    fixed: claims.filter((c) => c.verdict === "fix").length,
    removed: claims.filter((c) => c.verdict === "flag").length,
  };
}

// ---------- MCP (streamable HTTP, JSON responses) ----------
const MCP_TOOLS = [
  {
    name: "request_review",
    description:
      "Send work to the Vouch account owner for human review. Returns a review link; nothing is sealed until they tap a verdict (confirm / fix / flag) on every claim. Write `claims` yourself: short, checkable statements about the work. For non-text work (images, code, spreadsheets, video) describe what a human should verify, e.g. 'No garbled text in the graphic', 'Totals tie to the source file', and pass each file's sha256 in `files` so the sealed record fingerprints it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What is being reviewed, e.g. 'Sales page copy'" },
        claims: { type: "array", items: { type: "string" }, description: "Checkable statements, one per item (max 40)" },
        content: { type: "string", description: "Raw text to split into claims, used only if `claims` is empty" },
        product_name: { type: "string", description: "Product or deliverable this is for (shown on the public record)" },
        seller_name: { type: "string", description: "Seller or business name, saved on first use" },
        files: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" }, sha256: { type: "string" }, mime: { type: "string" } }, required: ["name", "sha256"] },
          description: "Files the claims are about, fingerprinted by sha256 (hex)",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "get_record",
    description: "Look up a sealed record by its code: verdict summary, review time, and public evidence link.",
    inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  },
];

async function handleMcp(req: Request, url: URL) {
  if (req.method === "GET") return new Response("Use POST for MCP", { status: 405, headers: { allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  let msg: any;
  try { msg = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400); }
  const batch = Array.isArray(msg) ? msg : [msg];
  const acct = await authenticate(keyFrom(req, url));
  const out: any[] = [];
  for (const m of batch) {
    if (m.id === undefined || m.id === null) continue; // notification
    const reply = (result: any) => out.push({ jsonrpc: "2.0", id: m.id, result });
    const fail = (code: number, message: string) => out.push({ jsonrpc: "2.0", id: m.id, error: { code, message } });
    if (m.method === "initialize") {
      reply({
        protocolVersion: m.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "vouch", version: VERSION },
        instructions:
          "Vouch seals human-reviewed claims. When you finish a deliverable the user will sell or send to a client, offer to call request_review with short checkable claims about it. Vouch proves a named human checked specific claims; never describe it as proof the work is better.",
      });
    } else if (m.method === "ping") reply({});
    else if (m.method === "tools/list") reply({ tools: MCP_TOOLS });
    else if (m.method === "tools/call") {
      if (!acct) { reply({ isError: true, content: [{ type: "text", text: `This connector's key is missing or inactive. Get a key at ${WHOP_PRODUCT_URL}, then add ?key=YOUR_KEY to the connector URL.` }] }); continue; }
      const name = m.params?.name;
      const args = m.params?.arguments || {};
      if (name === "request_review") {
        const r: any = await createReview(acct, { ...args, source: "mcp" });
        if (r.error) reply({ isError: true, content: [{ type: "text", text: r.error }] });
        else reply({ content: [{ type: "text", text: `Review ready (${r.claims} claims${r.files ? `, ${r.files} file fingerprints` : ""}). Open it to tap a verdict on each claim, then seal:\n${r.review_url}` }] });
      } else if (name === "get_record") {
        const rec = await loadRecord(String(args.code || "").toUpperCase());
        if (!rec) reply({ isError: true, content: [{ type: "text", text: "No sealed record with that code." }] });
        else {
          const s = summarize(rec.claims);
          reply({ content: [{ type: "text", text: `${rec.r.title}: sealed ${fmtDate(rec.r.sealed_at)}, reviewed in ${fmtDuration(rec.r.review_seconds)}. ${s.confirmed} confirmed, ${s.fixed} fixed, ${s.removed} removed. ${rec.intact ? "Fingerprint intact." : "FINGERPRINT MISMATCH."}\n${BASE_URL}/v/${rec.r.code}` }] });
        }
      } else fail(-32601, `unknown tool ${name}`);
    } else fail(-32601, `method not found: ${m.method}`);
  }
  if (!out.length) return new Response(null, { status: 202 });
  return json(Array.isArray(msg) ? out : out[0]);
}

// ---------- pages ----------
const LOGO = (size = 26, color = "#C8F545") =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2l8 4.6v9.2L12 22l-8-4.6V6.6L12 2z" stroke="${color}" stroke-width="1.6"/><path d="M8.5 12.2l2.3 2.3 4.7-4.8" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function page(title: string, body: string, opts: { desc?: string; script?: string } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${opts.desc ? `<meta name="description" content="${esc(opts.desc)}">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600;700&display=swap">
<style>
:root{--bg:#0C0F13;--panel:#151A21;--panel2:#10141A;--line:#232B35;--ink:#F4F7F2;--ink2:#9AA7B0;--ink3:#8C97A0;--volt:#C8F545;--red:#E24B4A;--redbg:#2A1416;--redink:#F09595}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,system-ui,sans-serif;line-height:1.5}
a{color:var(--volt)}h1,h2,h3{font-family:'Space Grotesk',sans-serif;font-weight:700;line-height:1.15;margin:0}
.wrap{max-width:640px;margin:0 auto;padding:22px 18px 60px}.wide{max-width:960px}
.top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:22px}
.brand{display:flex;align-items:center;gap:8px;text-decoration:none;color:var(--ink);font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}
.muted{color:var(--ink2)}.small{font-size:13px}.tiny{font-size:12px;color:var(--ink3)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:10px;font:600 14px Inter,sans-serif;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink2);text-decoration:none}
.btn.primary{background:var(--volt);color:#0C0F13;border:none}.btn.full{width:100%;min-height:52px;font-size:15px;font-weight:700}
.btn:disabled{opacity:.45;cursor:not-allowed}
input,textarea{width:100%;background:var(--panel2);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:12px;font:15px Inter,sans-serif}
textarea{min-height:180px;resize:vertical}label{display:block;font-size:13px;color:var(--ink2);margin:14px 0 6px}
.pill{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:5px 10px}
.stack{display:flex;flex-direction:column;gap:10px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.hash{font-family:'Space Grotesk',monospace;font-size:12px;color:var(--ink2);word-break:break-all}
.err{color:var(--redink);font-size:13px;margin-top:8px}
</style></head><body>${body}${opts.script ? `<script>${opts.script}</script>` : ""}</body></html>`;
}

const topbar = (right = "") =>
  `<div class="top"><a class="brand" href="/">${LOGO()}<span>vouch</span></a>${right}</div>`;

function landingPage() {
  return page("Vouch — stand behind what you're selling", `<div class="wrap wide">
${topbar(`<div class="row"><a class="btn" href="/registry">Look up a seller</a><a class="btn primary" href="${esc(WHOP_PRODUCT_URL)}">Join on Whop</a></div>`)}
<div style="padding:40px 0 24px;max-width:680px">
<h1 style="font-size:44px">Stand behind what you're selling</h1>
<p class="muted" style="font-size:18px;margin:16px 0 22px">One command sends your AI's work to you for review. Tap to confirm, fix, or flag each claim. Get a sealed, timestamped record — hosted by us, checkable by anyone. Already launched? Verify the claims on your live sales page today.</p>
<div class="row"><a class="btn primary" href="${esc(WHOP_FREE_URL)}">Start free</a><a class="btn" href="${esc(WHOP_PRODUCT_URL)}">See paid plans</a><a class="btn" href="/app">I have a key</a></div>
<p class="tiny" style="margin:10px 0 0">Free: 3 records a month · Starter $9/mo: 20 · Pro $29/mo: unlimited + badge. 7-day trial on paid plans.</p>
</div>
<div class="card" style="max-width:680px"><h3 style="font-size:16px;margin-bottom:6px">What a sealed record proves</h3>
<p class="small muted" style="margin:0">That a named person checked these specific claims, when, and how long they spent. It does not rate the product. Records with fixes show real scrutiny happened, and every record's fingerprint changes if anything in it is altered.</p></div>
</div>`, { desc: "Human-reviewed, sealed records of the claims you sell with." });
}

// Same key prompt on /app and /link.
const KEYBOX = `<div id="keybox" class="card" style="display:none"><h2 style="font-size:20px">Enter your key</h2>
<p class="small muted">Your Vouch key is the license key from your Whop purchase. Find it in Whop under your orders (whop.com/@me/settings/orders) → Vouch.</p>
<input id="key" placeholder="Your license key" autocomplete="off"><div class="row" style="margin-top:10px"><button class="btn primary" id="savekey">Continue</button></div><div id="keyerr" class="err"></div></div>`;
const KEY_INACTIVE = "That key is not active. Check it in Whop.";

function appPage() {
  return page("Vouch — new review", `<div class="wrap">
${topbar(`<a class="btn" href="/registry">Registry</a>`)}
${KEYBOX}
<div id="main" style="display:none">
<div class="row" style="justify-content:space-between"><h1 style="font-size:24px">New review</h1><span id="plan" class="pill" style="border:1px solid var(--line);color:var(--ink2)"></span></div>
<div id="namebox" class="card" style="margin-top:14px;display:none"><label style="margin-top:0">Your name or business (shown on your records)</label><div class="row"><input id="dname" style="flex:1"><button class="btn primary" id="savename">Save</button></div></div>
<label>What are you reviewing?</label><input id="title" placeholder="e.g. Sales page copy">
<label>Product or deliverable (optional)</label><input id="product" placeholder="e.g. Faceless Reels Starter Kit">
<label>Paste the work, or one claim per line</label><textarea id="content" placeholder="Paste AI output here. Each sentence becomes a claim you tap through."></textarea>
<label>Files the claims are about (optional — fingerprinted on your device, never uploaded)</label><input type="file" id="files" multiple>
<div class="tiny" id="filelist" style="margin-top:6px"></div>
<div style="margin-top:18px"><button class="btn primary full" id="go">Create review</button></div><div id="err" class="err"></div>
<div class="card" style="margin-top:22px"><h3 style="font-size:15px;margin-bottom:6px">Use it from your AI instead</h3>
<p class="small muted" style="margin:0 0 8px">Add this as a custom connector in Claude or ChatGPT. Then say "send this to Vouch for review."</p><div class="hash" id="mcpurl"></div>
<div class="row" style="margin-top:8px"><button class="btn" id="copymcp">Copy connector URL</button></div></div>
<p class="tiny" style="margin-top:18px"><a href="#" id="forget">Use a different key</a></p>
</div></div>`, {
    script: `
const $=id=>document.getElementById(id);let KEY=null;try{KEY=localStorage.getItem('vouch_key')}catch(e){}
let hashed=[];
async function me(){const r=await fetch('/api/me',{headers:{authorization:'Bearer '+KEY}});if(!r.ok)return null;return r.json()}
async function boot(){if(!KEY){$('keybox').style.display='block';return}const m=await me();if(!m){$('keybox').style.display='block';$('keyerr').textContent='That key is not active. Check it in Whop.';return}
$('main').style.display='block';$('plan').textContent=m.plan==='pro'?'Pro · unlimited':(m.plan==='starter'?'Starter':'Free')+' · '+m.used_this_month+' of '+m.limit+' this month';
if(!m.display_name)$('namebox').style.display='block';$('mcpurl').textContent=location.origin+'/mcp?key='+KEY}
$('savekey').onclick=async()=>{KEY=$('key').value.trim();try{localStorage.setItem('vouch_key',KEY)}catch(e){}$('keyerr').textContent='';$('keybox').style.display='none';boot()};
$('forget').onclick=e=>{e.preventDefault();try{localStorage.removeItem('vouch_key')}catch(e){}location.reload()};
$('copymcp').onclick=()=>navigator.clipboard&&navigator.clipboard.writeText($('mcpurl').textContent);
$('savename').onclick=async()=>{const r=await fetch('/api/me',{method:'POST',headers:{authorization:'Bearer '+KEY,'content-type':'application/json'},body:JSON.stringify({display_name:$('dname').value})});if(r.ok)$('namebox').style.display='none'};
$('files').onchange=async e=>{hashed=[];for(const f of e.target.files){const buf=await f.arrayBuffer();const h=await crypto.subtle.digest('SHA-256',buf);hashed.push({name:f.name,mime:f.type,sha256:[...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join('')})}
$('filelist').textContent=hashed.map(f=>f.name+' · '+f.sha256.slice(0,12)+'…').join('  |  ')};
$('go').onclick=async()=>{$('err').textContent='';$('go').disabled=true;
const r=await fetch('/api/reviews',{method:'POST',headers:{authorization:'Bearer '+KEY,'content-type':'application/json'},body:JSON.stringify({title:$('title').value,product_name:$('product').value,content:$('content').value,files:hashed,source:'paste'})});
const d=await r.json();$('go').disabled=false;if(!r.ok){$('err').textContent=d.error||'Something went wrong';return}location.href=d.review_url};
boot();`,
  });
}

function reviewPage(r: any, claims: any[], files: any[]) {
  const items = claims.map((c) => `<div class="card claim" data-idx="${c.idx}">
<p style="margin:0 0 10px;font-size:15px">${esc(c.text)}</p>
<div class="row" style="flex-wrap:nowrap"><button class="btn v" data-v="confirm" style="flex:1">Confirm</button><button class="btn v" data-v="fix" style="flex:1">Fix</button><button class="btn v" data-v="flag" style="flex:1">Flag</button></div>
<div class="fixbox" style="display:none;margin-top:10px"><input class="fix" placeholder="Corrected wording"></div></div>`).join("");
  const fileList = files.length
    ? `<div class="card"><h3 style="font-size:14px;margin-bottom:6px">Files these claims are about</h3>${files.map((f) => `<div class="small">${esc(f.name)} <span class="hash">· ${esc(f.sha256.slice(0, 16))}…</span></div>`).join("")}<p class="tiny" style="margin:6px 0 0">Only fingerprints are stored. Have the file open while you review.</p></div>`
    : "";
  return page(`Review: ${r.title}`, `<div class="wrap">
${topbar(`<span class="pill" style="border:1px solid var(--line);color:var(--ink2)">${r.source === "mcp" ? "Sent by your AI" : "Pasted"}</span>`)}
<h1 style="font-size:24px">${esc(r.title)}</h1>
<p class="small muted" style="margin:6px 0 4px">${claims.length} claims to check${r.product_name ? ` · ${esc(r.product_name)}` : ""}</p>
<p class="tiny" style="margin:0 0 16px"><b>Confirm</b> = true as written · <b>Fix</b> = true once corrected · <b>Flag</b> = false or can't verify, removed from what you stand behind. Your review time and fix count show on the public record.</p>
<div class="stack">${fileList}${items}</div>
<div style="position:sticky;bottom:0;background:var(--bg);padding:14px 0 6px;margin-top:14px">
<div class="row" style="flex-wrap:nowrap;margin-bottom:10px"><span class="tiny" id="prog" style="white-space:nowrap">0 of ${claims.length} reviewed</span><div style="flex:1;height:6px;border-radius:99px;background:var(--line)"><div id="bar" style="width:0;height:6px;border-radius:99px;background:var(--volt)"></div></div></div>
<button class="btn primary full" id="seal" disabled>Seal evidence record</button><div id="err" class="err"></div>
<p class="tiny" style="text-align:center;margin:8px 0 0">Sealing locks your verdicts and creates the public link</p></div></div>`, {
    script: `
const N=${claims.length},ID=${JSON.stringify(r.id)},T=new URLSearchParams(location.search).get('t');const V={};
const styles={confirm:['var(--volt)','#0C0F13','none'],fix:['#F4F7F2','#0C0F13','none'],flag:['var(--redbg)','var(--redink)','1px solid var(--red)']};
function paint(card){const idx=card.dataset.idx,v=V[idx]&&V[idx].verdict;card.querySelectorAll('.v').forEach(b=>{const on=b.dataset.v===v;const s=styles[b.dataset.v];b.style.background=on?s[0]:'transparent';b.style.color=on?s[1]:'var(--ink2)';b.style.border=on?s[2]:'1px solid var(--line)'});card.querySelector('.fixbox').style.display=v==='fix'?'block':'none'}
function update(){const done=Object.values(V).filter(x=>x.verdict&&(x.verdict!=='fix'||(x.fix_text||'').trim())).length;document.getElementById('prog').textContent=done+' of '+N+' reviewed';document.getElementById('bar').style.width=(100*done/N)+'%';document.getElementById('seal').disabled=done<N}
document.querySelectorAll('.claim').forEach(card=>{const idx=card.dataset.idx;card.querySelectorAll('.v').forEach(b=>b.onclick=()=>{V[idx]=Object.assign(V[idx]||{idx:+idx},{verdict:b.dataset.v});paint(card);update();if(b.dataset.v==='fix')card.querySelector('.fix').focus()});card.querySelector('.fix').oninput=e=>{V[idx]=Object.assign(V[idx]||{idx:+idx},{fix_text:e.target.value});update()}});
document.getElementById('seal').onclick=async()=>{const btn=document.getElementById('seal');btn.disabled=true;const r=await fetch('/api/reviews/'+ID+'/seal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:T,verdicts:Object.values(V)})});const d=await r.json();if(!r.ok){document.getElementById('err').textContent=d.error||'Could not seal';btn.disabled=false;return}location.href='/v/'+d.code+'?new=1&t='+encodeURIComponent(T)};`,
  });
}

function evidencePage(rec: any, opts: { isNew: boolean; token: string | null }) {
  const { r, claims, files, intact, plan } = rec;
  const s = summarize(claims);
  const dot = (v: string) => (v === "confirm" ? "var(--volt)" : v === "fix" ? "#F4F7F2" : "var(--red)");
  const lines = claims.map((c: any) =>
    c.verdict === "flag"
      ? `<div class="row" style="flex-wrap:nowrap;align-items:flex-start"><span style="flex:0 0 8px;height:8px;border-radius:99px;background:${dot(c.verdict)};margin-top:7px"></span><span class="small" style="color:var(--ink3);text-decoration:line-through">${esc(c.text)}</span></div>`
      : `<div class="row" style="flex-wrap:nowrap;align-items:flex-start"><span style="flex:0 0 8px;height:8px;border-radius:99px;background:${dot(c.verdict)};margin-top:7px"></span><span class="small">${esc(c.verdict === "fix" ? c.fix_text : c.text)}${c.verdict === "fix" ? ` <span class="tiny">(corrected)</span>` : ""}</span></div>`
  ).join("");
  const link = `${BASE_URL}/v/${r.code}`;
  const badge = plan === "pro"
    ? `<div class="card"><h3 style="font-size:14px;margin-bottom:6px">Embed your badge</h3><img src="/badge/${r.code}.svg" alt="Reviewed with Vouch" style="max-width:100%;height:auto"><div class="hash" style="margin-top:8px">&lt;a href="${esc(link)}"&gt;&lt;img src="${esc(BASE_URL)}/badge/${r.code}.svg" alt="Reviewed with Vouch"&gt;&lt;/a&gt;</div></div>`
    : "";
  const fresh = opts.isNew && opts.token
    ? `<div class="card row" style="justify-content:space-between"><div><div class="small" style="font-weight:600">Share Vouch, earn 40%</div><div class="tiny">Recurring, paid through Whop's affiliate program</div></div><a class="btn" style="border-color:var(--volt);color:var(--volt)" href="${esc(WHOP_PRODUCT_URL)}">Get my link</a></div>
<div id="purpose"><p class="tiny" style="margin:4px 0 8px">One quick one: what was this review for?</p><div class="row">${["Sales page", "Client work", "My product", "Other"].map((p) => `<button class="btn pp" style="border-radius:999px">${p}</button>`).join("")}</div></div>${badge}`
    : "";
  return page(`${r.title} — sealed record`, `<div class="wrap">
${topbar(`<a class="btn" href="/registry">Registry</a>`)}
<div style="text-align:center;margin-bottom:16px">${LOGO(44)}<h1 style="font-size:22px;margin-top:8px">Evidence sealed</h1>
<p class="tiny" style="margin:4px 0 0">${esc(fmtDate(r.sealed_at))} · Record #${esc(r.code)}</p>
<p class="tiny" style="margin:2px 0 0">Reviewed in ${esc(fmtDuration(r.review_seconds))} · ${s.fixed} fix${s.fixed === 1 ? "" : "es"} · ${s.removed} claim${s.removed === 1 ? "" : "s"} removed</p></div>
<div class="stack">
<div class="card"><div style="font-size:16px;font-weight:600">${esc(r.title)}</div>
<div class="tiny" style="margin:2px 0 8px">${r.seller_name ? `Reviewed by <a href="/s/${esc(r.seller_slug)}">${esc(r.seller_name)}</a>` : "Reviewed by the account owner"}${r.product_name ? ` · ${esc(r.product_name)}` : ""} · ${claims.length} claims</div>
<div class="row"><span class="pill" style="background:var(--volt);color:#0C0F13">${s.confirmed} confirmed</span><span class="pill" style="background:#F4F7F2;color:#0C0F13">${s.fixed} fixed</span><span class="pill" style="background:var(--redbg);color:var(--redink);border:1px solid var(--red)">${s.removed} removed</span></div></div>
<div class="card stack" style="gap:9px">${lines}</div>
${files.length ? `<div class="card"><h3 style="font-size:14px;margin-bottom:6px">Fingerprinted files</h3>${files.map((f: any) => `<div class="small">${esc(f.name)}<div class="hash">sha-256 ${esc(f.sha256)}</div></div>`).join("")}<p class="tiny" style="margin:6px 0 0">Hash any copy of the file: a match proves it's the version that was reviewed.</p></div>` : ""}
<div class="card" style="background:var(--panel2);border-style:dashed"><div class="row" style="justify-content:space-between"><span class="hash">sha-256 · ${esc(r.seal_hash.slice(0, 8))}…${esc(r.seal_hash.slice(-6))}</span><span class="small" style="font-weight:600;color:${intact ? "var(--volt)" : "var(--redink)"}">${intact ? "Fingerprint intact" : "Fingerprint mismatch"}</span></div>
<p class="tiny" style="margin:6px 0 0">Each record's fingerprint includes the one sealed before it, so altering any record breaks the chain. <a href="/verify/${esc(r.code)}">Raw proof</a></p></div>
<div class="row" style="flex-wrap:nowrap"><span class="card small" style="flex:1;padding:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(link.replace(/^https?:\/\//, ""))}</span><button class="btn primary" id="copy">Copy link</button></div>
${fresh}
<p class="tiny" style="text-align:center;margin-top:8px">Hosted and timestamped by Vouch, independent of the author. A sealed record shows who checked which claims — it is not a rating of the product.</p>
</div></div>`, {
    desc: `${r.title}: ${claims.length} claims human-reviewed and sealed ${fmtDate(r.sealed_at)}.`,
    script: `document.getElementById('copy').onclick=()=>navigator.clipboard&&navigator.clipboard.writeText(${JSON.stringify(link)});
document.querySelectorAll('.pp').forEach(b=>b.onclick=async()=>{await fetch('/api/records/${r.code}/purpose',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:${JSON.stringify(opts.token || "")},purpose:b.textContent})});document.getElementById('purpose').innerHTML='<p class="tiny">Thanks — noted.</p>'});`,
  });
}

function badgeSvg(rec: any) {
  const d = new Date(rec.r.sealed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="110" viewBox="0 0 300 110" role="img" aria-label="Reviewed with Vouch, sealed ${esc(d)}">
<rect x="0.5" y="0.5" width="299" height="109" rx="12" fill="#0C0F13" stroke="#232B35"/>
<g transform="translate(18 27) scale(2.3)" fill="none"><path d="M12 2l8 4.6v9.2L12 22l-8-4.6V6.6L12 2z" stroke="#C8F545" stroke-width="1.3"/><path d="M8.5 12.2l2.3 2.3 4.7-4.8" stroke="#C8F545" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></g>
<text x="88" y="45" font-family="Space Grotesk,Inter,sans-serif" font-weight="700" font-size="19" fill="#F4F7F2">Reviewed with Vouch</text>
<text x="88" y="66" font-family="Inter,sans-serif" font-size="11.5" fill="#9AA7B0">Human-reviewed · sealed ${esc(d)}</text>
<text x="88" y="84" font-family="Space Grotesk,monospace" font-size="11" fill="#C8F545">Record #${esc(rec.r.code)}</text></svg>`;
}

async function registryPage(q: string) {
  const term = q.trim();
  const rows = term
    ? await sql`select seller_name, seller_slug, count(*)::int as records,
          sum(case when exists (select 1 from claims c where c.review_id = r.id and c.verdict <> 'confirm') then 1 else 0 end)::int as with_fixes,
          max(sealed_at) as last_sealed
        from reviews r where code is not null and seller_slug is not null
          and (seller_name ilike ${"%" + term + "%"} or product_name ilike ${"%" + term + "%"} or title ilike ${"%" + term + "%"})
        group by seller_name, seller_slug order by max(sealed_at) desc limit 30`
    : await sql`select seller_name, seller_slug, count(*)::int as records,
          sum(case when exists (select 1 from claims c where c.review_id = r.id and c.verdict <> 'confirm') then 1 else 0 end)::int as with_fixes,
          max(sealed_at) as last_sealed
        from reviews r where code is not null and seller_slug is not null
        group by seller_name, seller_slug order by max(sealed_at) desc limit 30`;
  const list = rows.length
    ? rows.map((s: any) => `<a class="card" href="/s/${esc(s.seller_slug)}" style="display:block;text-decoration:none;color:inherit"><div style="font-weight:600">${esc(s.seller_name)}</div>
<div class="tiny">${s.records} sealed record${s.records === 1 ? "" : "s"} · ${s.with_fixes} with fixes or removals · last sealed ${esc(fmtDate(s.last_sealed))}</div></a>`).join("")
    : `<p class="small muted">${term ? "No sealed records match that search." : "No public records yet."}</p>`;
  return page("Vouch registry — look up a seller", `<div class="wrap">
${topbar(`<a class="btn primary" href="${esc(WHOP_PRODUCT_URL)}">Join on Whop</a>`)}
<h1 style="font-size:26px">Look up a seller</h1>
<p class="small muted" style="margin:6px 0 14px">Search by seller, product, or record title. The registry shows facts — records, fixes, dates — never a score.</p>
<form method="get" action="/registry" class="row" style="flex-wrap:nowrap;margin-bottom:16px"><input name="q" value="${esc(term)}" placeholder="Seller or product name" style="flex:1"><button class="btn primary" type="submit">Search</button></form>
<div class="stack">${list}</div></div>`, { desc: "Look up any seller's sealed, human-reviewed records on Vouch." });
}

async function sellerPage(slug: string) {
  const recs = await sql`select r.code, r.title, r.product_name, r.sealed_at, r.review_seconds, r.seller_name,
      (select count(*) from claims c where c.review_id = r.id)::int as n,
      (select count(*) from claims c where c.review_id = r.id and c.verdict = 'fix')::int as fixes,
      (select count(*) from claims c where c.review_id = r.id and c.verdict = 'flag')::int as removed
    from reviews r where r.seller_slug = ${slug} and r.code is not null order by r.sealed_at desc limit 100`;
  if (!recs.length) return null;
  const name = recs[0].seller_name;
  const total = recs.length;
  const withChanges = recs.filter((x: any) => x.fixes + x.removed > 0).length;
  return page(`${name} — sealed records on Vouch`, `<div class="wrap">
${topbar(`<a class="btn" href="/registry">Registry</a>`)}
<h1 style="font-size:26px">${esc(name)}</h1>
<p class="small muted" style="margin:6px 0 14px">${total} sealed record${total === 1 ? "" : "s"} · ${withChanges} with fixes or removals · first sealed ${esc(fmtDate(recs[recs.length - 1].sealed_at))}</p>
<div class="stack">${recs.map((x: any) => `<a class="card" href="/v/${esc(x.code)}" style="display:block;text-decoration:none;color:inherit"><div style="font-weight:600">${esc(x.title)}</div>
<div class="tiny">${x.product_name ? esc(x.product_name) + " · " : ""}${x.n} claims · ${x.fixes} fixed · ${x.removed} removed · reviewed in ${esc(fmtDuration(x.review_seconds))} · ${esc(fmtDate(x.sealed_at))}</div></a>`).join("")}</div>
<p class="tiny" style="margin-top:16px">Records show who checked which claims and when. They are not a rating of the products.</p></div>`, { desc: `${name}'s human-reviewed, sealed records on Vouch.` });
}

async function adminStats() {
  const [totals] = await sql`select count(*)::int as created, count(code)::int as sealed,
      count(*) filter (where source = 'mcp')::int as via_mcp,
      round(avg(review_seconds))::int as avg_seconds,
      percentile_cont(0.5) within group (order by review_seconds)::int as median_seconds
    from reviews`;
  const verdicts = await sql`select verdict, count(*)::int as n from claims where verdict is not null group by verdict`;
  const purposes = await sql`select purpose, count(*)::int as n from reviews where purpose is not null group by purpose order by n desc`;
  const referrers = await sql`select coalesce(referrer_host, 'direct') as host, count(*)::int as views from views group by 1 order by 2 desc limit 25`;
  const stamps = await sql`select count(*)::int as n from events where name = 'review_sealed' and meta::jsonb->>'stamp' = 'true'`;
  const plans = await sql`select plan, count(*)::int as n from accounts where status = 'active' group by plan`;
  const kinds = await sql`select meta::jsonb->>'kind' as kind, count(*)::int as n from events where name = 'review_created' group by 1`;
  const perAccount = await sql`select date_trunc('month', created_at) as month, account_key_hash, count(*)::int as n from reviews group by 1, 2`;
  const dist: Record<string, number> = { "1-5": 0, "6-10": 0, "11-20": 0, "21+": 0 };
  for (const p of perAccount as any[]) dist[p.n <= 5 ? "1-5" : p.n <= 10 ? "6-10" : p.n <= 20 ? "11-20" : "21+"]++;
  return { totals, verdicts, kinds, purposes, referrers, rubber_stamp_seals: stamps[0].n, plans, reviews_per_account_month: dist };
}

// ---------- v2: one hash chain across review seals and listing versions ----------
// Callers must hold pg_advisory_xact_lock(424242) inside `tx`.
async function chainHead(tx: any): Promise<string> {
  const [h] = await tx`select seal_hash from (
      select seal_hash, sealed_at from reviews where seal_hash is not null
      union all
      select seal_hash, sealed_at from listing_versions where seal_hash is not null
    ) s order by sealed_at desc limit 1`;
  return h?.seal_hash || "genesis";
}

// ---------- v2: link capture ----------
type DefaultPlan = { id: string | null; renewalPrice: number | null; initialPrice: number | null; trialDays: number | null; planType: string | null; billingDays?: number | null; period?: string | null; currency?: string | null };
type Capture = { url: string; title: string | null; text: string; defaultPlan: DefaultPlan; plansCount: number | null; listingHash: string; capturedAt: Date };

function normalizeWhopUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;
  if (!["whop.com", "www.whop.com"].includes(u.hostname.toLowerCase())) return null;
  const path = u.pathname.replace(/\/+$/, "");
  if (!path || path === "" || /^\/(dashboard|checkout|login|signup|api|@me)\b/i.test(path)) return null;
  return `https://whop.com${path}/`;
}

function decodeEntities(s: string) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

// "$600", "$9.50", "€20", "1,200 CAD".
function fmtMoney(n: number, currency: string | null) {
  const amt = n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
  const sym: Record<string, string> = { usd: "$", eur: "€", gbp: "£" };
  const c = (currency || "usd").toLowerCase();
  return sym[c] ? `${sym[c]}${amt}` : `${amt} ${c.toUpperCase()}`;
}
const PERIOD_BY_DAYS: Record<number, string> = { 1: "day", 7: "week", 14: "2 weeks", 30: "month", 31: "month", 60: "2 months", 90: "3 months", 180: "6 months", 365: "year" };

// Structured first line from the default plan, e.g. "Price: $600 one-time" or "Price: $9 / month, 7-day trial".
function priceLine(dp: DefaultPlan): string | null {
  if (dp.initialPrice == null && dp.renewalPrice == null) return null;
  const initial = dp.initialPrice ?? 0, renewal = dp.renewalPrice ?? 0;
  const trial = dp.trialDays && dp.trialDays > 0 ? `, ${dp.trialDays}-day trial` : "";
  if (dp.planType === "renewal" || (dp.planType !== "one_time" && renewal > 0)) {
    if (renewal <= 0 && initial <= 0) return `Price: Free${trial}`;
    const per = dp.billingDays && PERIOD_BY_DAYS[dp.billingDays] ? `/ ${PERIOD_BY_DAYS[dp.billingDays]}`
      : dp.billingDays ? `/ ${dp.billingDays} days`
      : dp.period && dp.period.trim().startsWith("/") ? dp.period.trim().replace(/\s+/g, " ")
      : "recurring";
    const base = `${fmtMoney(renewal, dp.currency ?? null)} ${per}`;
    return initial > 0 && initial !== renewal ? `Price: ${fmtMoney(initial, dp.currency ?? null)} first payment, then ${base}${trial}` : `Price: ${base}${trial}`;
  }
  return initial > 0 ? `Price: ${fmtMoney(initial, dp.currency ?? null)} one-time${trial}` : `Price: Free${trial}`;
}
// The generated lines at the top of captured text (not seller-written, so never flagged).
const HEADER_LINE = /^(?:Price: .+|Price options on page: \d+)$/;
// Owner-verified listings also carry every plan from the Whop API, one "Price option: …" line each, after the header.
const PLAN_OPTION_LINE = /^Price option(?: \([^\n]*\))?: .+$/;
function stripHeader(text: string) {
  const lines = text.split("\n");
  let i = 0;
  while (i < 2 && i < lines.length && HEADER_LINE.test(lines[i])) i++;
  while (i < lines.length && PLAN_OPTION_LINE.test(lines[i])) i++;
  return lines.slice(i).join("\n");
}

// Whop site chrome inside the listing area: buttons, review counts. Not the seller's words, and it would make the hash unstable.
const CHROME_LINE = /^(?:buy now|add to cart|start free trial|start trial|join(?: now| for free)?|get access|claim(?: free)? access|\+\s?\d+ options?|no reviews(?: yet)?|\d(?:\.\d+)?\s*\(\s*[\d,.]+\s*k?\s*(?:reviews?|ratings?)?\s*\)|\(?\s*[\d,.]+\s*k?\s+(?:reviews?|ratings?)\s*\)?)$/i;
const initialsOf = (s: string) => s.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").toUpperCase();

// Pure parser so it can be tested without network access.
function parseListing(url: string, page: string): Omit<Capture, "capturedAt"> {
  const titleTag = (page.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const title = titleTag ? decodeEntities(titleTag).replace(/\s*\|\s*Whop\s*$/i, "").trim() || null : null;
  const num = (re: RegExp) => { const m = page.match(re); return m && m[1] !== "null" ? Number(m[1]) : null; };
  // Embedded page data (TanStack serialization, keys may or may not be quoted).
  const dp = page.match(/"?defaultPlan"?\s*:\s*(?:\$R\[\d+\]\s*=\s*)?\{([\s\S]{0,3000}?)\}\s*[,}]/);
  const scope = dp ? dp[1] : page;
  const sNum = (re: RegExp) => { const m = scope.match(re); return m && m[1] !== "null" ? Number(m[1]) : null; };
  const defaultPlan: DefaultPlan = {
    id: (scope.match(/"?id"?\s*:\s*"(plan_[A-Za-z0-9]+)"/) || [])[1] || null,
    renewalPrice: sNum(/"?rawRenewalPrice"?\s*:\s*([\d.]+|null)/),
    initialPrice: sNum(/"?rawInitialPrice"?\s*:\s*([\d.]+|null)/),
    trialDays: sNum(/"?trialPeriodDays"?\s*:\s*(\d+|null)/),
    planType: (scope.match(/"?planType"?\s*:\s*"([a-z_]+)"/) || [])[1] || null,
    billingDays: sNum(/"?billingPeriod"?\s*:\s*(\d+|null)/),
    period: (scope.match(/"?formattedPeriodV2"?\s*:\s*"([^"]{0,40})"/) || [])[1] || null,
    currency: (scope.match(/"?(?:baseCurrency|currency)"?\s*:\s*"([a-z]{3})"/i) || [])[1]?.toLowerCase() || null,
  };
  const plansCount = num(/"?visiblePlansCount"?\s*:\s*(\d+)/);
  // Visible text, keeping block breaks as newlines.
  let body = page.replace(/<head[\s>][\s\S]*?<\/head>/i, " ")
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|section|article|header|footer|ul|ol|tr|button|a)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  body = decodeEntities(body);
  let lines = body.split(/\n/).map((l) => l.replace(/[ \t\xa0]+/g, " ").trim()).filter(Boolean);
  let text = lines.join("\n");
  const ends = [text.search(/Customer reviews/i), text.search(/Powered by Whop/i)].filter((i) => i >= 0);
  if (ends.length) text = text.slice(0, Math.min(...ends));
  // Drop Whop's site chrome at the top (same on every page, not the seller's words).
  text = text.replace(/^(?:(?:For enterprise|API|Sign in|Search|⌘K)\s*\n?)+/i, "").trim();
  lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  // Keep the price and stock lines; drop buttons and review counts; drop Whop's avatar initials ("TW" before "Thomas Woodcock").
  const kept: string[] = [];
  const seenCard = new Set<string>();
  const isCardLine = (l: string) => l === title || /^[$€£]\s?\d[\d,.]*(?:\s.{0,30})?$/.test(l) || /^\d+[- ]day (?:free )?trial$/i.test(l) || /^less than \d+ remaining$/i.test(l);
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (CHROME_LINE.test(l)) continue;
    const ini = kept.length === 0 ? l.match(/^([A-Z0-9]{1,3})(?: (.+))?$/) : null;
    if (ini) {
      const rest = ini[2] ?? lines[i + 1] ?? "";
      if (rest && initialsOf(rest).startsWith(ini[1])) { if (!ini[2]) continue; l = ini[2]; }
    }
    // Whop repeats the purchase card (title, price, trial) in a sticky bar after the description: keep the first copy only.
    if (isCardLine(l)) { if (seenCard.has(l)) continue; seenCard.add(l); }
    kept.push(l);
  }
  const header = [priceLine(defaultPlan), plansCount != null ? `Price options on page: ${plansCount}` : null].filter(Boolean) as string[];
  text = kept.length ? [...header, ...kept].join("\n") : "";
  const listingHash = sha256(text);
  return { url, title, text, defaultPlan, plansCount, listingHash };
}

async function fetchPage(url: string): Promise<string> {
  if (CAPTURE_FIXTURES) {
    const map = await Bun.file(CAPTURE_FIXTURES).json();
    const path = map[url];
    if (!path) throw new Error("fixture missing for " + url);
    return await Bun.file(path).text();
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": CAPTURE_UA, Accept: "text/html" }, redirect: "follow", signal: ctrl.signal });
    if (!r.ok) throw new Error(`Whop returned ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function captureListing(rawUrl: string): Promise<Capture> {
  const url = normalizeWhopUrl(rawUrl);
  if (!url) throw new Error("Use a public whop.com listing link, like https://whop.com/your-store/your-product/");
  const page = await fetchPage(url);
  const parsed = parseListing(url, page);
  if (stripHeader(parsed.text).length < 20) throw new Error("Couldn't find listing text on that page");
  return { ...parsed, capturedAt: new Date() };
}

// ---------- v2: risky-claim flags (rule-based) ----------
type Flag = "income" | "guarantee" | "time" | "absolute" | "scarcity";
const FLAG_SUGGESTIONS: Record<Flag, string> = {
  income: "Income figures need proof of typical results. Show what most buyers actually get, or remove the figure.",
  guarantee: "Hard to keep for every buyer. Say exactly what you refund and when, or remove the promise.",
  time: "Timing depends on the buyer. Say what it depends on, or remove the deadline.",
  absolute: "Absolute words are easy to disprove. Use a more precise word, like \"often\" or \"most\".",
  scarcity: "Urgency has to be true when the buyer reads it. Remove \"spots left\", deadlines or price-rise warnings unless the limit is real and enforced. For stock, use Whop's stock setting, which shows its own count.",
};
const RE = {
  currency: /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?\s?(?:k|K|m|M)?\b|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|usd)\b|\b(?:six|seven|6|7)[- ]figures?\b)/i,
  earn: /\b(?:earn(?:s|ed|ing)?|make|makes|made|making|profit(?:s|able)?|income|revenue|paid out|cash(?:ed)? out|net(?:ted)?)\b/i,
  rate: /(?:\bper\s+(?:day|week|month|year)\b|\/\s?(?:day|wk|week|mo|month|yr|year)\b|\ba\s+(?:day|week|month)\b|\b(?:daily|weekly|monthly)\b)/i,
  you: /\b(?:you|your|students?|members?|clients?)\b/i,
  guarantee: /(?:\bguarantee[d]?\b|\bguarantees\b(?!\s*[,;]|\s+(?:and|or)\b)|\brisk[- ]?free\b|\bmoney[- ]back\b|\b100\s?%|\bno[- ]risk\b|\bcan(?:'|’)?t lose\b|\bcannot lose\b|\bzero risk\b)/i,
  time: /(?:\b(?:in|within|under|just|only)\s+(?:\d+|a|one|two|three|seven|ten|thirty)\s*(?:-\s*)?(?:minutes?|hours?|days?|weeks?|months?)\b|\bovernight\b|\b(?:fast|quick|instant(?:ly)?|rapid)\s+results?\b|\bfirst sale (?:today|this week)\b)/i,
  absolute: /\b(?:always|never|everyone|everybody|anyone|anybody|no one|nobody|zero risk|every single|without fail|100% of)\b/i,
  scarcity: /(?:\bonly\s+(?:\d+|a few|few|one|two|three|four|five|ten)\s+(?:\w+\s+)?(?:left|remaining|available)\b|\b(?:\d+|a few|few)\s+(?:spots?|seats?|slots?|places?|copies|memberships?|licen[cs]es?)\s+(?:are\s+)?(?:left|remaining)\b|\blimited\s+(?:spots?|seats?|slots?|places?|availability|time|offer|supply|quantity|number)\b|\b(?:spots?|seats?)\s+(?:are\s+)?(?:filling|going)\s+fast\b|\b(?:closing|closes|ending|ends)\s+(?:soon|tonight|today|tomorrow|at midnight|this week)\b|\bdoors?\s+(?:are\s+)?clos(?:e|es|ing)\b|\bprices?\s+(?:goes|going|will go|is going|are going)\s+up\b|\bprices?\s+(?:will\s+)?(?:increase|increases|double|rise|rises)\b|\bprice\s+(?:increase|rise|hike)\b|\blast\s+chance\b|\bselling\s+out\b|\balmost\s+(?:gone|sold out|full)\b|\bbefore\s+it(?:'|’)?s\s+gone\b|\bdon(?:'|’)?t\s+miss\s+out\b|\bhurry\b)/i,
};
// Whop's own stock line, generated from the product's stock setting: not seller-written urgency.
const WHOP_STOCK_LINE = /^less than \d+ remaining\.?$/i;

function splitListingClaims(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r/g, "").split(/\n+/)) {
    const line = raw.replace(/^\s*([-*•]|\d+[.)])\s+/, "").trim();
    if (!line) continue;
    const parts = line.match(/[^.!?]+[.!?]+["'”’)\]]*|[^.!?]+$/g) || [line];
    for (const p of parts) { const t = p.trim(); if (t.length >= 8) out.push(t.slice(0, 600)); }
  }
  return out.slice(0, 80);
}

function flagClaims(text: string): { text: string; flags: Flag[]; suggestion: string | null }[] {
  return splitListingClaims(text).map((claim) => {
    // Words inside quotes are being mentioned, not claimed (e.g. words like "always" and "never").
    const unquoted = claim.replace(/["“][^"”]{1,40}["”]/g, " ");
    const flags: Flag[] = [];
    if (RE.currency.test(unquoted) && (RE.earn.test(unquoted) || (RE.rate.test(unquoted) && RE.you.test(unquoted)))) flags.push("income");
    if (RE.guarantee.test(unquoted)) flags.push("guarantee");
    if (RE.time.test(unquoted)) flags.push("time");
    if (RE.absolute.test(unquoted)) flags.push("absolute");
    if (RE.scarcity.test(unquoted) && !WHOP_STOCK_LINE.test(claim.trim())) flags.push("scarcity");
    return { text: claim, flags, suggestion: flags.length ? flags.map((f) => FLAG_SUGGESTIONS[f]).join(" ") : null };
  });
}

// ---------- Connect your Whop ----------
const b64url = (s: string | Uint8Array) => Buffer.from(s).toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Whop's public signing keys, cached. Refetched hourly, or early (at most once a minute) when a token names an unknown kid.
const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache: { at: number; keys: Map<string, CryptoKey> } | null = null;
let jwksLastFetch = 0;
let jwksFetches = 0; // exposed for tests
async function loadJwks(): Promise<Map<string, CryptoKey>> {
  jwksLastFetch = Date.now();
  jwksFetches++;
  const r = await fetch(WHOP_JWKS_URL, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`jwks fetch ${r.status}`);
  const body: any = await r.json();
  const keys = new Map<string, CryptoKey>();
  for (const k of body?.keys || []) {
    if (k.kty !== "EC" || k.crv !== "P-256") continue;
    try {
      const key = await crypto.subtle.importKey("jwk", { kty: k.kty, crv: k.crv, x: k.x, y: k.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      keys.set(String(k.kid ?? ""), key);
    } catch {}
  }
  jwksCache = { at: Date.now(), keys };
  return keys;
}
async function jwksKeysFor(kid: string | undefined): Promise<CryptoKey[]> {
  let keys = jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS ? jwksCache.keys : await loadJwks();
  if (kid && !keys.has(kid) && Date.now() - jwksLastFetch > 60_000) keys = await loadJwks();
  if (kid) return keys.has(kid) ? [keys.get(kid)!] : [];
  return [...keys.values()];
}

// Verifies the x-whop-user-token Whop sends to the dashboard iframe. Returns a one-line reason on failure.
async function verifyWhopToken(token: string, opts: { appId?: string; now?: number } = {}): Promise<{ ok: true; sub: string; payload: any } | { ok: false; reason: string }> {
  const appId = opts.appId ?? WHOP_APP_ID;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, reason: "malformed token" };
  let header: any, payload: any;
  try { header = JSON.parse(fromB64url(parts[0]).toString()); payload = JSON.parse(fromB64url(parts[1]).toString()); }
  catch { return { ok: false, reason: "malformed token (bad json)" }; }
  if (header?.alg !== "ES256") return { ok: false, reason: `bad alg ${String(header?.alg).slice(0, 12)}` };
  let keys: CryptoKey[];
  try { keys = await jwksKeysFor(header.kid); } catch (e: any) { return { ok: false, reason: `jwks unavailable (${e?.message || e})` }; }
  if (!keys.length) return { ok: false, reason: `unknown kid ${String(header.kid).slice(0, 60)}` };
  const sig = fromB64url(parts[2]);
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let valid = false;
  for (const k of keys) {
    try { if (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, sig, data)) { valid = true; break; } } catch {}
  }
  if (!valid) return { ok: false, reason: "bad signature" };
  if (payload.iss !== WHOP_TOKEN_ISS) return { ok: false, reason: `wrong iss ${String(payload.iss).slice(0, 60)}` };
  if (!appId) return { ok: false, reason: "WHOP_APP_ID not set" };
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(appId)) return { ok: false, reason: `wrong aud ${String(payload.aud).slice(0, 60)}` };
  if (typeof payload.exp === "number" && payload.exp + 60 < now) return { ok: false, reason: "expired" };
  if (typeof payload.nbf === "number" && payload.nbf - 60 > now) return { ok: false, reason: "not yet valid" };
  if (!payload.sub || typeof payload.sub !== "string") return { ok: false, reason: "no sub" };
  return { ok: true, sub: payload.sub, payload };
}

// Hand-off from the Whop iframe to a top-level Vouch tab: base64url(payload) "." base64url(HMAC-SHA256).
function signLinkToken(biz: string, user: string, opts: { secret?: string; now?: number } = {}) {
  const secret = opts.secret ?? LINK_SECRET;
  if (!secret) throw new Error("LINK_SECRET not set");
  const p = b64url(JSON.stringify({ biz, user, exp: Math.floor((opts.now ?? Date.now()) / 1000) + LINK_TTL_SECONDS }));
  return `${p}.${new Bun.CryptoHasher("sha256", secret).update(p).digest("base64url")}`;
}
function verifyLinkToken(t: string, opts: { secret?: string; now?: number } = {}): { ok: true; biz: string; user: string } | { ok: false; reason: string } {
  const secret = opts.secret ?? LINK_SECRET;
  if (!secret) return { ok: false, reason: "LINK_SECRET not set" };
  const parts = String(t || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const want = new Bun.CryptoHasher("sha256", secret).update(parts[0]).digest("base64url");
  if (!safeEqual(want, parts[1])) return { ok: false, reason: "bad signature" };
  let p: any;
  try { p = JSON.parse(fromB64url(parts[0]).toString()); } catch { return { ok: false, reason: "malformed" }; }
  if (typeof p?.exp !== "number" || p.exp < Math.floor((opts.now ?? Date.now()) / 1000)) return { ok: false, reason: "expired" };
  if (!/^biz_[A-Za-z0-9]+$/.test(String(p.biz)) || !p.user) return { ok: false, reason: "malformed" };
  return { ok: true, biz: String(p.biz), user: String(p.user) };
}

async function whopApi(path: string): Promise<{ status: number; body: any }> {
  if (!WHOP_APP_API_KEY) return { status: 0, body: { error: "WHOP_APP_API_KEY not set" } };
  try {
    const r = await fetch(`${WHOP_API_BASE}${path}`, { headers: { Authorization: `Bearer ${WHOP_APP_API_KEY}`, "Api-Version-Date": "2026-08-21-1" }, signal: AbortSignal.timeout(20000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e: any) {
    return { status: 0, body: { error: String(e?.message || e) } };
  }
}
async function whopList(path: string): Promise<{ status: number; data: any[] }> {
  const out: any[] = [];
  let after = "";
  for (let page = 0; page < 10; page++) {
    const r = await whopApi(`${path}${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    if (r.status !== 200) return { status: r.status, data: out };
    out.push(...(Array.isArray(r.body?.data) ? r.body.data : []));
    const pi = r.body?.page_info;
    if (!pi?.has_next_page || !pi?.end_cursor) break;
    after = String(pi.end_cursor);
  }
  return { status: 200, data: out };
}

// Admin check for the dashboard. GET /users/{id}/access/{biz} works with our app's permissions (seen 200 {access_level:"admin"}).
// If Whop ever answers 401/403 there, fall back to "the business has the app installed" and log it.
async function whopAdminCheck(userId: string, biz: string): Promise<{ ok: boolean; via: string; detail: string }> {
  const r = await whopApi(`/api/v1/users/${encodeURIComponent(userId)}/access/${encodeURIComponent(biz)}`);
  if (r.status === 200) return { ok: r.body?.access_level === "admin", via: "access", detail: `status=200 access_level=${r.body?.access_level} has_access=${r.body?.has_access}` };
  if (r.status === 401 || r.status === 403) {
    const pr = await whopApi(`/api/v1/products?account_id=${encodeURIComponent(biz)}&first=1`);
    return { ok: pr.status === 200, via: "fallback_app_installed", detail: `access_status=${r.status} access_shape=${JSON.stringify(r.body).slice(0, 200)} products_status=${pr.status}` };
  }
  return { ok: false, via: "access", detail: `status=${r.status} body=${JSON.stringify(r.body).slice(0, 200)}` };
}

type ApiPlan = {
  id: string; product_id: string | null; title: string | null; plan_type: string | null; visibility: string | null; currency: string | null;
  initial_price: number | null; renewal_price: number | null; billing_period: number | null; trial_period_days: number | null;
  stock: number | null; unlimited_stock: boolean | null; strike_through_initial_price: number | null; strike_through_renewal_price: number | null; purchase_url: string | null;
};
const money = (x: any): number | null => {
  if (x == null || x === "") return null;
  const n = typeof x === "object" ? Number(x.amount) : Number(x);
  return Number.isFinite(n) ? n : null;
};
function normalizePlan(p: any): ApiPlan {
  return {
    id: String(p?.id || ""), product_id: p?.product?.id ?? p?.product_id ?? null, title: p?.title ?? null, plan_type: p?.plan_type ?? null,
    visibility: p?.visibility ?? null, currency: (p?.currency ?? p?.initial_price?.currency ?? null)?.toLowerCase?.() ?? null,
    initial_price: money(p?.initial_price), renewal_price: money(p?.renewal_price), billing_period: p?.billing_period ?? null,
    trial_period_days: p?.trial_period_days ?? null, stock: p?.stock ?? null, unlimited_stock: p?.unlimited_stock ?? null,
    strike_through_initial_price: money(p?.strike_through_initial_price), strike_through_renewal_price: money(p?.strike_through_renewal_price),
    purchase_url: p?.purchase_url ?? null,
  };
}
// Deterministic order so the same plans always give the same text and hash.
const sortPlans = (plans: ApiPlan[]) => [...plans].sort((a, b) => (a.renewal_price ?? 0) - (b.renewal_price ?? 0) || (a.initial_price ?? 0) - (b.initial_price ?? 0) || a.id.localeCompare(b.id));

// "Price option: $29 / 30 days, 7-day trial"
function planLine(p: ApiPlan): string {
  const cur = p.currency;
  const initial = p.initial_price ?? 0, renewal = p.renewal_price ?? 0;
  const recurring = p.plan_type === "renewal" || (p.plan_type !== "one_time" && !!p.billing_period);
  const per = p.billing_period ? `/ ${p.billing_period} day${p.billing_period === 1 ? "" : "s"}` : "recurring";
  let price: string;
  if (recurring) {
    if (renewal <= 0 && initial <= 0) price = "Free";
    else if (initial > 0 && initial !== renewal) price = `${fmtMoney(initial, cur)} first payment, then ${fmtMoney(renewal, cur)} ${per}`;
    else price = `${fmtMoney(renewal, cur)} ${per}`;
  } else price = initial > 0 ? `${fmtMoney(initial, cur)} one-time` : "Free";
  const extras: string[] = [];
  if (p.trial_period_days && p.trial_period_days > 0) extras.push(`${p.trial_period_days}-day trial`);
  const was = recurring ? p.strike_through_renewal_price ?? p.strike_through_initial_price : p.strike_through_initial_price;
  if (was != null && was > 0) extras.push(`was ${fmtMoney(was, cur)}`);
  if (p.unlimited_stock === false && p.stock != null) extras.push(`stock ${p.stock}`);
  if (p.visibility && p.visibility !== "visible") extras.push(p.visibility);
  const title = p.title ? ` (${String(p.title).replace(/[()\n]/g, " ").trim().slice(0, 60)})` : "";
  return `Price option${title}: ${price}${extras.length ? ", " + extras.join(", ") : ""}`;
}
const plansText = (plans: ApiPlan[]) => sortPlans(plans).map(planLine).join("\n");

// Puts the plan lines right after the generated header lines and re-hashes.
function withPlans<T extends { text: string; listingHash: string; plansCount: number | null }>(cap: T, plans: ApiPlan[]): T & { plans: ApiPlan[] } {
  const lines = cap.text.split("\n");
  let i = 0;
  while (i < 2 && i < lines.length && HEADER_LINE.test(lines[i])) i++;
  while (i < lines.length && PLAN_OPTION_LINE.test(lines[i])) lines.splice(i, 1); // never double up
  const sorted = sortPlans(plans);
  const planLines = sorted.map(planLine);
  const text = [...lines.slice(0, i), ...planLines, ...lines.slice(i)].join("\n");
  return { ...cap, text, listingHash: sha256(text), plansCount: sorted.length, plans: sorted };
}

// Public listing URL: https://whop.com/{company route}/{product route}/ (checked live: whop.com/vouch-aadb/vouch-sealed-proof/ is the listing).
// The product's account.route is the biz id, so the company route comes from GET /companies/{biz}.
function productPublicUrl(product: any, companyRoute: string | null): string | null {
  const route = typeof product?.route === "string" && product.route.trim() ? product.route.trim() : null;
  const accountRoute = product?.company?.route ?? product?.account?.route ?? null;
  const store = companyRoute || (accountRoute && !/^biz_/.test(accountRoute) ? accountRoute : null);
  if (route && store) return normalizeWhopUrl(`https://whop.com/${encodeURIComponent(store)}/${encodeURIComponent(route)}/`);
  console.log("whop product has no usable route", JSON.stringify({ id: product?.id, keys: Object.keys(product || {}), route, store }));
  const purchase = product?.purchase_url || product?.default_plan?.purchase_url || null;
  return purchase ? normalizeWhopUrl(String(purchase).split(/[?#]/)[0]) : null;
}

// Which of the business's products a whop.com URL points at (by product route, the last path segment).
function productForUrl(url: string, products: any[]): any | null {
  const n = normalizeWhopUrl(url);
  if (!n) return null;
  const last = new URL(n).pathname.split("/").filter(Boolean).pop() || "";
  return products.find((p) => p?.route && String(p.route).toLowerCase() === last.toLowerCase()) || null;
}

type BizCatalog = { ok: true; biz: string; companyRoute: string | null; companyTitle: string | null; products: any[]; plans: ApiPlan[] } | { ok: false; status: number; error: string };
const catalogCache = new Map<string, { at: number; cat: BizCatalog }>();
async function bizCatalog(biz: string, opts: { fresh?: boolean } = {}): Promise<BizCatalog> {
  const hit = catalogCache.get(biz);
  if (!opts.fresh && hit && Date.now() - hit.at < 60_000) return hit.cat;
  const enc = encodeURIComponent(biz);
  const [co, pr, pl] = await Promise.all([whopApi(`/api/v1/companies/${enc}`), whopList(`/api/v1/products?account_id=${enc}&first=50`), whopList(`/api/v1/plans?account_id=${enc}&first=50`)]);
  if (pr.status !== 200 || pl.status !== 200) {
    console.log("whop catalog failed", JSON.stringify({ biz, products: pr.status, plans: pl.status }));
    return { ok: false, status: pr.status !== 200 ? pr.status : pl.status, error: `Whop API returned ${pr.status !== 200 ? pr.status : pl.status}` };
  }
  if (co.status !== 200) console.log("whop company lookup failed", JSON.stringify({ biz, status: co.status }));
  const cat: BizCatalog = { ok: true, biz, companyRoute: co.status === 200 ? co.body?.route ?? null : null, companyTitle: co.status === 200 ? co.body?.title ?? null : null, products: pr.data, plans: pl.data.map(normalizePlan) };
  catalogCache.set(biz, { at: Date.now(), cat });
  return cat;
}
const plansForProduct = (cat: Extract<BizCatalog, { ok: true }>, productId: string) => cat.plans.filter((p) => p.product_id === productId);
const NOT_CONNECTED = "Connect your Whop business first: open Vouch from your Whop dashboard (Apps → Vouch) and click \"Link to Vouch\".";

// ---------- v2: listings and sealed versions ----------
function versionPayload(listing: any, v: any) {
  return JSON.stringify({
    v: 2,
    kind: "listing_version",
    listing_id: listing.id,
    url: listing.url,
    version_no: v.version_no,
    listing_hash: v.listing_hash,
    title: v.title ?? null,
    default_plan: v.default_plan ? JSON.parse(v.default_plan) : null,
    plans_count: v.plans_count ?? null,
    // Only owner-verified versions have API plans; older versions keep their original payload shape.
    ...(v.plans ? { plans: JSON.parse(v.plans) } : {}),
    source: v.source,
    first_seen_at: new Date(v.first_seen_at).toISOString(),
    sealed_at: new Date(v.sealed_at).toISOString(),
  });
}

function verifyVersion(listing: any, v: any) {
  const textOk = sha256(v.text) === v.listing_hash;
  const payload = versionPayload(listing, v);
  const sealOk = payload === v.sealed_payload && sha256((v.prev_hash || "") + payload) === v.seal_hash;
  return textOk && sealOk;
}

// Creates a new sealed version only when the listing text changed; otherwise records it was seen again.
async function recordVersion(listing: any, cap: { title: string | null; text: string; defaultPlan: DefaultPlan | null; plansCount: number | null; listingHash: string; capturedAt: Date; plans?: ApiPlan[] | null }, source: "captured" | "entered_by_seller") {
  return await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(424242)`;
    const [latest] = await tx`select * from listing_versions where listing_id = ${listing.id} order by version_no desc limit 1`;
    if (latest && latest.listing_hash === cap.listingHash && latest.source === source) {
      const [touched] = await tx`update listing_versions set last_seen_at = ${cap.capturedAt} where id = ${latest.id} returning *`;
      await tx`update listings set last_checked_at = ${cap.capturedAt}, fail_count = 0, status = 'active', last_error = null where id = ${listing.id}`;
      return { changed: false, version: touched };
    }
    const prevHash = await chainHead(tx);
    const [{ t: sealedAt }] = await tx`select clock_timestamp() as t`; // DB clock, after taking the lock, so chain order is consistent
    const row: any = {
      id: randCode(12),
      version_no: (latest?.version_no || 0) + 1,
      listing_hash: cap.listingHash,
      text: cap.text,
      title: cap.title,
      default_plan: cap.defaultPlan ? JSON.stringify(cap.defaultPlan) : null,
      plans_count: cap.plansCount,
      plans: cap.plans ? JSON.stringify(cap.plans) : null,
      first_seen_at: cap.capturedAt,
      last_seen_at: cap.capturedAt,
      source,
      sealed_at: sealedAt,
    };
    const payload = versionPayload(listing, row);
    const sealHash = sha256(prevHash + payload);
    const [inserted] = await tx`insert into listing_versions
        (id, listing_id, version_no, listing_hash, text, title, default_plan, plans_count, plans, first_seen_at, last_seen_at, source, sealed_at, prev_hash, seal_hash, sealed_payload)
      values (${row.id}, ${listing.id}, ${row.version_no}, ${row.listing_hash}, ${row.text}, ${row.title}, ${row.default_plan}, ${row.plans_count}, ${row.plans},
        ${row.first_seen_at}, ${row.last_seen_at}, ${source}, ${sealedAt}, ${prevHash}, ${sealHash}, ${payload}) returning *`;
    await tx`update listings set title = coalesce(${cap.title}, title), last_checked_at = ${cap.capturedAt}, fail_count = 0, status = 'active', last_error = null where id = ${listing.id}`;
    return { changed: true, version: inserted };
  });
}

async function addListing(acct: Account, body: any) {
  if (body?.product_id) return addListingByProduct(acct, String(body.product_id));
  const url = normalizeWhopUrl(String(body?.url || ""));
  if (!url) return { error: "Use a public whop.com listing link, like https://whop.com/your-store/your-product/", status: 400 };
  // Owner verification: only when the URL's product belongs to the account's linked Whop business.
  let verified: { biz: string; productId: string; plans: ApiPlan[] } | null = null;
  if (acct.whop_biz_id) {
    const cat = await bizCatalog(acct.whop_biz_id);
    if (!cat.ok) return { error: `Couldn't check your connected Whop business right now (${cat.error}). Try again in a minute.`, status: 502 };
    const prod = productForUrl(url, cat.products);
    if (!prod) return { error: `That listing isn't in the Whop business connected to this account. To watch it as the owner, connect the Whop business that sells it: open Vouch from that business's Whop dashboard and click "Link to Vouch".`, status: 403 };
    verified = { biz: acct.whop_biz_id, productId: String(prod.id), plans: plansForProduct(cat, String(prod.id)) };
  } else if (body?.owner_verified === true) {
    return { error: NOT_CONNECTED, status: 403 };
  }
  return addListingAt(acct, url, body, verified);
}

// {product_id}: the product must be in the account's linked Whop business.
async function addListingByProduct(acct: Account, productId: string) {
  if (!acct.whop_biz_id) return { error: NOT_CONNECTED, status: 403 };
  const cat = await bizCatalog(acct.whop_biz_id);
  if (!cat.ok) return { error: `Couldn't load your Whop products right now (${cat.error}). Try again in a minute.`, status: 502 };
  const prod = cat.products.find((p) => p?.id === productId);
  if (!prod) return { error: "That product isn't in the Whop business connected to this account.", status: 404 };
  const url = productPublicUrl(prod, cat.companyRoute);
  if (!url) return { error: "Whop didn't give us a public page for that product, so it can't be captured yet. Paste its whop.com link instead.", status: 422 };
  return addListingAt(acct, url, {}, { biz: acct.whop_biz_id, productId, plans: plansForProduct(cat, productId) });
}

async function addListingAt(acct: Account, url: string, body: any, verified: { biz: string; productId: string; plans: ApiPlan[] } | null) {
  const [existing] = verified
    ? await sql`select * from listings where account_key_hash = ${acct.key_hash} and (url = ${url} or product_id = ${verified.productId}) order by (url = ${url}) desc limit 1`
    : await sql`select * from listings where account_key_hash = ${acct.key_hash} and url = ${url}`;
  if (!existing) {
    const [{ n }] = await sql`select count(*)::int as n from listings where account_key_hash = ${acct.key_hash}`;
    const limit = listingLimitFor(acct.plan);
    if (n >= limit) return { error: `${PLAN_LABEL[acct.plan] || "Your plan"} watches ${limit} listing${limit === 1 ? "" : "s"} and this account is using ${limit === 1 ? "it" : "them all"}. Upgrade to watch more: ${WHOP_PRODUCT_URL}`, status: 402 };
  }
  // An existing listing keeps its URL (it is part of every sealed version's payload).
  const captureUrl: string = existing ? existing.url : url;
  let cap: (Capture & { plans?: ApiPlan[] | null }) | null = null;
  let source: "captured" | "entered_by_seller" = "captured";
  try {
    cap = await captureListing(captureUrl);
  } catch (e: any) {
    const pasted = String(body?.text || "").trim();
    if (verified || !pasted) return { error: `Couldn't read that page (${e?.message || "fetch failed"}). Try again${verified ? " in a few minutes" : ", or paste the listing text and we'll label it as entered by you"}.`, status: 502 };
    const text = pasted.slice(0, 20000);
    cap = { url: captureUrl, title: body?.title ? String(body.title).slice(0, 200) : null, text, defaultPlan: { id: null, renewalPrice: null, initialPrice: null, trialDays: null, planType: null, billingDays: null, period: null, currency: null }, plansCount: null, listingHash: sha256(text), capturedAt: new Date() };
    source = "entered_by_seller";
  }
  if (verified) cap = withPlans(cap, verified.plans);
  let listing = existing || (await sql`insert into listings (id, account_key_hash, url, title) values (${randCode(10)}, ${acct.key_hash}, ${captureUrl}, ${cap.title}) returning *`)[0];
  if (verified) {
    [listing] = await sql`update listings set owner_verified = true, product_id = ${verified.productId}, whop_biz_id = ${verified.biz} where id = ${listing.id} returning *`;
  }
  const rec = await recordVersion(listing, cap, source);
  await logEvent("listing_added", null, { listing: listing.id, source, changed: rec.changed, owner_verified: !!verified });
  return {
    listing: { id: listing.id, url: captureUrl, title: cap.title ?? listing.title, owner_verified: !!listing.owner_verified, product_id: listing.product_id ?? null },
    version: {
      no: rec.version.version_no, source, changed: rec.changed, captured_at: cap.capturedAt, default_plan: cap.defaultPlan, plans_count: cap.plansCount,
      plans: verified ? cap.plans : undefined,
      note: verified ? null : cap.plansCount && cap.plansCount > 1 ? `Only the default price option is captured; ${cap.plansCount - 1} more exist.` : null,
    },
    text: verified ? cap.text : undefined,
    claims: flagClaims(source === "captured" ? stripHeader(cap.text) : cap.text),
    status: existing ? 200 : 201,
  };
}

async function listListings(acct: Account) {
  return await sql`select l.id, l.url, l.title, l.status, l.fail_count, l.last_checked_at, l.created_at, l.owner_verified,
      (select max(version_no) from listing_versions v where v.listing_id = l.id)::int as versions
    from listings l where l.account_key_hash = ${acct.key_hash} order by l.created_at`;
}

async function listingVersions(acct: Account, id: string) {
  const [listing] = await sql`select * from listings where id = ${id} and account_key_hash = ${acct.key_hash}`;
  if (!listing) return null;
  const rows = await sql`select * from listing_versions where listing_id = ${id} order by version_no desc`;
  const shape = (v: any) => ({
    no: v.version_no, source: v.source, first_seen_at: v.first_seen_at, last_seen_at: v.last_seen_at, title: v.title,
    default_plan: v.default_plan ? JSON.parse(v.default_plan) : null, plans_count: v.plans_count, text: v.text,
    seal_hash: v.seal_hash, intact: verifyVersion(listing, v),
  });
  const paid = acct.plan === "starter" || acct.plan === "pro";
  const visible = paid ? rows : rows.slice(0, 1);
  return {
    listing: { id: listing.id, url: listing.url, title: listing.title, status: listing.status },
    stored: rows.length,
    visible: visible.length,
    note: paid ? null : rows.length > 1 ? `${rows.length - 1} earlier version${rows.length - 1 === 1 ? " is" : "s are"} stored. Upgrade to open the full history and evidence packs.` : null,
    versions: visible.map(shape),
  };
}

// Daily job: re-capture every watched listing. Two failures in a row mark it stale.
async function recheckAll() {
  const listings = await sql`select l.*, a.whop_biz_id as acct_biz from listings l join accounts a on a.key_hash = l.account_key_hash
    where l.status in ('active', 'stale') order by l.last_checked_at nulls first`;
  const summary = { checked: 0, unchanged: 0, changed: 0, failed: 0, stale: 0, plans_refreshed: 0 };
  const catalogs = new Map<string, BizCatalog>(); // one fresh API read per business per run
  for (const row of listings) {
    const { acct_biz, ...l } = row as any;
    summary.checked++;
    try {
      let cap: Capture & { plans?: ApiPlan[] } = await captureListing(l.url);
      // Owner-verified and the account is still linked to the same business: refresh every plan from the Whop API.
      if (l.owner_verified && l.product_id && acct_biz && acct_biz === l.whop_biz_id) {
        if (!catalogs.has(acct_biz)) catalogs.set(acct_biz, await bizCatalog(acct_biz, { fresh: true }));
        const cat = catalogs.get(acct_biz)!;
        if (!cat.ok) throw new Error(`Whop API plans refresh failed (${cat.error})`);
        cap = withPlans(cap, plansForProduct(cat, l.product_id));
        summary.plans_refreshed++;
      }
      const rec = await recordVersion(l, cap, "captured");
      rec.changed ? summary.changed++ : summary.unchanged++;
    } catch (e: any) {
      summary.failed++;
      const [u] = await sql`update listings set fail_count = fail_count + 1, last_error = ${String(e?.message || e).slice(0, 300)}, last_checked_at = now(),
          status = case when fail_count + 1 >= ${STALE_AFTER_FAILURES} then 'stale' else status end
        where id = ${l.id} returning status`;
      if (u?.status === "stale") summary.stale++;
    }
    await Bun.sleep(CAPTURE_FIXTURES ? 0 : 1500); // spread requests; the daily cron also staggers start time
  }
  await logEvent("recheck_run", null, summary);
  return summary;
}

// ---------- Connect your Whop: pages ----------
// Inside Whop's dashboard iframe: allow Whop to frame it, never cache (it carries a signed link), no referrer.
const framed = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": FRAME_CSP, "cache-control": "no-store", "referrer-policy": "no-referrer" } });

function whopErrorPage(title: string, msg: string) {
  return page(`Vouch — ${title}`, `<div class="wrap">${topbar()}<h1 style="font-size:22px">${esc(title)}</h1><p class="small muted" style="margin-top:8px">${esc(msg)}</p></div>`);
}

// Client-side product picker, shared by the dashboard (inline fallback) and /link. Plain quotes only: it sits inside a template string.
const PICKER_JS = `
function vEsc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
async function picker(KEY,box){
  box.innerHTML='<p class="tiny" style="margin-top:14px">Loading your Whop products…</p>';
  var r=await fetch('/api/whop/products',{headers:{authorization:'Bearer '+KEY}});var d=await r.json().catch(function(){return {}});
  if(!r.ok){box.innerHTML='<p class="err"></p>';box.querySelector('.err').textContent=d.error||'Could not load your products';return}
  box.innerHTML='<h2 style="font-size:20px;margin:22px 0 6px">Pick products to watch</h2><p class="small muted" style="margin:0 0 12px">Linked to '+vEsc(d.company_title||d.biz)+'. Vouch captures each page now, records every price option, and re-checks daily.</p>'
    +'<div class="stack">'+d.products.map(function(p){return '<label class="card row" style="margin:0;align-items:flex-start;flex-wrap:nowrap;gap:12px;color:var(--ink);cursor:pointer"><input type="checkbox" value="'+vEsc(p.id)+'" style="width:auto;margin-top:5px"'+(p.watched||!p.url?' disabled':'')+(p.watched?' checked':'')+'><span style="flex:1"><span style="font-weight:600">'+vEsc(p.title)+'</span>'+(p.watched?' <span class="pill" style="border:1px solid var(--volt);color:var(--volt)">Watching</span>':'')+(p.visibility&&p.visibility!=='visible'?' <span class="pill" style="border:1px solid var(--line);color:var(--ink2)">'+vEsc(p.visibility)+'</span>':'')+'<span class="hash" style="display:block;margin:2px 0 4px">'+vEsc(p.url||'No public page from Whop')+'</span>'+p.price_options.map(function(l){return '<span class="small muted" style="display:block">'+vEsc(l)+'</span>'}).join('')+'<span class="small res" style="display:block;margin-top:4px"></span></span></label>'}).join('')+'</div>'
    +'<div style="margin-top:14px"><button class="btn primary full" id="watch">Watch selected</button></div><div id="werr" class="err"></div>';
  box.querySelector('#watch').onclick=async function(){
    var btn=this,werr=box.querySelector('#werr');werr.textContent='';
    var picks=[].slice.call(box.querySelectorAll('input[type=checkbox]:checked:not(:disabled)'));
    if(!picks.length){werr.textContent='Tick at least one product.';return}
    btn.disabled=true;
    for(var i=0;i<picks.length;i++){var cb=picks[i],res=cb.closest('label').querySelector('.res');res.style.color='var(--ink2)';res.textContent='Capturing the page…';
      var x=await fetch('/api/listings',{method:'POST',headers:{authorization:'Bearer '+KEY,'content-type':'application/json'},body:JSON.stringify({product_id:cb.value})});var j=await x.json().catch(function(){return {}});
      if(x.ok){cb.disabled=true;var n=(j.claims||[]).filter(function(c){return c.flags&&c.flags.length}).length;res.style.color='var(--volt)';res.textContent='Watching as verified owner · version '+j.version.no+' sealed · '+(j.version.plans_count||0)+' price options recorded · '+n+' claim'+(n===1?'':'s')+' worth a look'}
      else{res.style.color='var(--redink)';res.textContent=j.error||'Could not add it'}}
    btn.disabled=false};
}`;

function whopDashboardPage(cat: Extract<BizCatalog, { ok: true }>, linkToken: string) {
  const products = cat.products.map((p: any) => {
    const lines = sortPlans(plansForProduct(cat, String(p.id))).map((pl) => planLine(pl).replace(/^Price option(?: \(([^)]*)\))?: /, (_m, t) => (t ? `${t} · ` : "")));
    return `<div class="card"><div style="font-weight:600">${esc(p.title)}${p.visibility && p.visibility !== "visible" ? ` <span class="pill" style="border:1px solid var(--line);color:var(--ink2)">${esc(p.visibility)}</span>` : ""}</div>
<div class="hash" style="margin:2px 0 6px">${esc(productPublicUrl(p, cat.companyRoute) || "No public page from Whop")}</div>
${lines.length ? lines.map((l) => `<div class="small muted">${esc(l)}</div>`).join("") : `<div class="small muted">No price options</div>`}</div>`;
  }).join("");
  const linkUrl = `${BASE_URL}/link?t=${encodeURIComponent(linkToken)}`;
  return page("Vouch — connect your Whop", `<div class="wrap">
${topbar(`<span class="pill" style="border:1px solid var(--line);color:var(--ink2)">${esc(cat.companyTitle || cat.biz)}</span>`)}
<h1 style="font-size:24px">Connect your Whop</h1>
<p class="small muted" style="margin:6px 0 16px">Vouch watches your listings, flags claims that often lead to disputes, and keeps a sealed record of every version. Link this business to your Vouch account to watch these products as their verified owner, with every price option recorded.</p>
<div class="stack">${products || `<p class="small muted">No products in this business yet.</p>`}</div>
<div style="margin-top:18px"><a class="btn primary full" id="golink" href="${esc(linkUrl)}" target="_blank" rel="noopener">Link to Vouch</a></div>
<p class="tiny" style="margin:8px 0 0;text-align:center">Opens Vouch in a new tab, where you pick which products to watch. The link works for 10 minutes.</p>
<div class="card" style="margin-top:22px"><h3 style="font-size:15px;margin-bottom:4px">New tab blocked? Link from here</h3>
<label style="margin-top:6px">Your Vouch key</label><input id="key" placeholder="Your license key" autocomplete="off">
<div class="row" style="margin-top:10px"><button class="btn" id="linkhere">Link with my Vouch key</button></div><div id="msg" class="small" style="margin-top:8px"></div></div>
<div id="picker"></div></div>`, {
    script: `${PICKER_JS}
const T=${JSON.stringify(linkToken)};const $=id=>document.getElementById(id);
$('linkhere').onclick=async()=>{const KEY=$('key').value.trim();$('msg').className='small';$('msg').textContent='';if(!KEY){$('msg').className='err';$('msg').textContent='Enter your Vouch key.';return}
$('linkhere').disabled=true;const r=await fetch('/api/link',{method:'POST',headers:{authorization:'Bearer '+KEY,'content-type':'application/json'},body:JSON.stringify({t:T})});const d=await r.json().catch(()=>({}));$('linkhere').disabled=false;
if(!r.ok){$('msg').className='err';$('msg').textContent=r.status===401?${JSON.stringify(KEY_INACTIVE)}:(d.error||'Could not link');return}
$('msg').style.color='var(--volt)';$('msg').textContent='Linked. Your Vouch account now watches this business as its owner.';picker(KEY,$('picker'))};`,
  });
}

function linkPage() {
  return page("Vouch — connect your Whop", `<div class="wrap">
${topbar(`<a class="btn" href="/app">New review</a>`)}
${KEYBOX}
<div id="main" style="display:none">
<h1 style="font-size:24px">Connect your Whop</h1>
<div id="status" class="small muted" style="margin:6px 0 0"></div>
<div id="picker"></div>
<p class="tiny" style="margin-top:18px"><a href="#" id="forget">Use a different key</a></p>
</div></div>`, {
    script: `${PICKER_JS}
const $=id=>document.getElementById(id);let KEY=null;try{KEY=localStorage.getItem('vouch_key')}catch(e){}
const T=new URLSearchParams(location.search).get('t');
function askKey(err){$('main').style.display='none';$('keybox').style.display='block';$('keyerr').textContent=err||''}
async function boot(){if(!KEY){askKey();return}
const mr=await fetch('/api/me',{headers:{authorization:'Bearer '+KEY}});if(!mr.ok){askKey(${JSON.stringify(KEY_INACTIVE)});return}
const m=await mr.json();$('keybox').style.display='none';$('main').style.display='block';let linked=!!m.whop;
if(T){const r=await fetch('/api/link',{method:'POST',headers:{authorization:'Bearer '+KEY,'content-type':'application/json'},body:JSON.stringify({t:T})});const d=await r.json().catch(()=>({}));
if(r.status===401){askKey(${JSON.stringify(KEY_INACTIVE)});return}
if(!r.ok){$('status').className='err';$('status').textContent=d.error||'Could not link';if(!linked)return}
else{linked=true;$('status').textContent='This Vouch account is now linked to '+(d.company_title||d.biz)+'.';try{history.replaceState(null,'','/link')}catch(e){}}}
if(!linked){$('status').textContent='No Whop business is linked yet. Open Vouch from your Whop dashboard and click "Link to Vouch".';return}
picker(KEY,$('picker'))}
$('savekey').onclick=()=>{KEY=$('key').value.trim();try{localStorage.setItem('vouch_key',KEY)}catch(e){}$('keyerr').textContent='';boot()};
$('forget').onclick=e=>{e.preventDefault();try{localStorage.removeItem('vouch_key')}catch(e){}KEY=null;askKey()};
boot();`,
  });
}

async function whopDashboard(req: Request, biz: string): Promise<Response> {
  const reject = (status: number, reason: string, title: string, msg: string) => {
    console.log(`whop-dashboard reject biz=${biz.replace(/[^\w-]/g, "?").slice(0, 40)} status=${status} reason=${reason.replace(/[\r\n]/g, " ")}`);
    return framed(whopErrorPage(title, msg), status);
  };
  if (!/^biz_[A-Za-z0-9]{4,40}$/.test(biz)) return reject(400, "bad company id in path", "Unknown business", "This page needs a Whop business id.");
  const token = req.headers.get("x-whop-user-token");
  if (!token) return reject(401, "no token (x-whop-user-token header missing)", "Open this from Whop", "This page only works inside your Whop dashboard. Open your business dashboard on whop.com and choose Vouch from your apps.");
  const v = await verifyWhopToken(token);
  if (!v.ok) return reject(401, `token ${v.reason}`, "Couldn't confirm your Whop sign-in", "Reload this page from your Whop dashboard. If it keeps happening, sign out of Whop and back in.");
  const admin = await whopAdminCheck(v.sub, biz);
  console.log(`whop-dashboard admin-check biz=${biz} user=${v.sub} via=${admin.via} ok=${admin.ok} ${admin.detail}`);
  if (!admin.ok) return reject(403, `not admin (via=${admin.via} ${admin.detail})`, "Admins only", "Only an admin of this Whop business can connect it to Vouch.");
  const cat = await bizCatalog(biz);
  if (!cat.ok) return reject(502, `catalog ${cat.error}`, "Couldn't load your products", "Whop didn't answer just now. Reload in a minute.");
  if (!LINK_SECRET) return reject(500, "LINK_SECRET not set", "Not set up yet", "Vouch isn't fully configured. Please try again later.");
  console.log(`whop-dashboard ok biz=${biz} user=${v.sub} products=${cat.products.length} plans=${cat.plans.length}`);
  return framed(whopDashboardPage(cat, signLinkToken(biz, v.sub)));
}

const LINK_ERRORS: Record<string, string> = {
  expired: "This link has expired (links last 10 minutes). Go back to Vouch in your Whop dashboard and click \"Link to Vouch\" again.",
};
async function linkAccount(acct: Account, t: string) {
  const v = verifyLinkToken(t);
  if (!v.ok) {
    console.log(`api-link reject reason=${v.reason}`);
    return { error: LINK_ERRORS[v.reason] || "This link isn't valid. Open Vouch from your Whop dashboard and click \"Link to Vouch\" again.", status: 400 };
  }
  const prev = acct.whop_biz_id || null;
  const [a] = await sql`update accounts set whop_biz_id = ${v.biz}, whop_user_id = ${v.user}, linked_at = now() where key_hash = ${acct.key_hash} returning *`;
  // Relinking to another business: listings verified through the old one are no longer owner-verified.
  if (prev && prev !== v.biz) await sql`update listings set owner_verified = false where account_key_hash = ${acct.key_hash} and owner_verified and whop_biz_id is distinct from ${v.biz}`;
  await logEvent("whop_linked", null, { biz: v.biz, relinked: !!prev, changed_biz: !!prev && prev !== v.biz });
  console.log(`api-link ok biz=${v.biz} user=${v.user} relinked=${!!prev}`);
  const cached = catalogCache.get(v.biz)?.cat;
  return { ok: true, biz: v.biz, company_title: cached && cached.ok ? cached.companyTitle : null, linked_at: a.linked_at, relinked: !!prev };
}

async function whopProducts(acct: Account) {
  if (!acct.whop_biz_id) return { error: NOT_CONNECTED, status: 409 };
  const cat = await bizCatalog(acct.whop_biz_id);
  if (!cat.ok) return { error: `Couldn't load your Whop products right now (${cat.error}). Try again in a minute.`, status: 502 };
  const watched = new Set((await sql`select product_id from listings where account_key_hash = ${acct.key_hash} and owner_verified and product_id is not null`).map((r: any) => r.product_id));
  return {
    biz: cat.biz, company_title: cat.companyTitle, company_route: cat.companyRoute,
    products: cat.products.map((p: any) => {
      const plans = sortPlans(plansForProduct(cat, String(p.id)));
      return { id: p.id, title: p.title ?? null, route: p.route ?? null, visibility: p.visibility ?? null, url: productPublicUrl(p, cat.companyRoute), watched: watched.has(p.id), price_options: plans.map(planLine), plans };
    }),
    plans: cat.plans,
  };
}

// ---------- public risk-check rate limit ----------
// In memory, per process: it resets on every redeploy or restart, and each replica counts separately.
const RISK_LIMIT = 10;
const RISK_WINDOW_MS = 60 * 60 * 1000;
const riskHits = new Map<string, number[]>();
// Railway's edge appends the real client address to x-forwarded-for, so only the LAST entry is trustworthy;
// anything before it can be set by the client.
function clientIp(req: Request, connIp: string | null) {
  const parts = (req.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || connIp || "unknown";
}
function takeRiskSlot(ip: string, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
  const hits = (riskHits.get(ip) || []).filter((t) => now - t < RISK_WINDOW_MS);
  if (hits.length >= RISK_LIMIT) {
    riskHits.set(ip, hits);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((hits[0] + RISK_WINDOW_MS - now) / 1000)) };
  }
  hits.push(now);
  riskHits.set(ip, hits);
  if (riskHits.size > 10000) for (const [k, v] of riskHits) if (!v.length || now - v[v.length - 1] >= RISK_WINDOW_MS) riskHits.delete(k);
  return { ok: true };
}

// ---------- router ----------
async function route(req: Request, connIp: string | null = null): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;

  if (m === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" } });
  if (p === "/health") return json({ ok: true, version: VERSION });
  if (p === "/" && m === "GET") return html(landingPage());
  if (p === "/app" && m === "GET") return html(appPage());
  if (p === "/mcp") return handleMcp(req, url);

  if (p === "/api/me") {
    const acct = await authenticate(keyFrom(req, url));
    if (!acct) return json({ error: "invalid or inactive key" }, 401);
    let a: any = acct;
    if (m === "POST") {
      const body: any = await req.json().catch(() => ({}));
      if (body.display_name) a = await setDisplayName(acct, String(body.display_name));
    }
    return json({ plan: a.plan, display_name: a.display_name, slug: a.slug, used_this_month: await monthlyCount(a.key_hash), limit: limitFor(a.plan), whop: a.whop_biz_id ? { biz: a.whop_biz_id, linked_at: a.linked_at } : null });
  }

  // ----- Connect your Whop -----
  let wd = p.match(/^\/whop\/dashboard\/([^/]+)\/?$/);
  if (wd && m === "GET") return whopDashboard(req, wd[1]);
  if (p === "/link" && m === "GET") return new Response(linkPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  if (p === "/api/link" && m === "POST") {
    const acct = await authenticate(keyFrom(req, url));
    if (!acct) return json({ error: "invalid or inactive key" }, 401);
    const body: any = await req.json().catch(() => ({}));
    const r: any = await linkAccount(acct, String(body?.t || ""));
    return r.error ? json({ error: r.error }, r.status) : json(r);
  }
  if (p === "/api/whop/products" && m === "GET") {
    const acct = await authenticate(keyFrom(req, url));
    if (!acct) return json({ error: "invalid or inactive key" }, 401);
    const r: any = await whopProducts(acct);
    return r.error ? json({ error: r.error }, r.status) : json(r);
  }

  if (p === "/api/reviews" && m === "POST") {
    const acct = await authenticate(keyFrom(req, url));
    if (!acct) return json({ error: "invalid or inactive key" }, 401);
    const body: any = await req.json().catch(() => ({}));
    const r: any = await createReview(acct, body);
    return r.error ? json({ error: r.error }, r.status || 400) : json(r, 201);
  }

  // ----- v2 listings -----
  if (p === "/api/listings") {
    const acct = await authenticate(keyFrom(req, url));
    if (!acct) return json({ error: "invalid or inactive key" }, 401);
    if (m === "GET") return json({ plan: acct.plan, limit: listingLimitFor(acct.plan), listings: await listListings(acct) });
    if (m === "POST") {
      const body: any = await req.json().catch(() => ({}));
      const r: any = await addListing(acct, body);
      if (r.error) return json({ error: r.error }, r.status || 400);
      const { status, ...rest } = r;
      return json(rest, status);
    }
  }
  let lv = p.match(/^\/api\/listings\/([A-Z0-9]{10})\/versions$/);
  if (lv && m === "GET") {
    const acct = await authenticate(keyFrom(req, url));
    if (!acct) return json({ error: "invalid or inactive key" }, 401);
    const r = await listingVersions(acct, lv[1]);
    return r ? json(r) : json({ error: "listing not found" }, 404);
  }
  if (p === "/api/risk-check" && m === "POST") {
    // Public, no account, stores nothing. Limited per client IP.
    const slot = takeRiskSlot(clientIp(req, connIp));
    if (!slot.ok) {
      const mins = Math.ceil(slot.retryAfter / 60);
      const res = json({ error: `You've used the ${RISK_LIMIT} free checks allowed per hour from this connection. Please try again in about ${mins} minute${mins === 1 ? "" : "s"}.`, retry_after_seconds: slot.retryAfter }, 429);
      res.headers.set("retry-after", String(slot.retryAfter));
      return res;
    }
    const body: any = await req.json().catch(() => ({}));
    try {
      const cap = await captureListing(String(body.url || ""));
      const claims = flagClaims(stripHeader(cap.text));
      await logEvent("risk_check", null, { flagged: claims.filter((c) => c.flags.length).length, claims: claims.length });
      return json({ url: cap.url, title: cap.title, captured_at: cap.capturedAt, default_plan: cap.defaultPlan, plans_count: cap.plansCount, text: cap.text, listing_hash: cap.listingHash, claims, view: "public signed-out view" });
    } catch (e: any) {
      return json({ error: e?.message || "Couldn't read that page" }, 400);
    }
  }
  if (p === "/admin/recheck" && m === "POST") {
    if (!ADMIN_KEY || url.searchParams.get("key") !== ADMIN_KEY) return json({ error: "forbidden" }, 403);
    return json(await recheckAll());
  }

  let mt = p.match(/^\/api\/reviews\/([A-Z0-9]{10})\/seal$/);
  if (mt && m === "POST") {
    const body: any = await req.json().catch(() => ({}));
    const r: any = await sealReview(mt[1], String(body.token || ""), Array.isArray(body.verdicts) ? body.verdicts : []);
    return r.error ? json({ error: r.error }, r.status || 400) : json(r);
  }

  mt = p.match(/^\/api\/records\/([A-Z0-9]{6})\/purpose$/);
  if (mt && m === "POST") {
    const body: any = await req.json().catch(() => ({}));
    const allowed = ["Sales page", "Client work", "My product", "Other"];
    const purpose = allowed.includes(body.purpose) ? body.purpose : null;
    const [r] = await sql`select id, token from reviews where code = ${mt[1]}`;
    if (!r || r.token !== body.token || !purpose) return json({ error: "not allowed" }, 403);
    await sql`update reviews set purpose = ${purpose} where id = ${r.id}`;
    await logEvent("purpose", r.id, { purpose });
    return json({ ok: true });
  }

  mt = p.match(/^\/r\/([A-Z0-9]{10})$/);
  if (mt && m === "GET") {
    const [r] = await sql`select * from reviews where id = ${mt[1]}`;
    if (!r || r.token !== url.searchParams.get("t")) return html(page("Not found", `<div class="wrap">${topbar()}<h1>Review not found</h1></div>`), 404);
    if (r.code) return Response.redirect(`${BASE_URL}/v/${r.code}`, 302);
    if (!r.opened_at) await sql`update reviews set opened_at = now() where id = ${r.id} and opened_at is null`;
    const claims = await sql`select * from claims where review_id = ${r.id} order by idx`;
    const files = await sql`select * from files where review_id = ${r.id} order by idx`;
    return html(reviewPage(r, claims, files));
  }

  mt = p.match(/^\/v\/([A-Za-z0-9]{6})$/);
  if (mt && m === "GET") {
    const rec = await loadRecord(mt[1].toUpperCase());
    if (!rec) return html(page("Not found", `<div class="wrap">${topbar()}<h1>No sealed record with that code</h1></div>`), 404);
    const token = url.searchParams.get("t");
    const isNew = url.searchParams.get("new") === "1" && token === rec.r.token;
    if (!isNew) {
      let host: string | null = null;
      try { const ref = req.headers.get("referer"); if (ref) host = new URL(ref).host; } catch {}
      if (host && BASE_URL.includes(host)) host = "vouch-internal";
      await sql`insert into views (code, referrer_host) values (${rec.r.code}, ${host})`;
    }
    return html(evidencePage(rec, { isNew, token: isNew ? token : null }));
  }

  mt = p.match(/^\/verify\/([A-Za-z0-9]{6})$/);
  if (mt && m === "GET") {
    const rec = await loadRecord(mt[1].toUpperCase());
    if (!rec) return json({ error: "not found" }, 404);
    return json({ code: rec.r.code, intact: rec.intact, algorithm: "sha256(prev_hash + payload)", prev_hash: rec.r.prev_hash, seal_hash: rec.r.seal_hash, payload: JSON.parse(rec.r.sealed_payload) });
  }

  mt = p.match(/^\/badge\/([A-Za-z0-9]{6})\.svg$/);
  if (mt && m === "GET") {
    const rec = await loadRecord(mt[1].toUpperCase());
    if (!rec || rec.plan !== "pro") return new Response("Badge embeds are a Pro feature", { status: 404 });
    return new Response(badgeSvg(rec), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
  }

  if (p === "/registry" && m === "GET") return html(await registryPage(url.searchParams.get("q") || ""));
  mt = p.match(/^\/s\/([a-z0-9-]{1,60})$/);
  if (mt && m === "GET") {
    const body = await sellerPage(mt[1]);
    return body ? html(body) : html(page("Not found", `<div class="wrap">${topbar()}<h1>No records for that seller</h1></div>`), 404);
  }

  if (p === "/admin/stats" && m === "GET") {
    if (!ADMIN_KEY || url.searchParams.get("key") !== ADMIN_KEY) return json({ error: "forbidden" }, 403);
    return json(await adminStats());
  }

  return html(page("Not found", `<div class="wrap">${topbar()}<h1>Page not found</h1></div>`), 404);
}

if (!UNIT_TEST) {
  Bun.serve({
    port: PORT,
    async fetch(req, server) {
      try { return await route(req, server.requestIP(req)?.address ?? null); }
      catch (e) { console.error(e); return json({ error: "server error" }, 500); }
    },
  });
  console.log(`vouch ${VERSION} listening on ${PORT}`);
}

// For test/unit.ts (pure functions; no database or network except the JWKS URL).
export { verifyWhopToken, signLinkToken, verifyLinkToken, productPublicUrl, productForUrl, planLine, plansText, normalizePlan, withPlans, stripHeader, clientIp, LINK_TTL_SECONDS };
export const _jwksFetches = () => jwksFetches;

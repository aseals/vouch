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
const VERSION = "0.1.2";

const sql = new SQL(env.DATABASE_URL || "postgres://postgres@localhost:5432/vouch");

// ---------- schema ----------
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
await sql`create index if not exists reviews_seller_idx on reviews (seller_slug) where code is not null`;
await sql`create index if not exists reviews_account_idx on reviews (account_key_hash, created_at)`;

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
type Account = { key_hash: string; plan: string; status: string; display_name: string | null; slug: string | null };

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
    const [prev] = await tx`select seal_hash from reviews where seal_hash is not null order by sealed_at desc limit 1`;
    const prevHash = prev?.seal_hash || "genesis";
    const [upd] = await tx`update reviews set
        code = ${code}, sealed_at = now(),
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

function appPage() {
  return page("Vouch — new review", `<div class="wrap">
${topbar(`<a class="btn" href="/registry">Registry</a>`)}
<div id="keybox" class="card" style="display:none"><h2 style="font-size:20px">Enter your key</h2>
<p class="small muted">Your Vouch key is the license key from your Whop purchase. Find it in Whop under your orders (whop.com/@me/settings/orders) → Vouch.</p>
<input id="key" placeholder="Your license key" autocomplete="off"><div class="row" style="margin-top:10px"><button class="btn primary" id="savekey">Continue</button></div><div id="keyerr" class="err"></div></div>
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
    ? `<div class="card"><h3 style="font-size:14px;margin-bottom:6px">Embed your badge</h3><img src="/badge/${r.code}.svg" alt="Verified by Vouch" style="max-width:100%;height:auto"><div class="hash" style="margin-top:8px">&lt;a href="${esc(link)}"&gt;&lt;img src="${esc(BASE_URL)}/badge/${r.code}.svg" alt="Verified by Vouch"&gt;&lt;/a&gt;</div></div>`
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="110" viewBox="0 0 300 110" role="img" aria-label="Verified by Vouch, sealed ${esc(d)}">
<rect x="0.5" y="0.5" width="299" height="109" rx="12" fill="#0C0F13" stroke="#232B35"/>
<g transform="translate(18 27) scale(2.3)" fill="none"><path d="M12 2l8 4.6v9.2L12 22l-8-4.6V6.6L12 2z" stroke="#C8F545" stroke-width="1.3"/><path d="M8.5 12.2l2.3 2.3 4.7-4.8" stroke="#C8F545" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></g>
<text x="88" y="45" font-family="Space Grotesk,Inter,sans-serif" font-weight="700" font-size="19" fill="#F4F7F2">Verified by Vouch</text>
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

// ---------- router ----------
async function route(req: Request): Promise<Response> {
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
    return json({ plan: a.plan, display_name: a.display_name, slug: a.slug, used_this_month: await monthlyCount(a.key_hash), limit: limitFor(a.plan) });
  }

  if (p === "/api/reviews" && m === "POST") {
    const acct = await authenticate(keyFrom(req, url));
    if (!acct) return json({ error: "invalid or inactive key" }, 401);
    const body: any = await req.json().catch(() => ({}));
    const r: any = await createReview(acct, body);
    return r.error ? json({ error: r.error }, r.status || 400) : json(r, 201);
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

Bun.serve({
  port: PORT,
  async fetch(req) {
    try { return await route(req); }
    catch (e) { console.error(e); return json({ error: "server error" }, 500); }
  },
});
console.log(`vouch ${VERSION} listening on ${PORT}`);

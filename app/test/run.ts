// Local test for the v2 slice. Uses HTML fixtures because this sandbox can't reach whop.com.
import { SQL } from "bun";
const D = "/home/claude/vouch-v2/test";
const F = `${D}/fixtures`;
const MAP = `${D}/map.json`;
const PORT = 3999;
const DB = "postgres://postgres@localhost:5433/vouch_v2?host=/tmp";
const PRO = "devkey-pro-123456";
const FREE = "freekey-abcdef-1";
const ADMIN = "admin-test-key";
const VOUCH = "https://whop.com/vouch-sealed-proof/vouch-sealed-proof/";
const TOM = "https://whop.com/tomwbtc/products/url-service/";
const RISKY = "https://whop.com/demo/ecom-launch-lab/";
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

const setMap = (m: Record<string, string>) => Bun.write(MAP, JSON.stringify(m));
await setMap({ [VOUCH]: `${F}/vouch-v1.html`, [TOM]: `${F}/tom.html`, [RISKY]: `${F}/risky.html` });

// ---------- fake Whop API (JWKS, company, products, plans, access) for "Connect your Whop" ----------
const WHOP_PORT = 3996, APP_ID = "app_runtest", LINK_SECRET = "run-link-secret-abcdef0123456789", WHOP_KEY = "fake-app-key";
const BIZ = "biz_TESTSTORE1", BIZ2 = "biz_OTHERSTORE2";
const PRODUCT_URL = "https://whop.com/test-store/vouch-live/";
const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const pubJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
const fakePlan = (id: string, product: string, renewal: number) => ({ id, product: { id: product, title: "x" }, account: { id: BIZ }, currency: "usd", billing_period: 30, initial_price: 0, renewal_price: renewal, trial_period_days: 7, plan_type: "renewal", visibility: "visible", title: null, stock: 0, unlimited_stock: true, strike_through_initial_price: null, strike_through_renewal_price: null, purchase_url: `https://whop.com/checkout/${id}` });
const whopState: any = {
  products: { [BIZ]: [
    { id: "prod_T1", title: "Vouch Live", route: "vouch-live", visibility: "visible", account: { id: BIZ, route: BIZ } },
    { id: "prod_T2", title: "No Route", route: null, visibility: "hidden", account: { id: BIZ, route: BIZ }, purchase_url: "https://whop.com/checkout/plan_z" },
  ], [BIZ2]: [] },
  plans: { [BIZ]: [fakePlan("plan_p29", "prod_T1", 29), fakePlan("plan_p9", "prod_T1", 9)], [BIZ2]: [] },
  companies: { [BIZ]: { id: BIZ, route: "test-store", title: "Test Store" }, [BIZ2]: { id: BIZ2, route: "other-store", title: "Other" } },
};
const fakeWhop = Bun.serve({
  port: WHOP_PORT,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/.well-known/jwks.json") return Response.json({ keys: [{ kty: "EC", crv: "P-256", x: pubJwk.x, y: pubJwk.y, kid: "k1", alg: "ES256", use: "sig" }] });
    if (req.headers.get("authorization") !== `Bearer ${WHOP_KEY}` || req.headers.get("api-version-date") !== "2026-08-21-1") return Response.json({ error: { type: "unauthorized" } }, { status: 401 });
    let m = u.pathname.match(/^\/api\/v1\/companies\/(biz_\w+)$/);
    if (m) return whopState.companies[m[1]] ? Response.json(whopState.companies[m[1]]) : Response.json({ error: {} }, { status: 404 });
    if (u.pathname === "/api/v1/products") return Response.json({ data: whopState.products[u.searchParams.get("account_id") || ""] || [], page_info: { has_next_page: false } });
    if (u.pathname === "/api/v1/plans") return Response.json({ data: whopState.plans[u.searchParams.get("account_id") || ""] || [], page_info: { has_next_page: false } });
    m = u.pathname.match(/^\/api\/v1\/users\/(\w+)\/access\/(biz_\w+)$/);
    if (m) {
      if (m[1] === "user_forbidden") return Response.json({ error: { type: "forbidden" } }, { status: 403 });
      if (m[1] === "user_admin") return Response.json({ has_access: true, access_level: "admin" });
      return Response.json({ has_access: true, access_level: "customer" });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function mintWhop(payload: any) {
  const h = b64({ alg: "ES256", typ: "JWT", kid: "k1" }), p = b64(payload);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
}
const whopTok = (sub: string, extra: any = {}) => mintWhop({ iss: "urn:whopcom:exp-proxy", aud: APP_ID, sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...extra });
const signLink = (biz: string, user: string, expOffset = 600) => {
  const p = b64({ biz, user, exp: Math.floor(Date.now() / 1000) + expOffset });
  return `${p}.${new Bun.CryptoHasher("sha256", LINK_SECRET).update(p).digest("base64url")}`;
};

const sql = new SQL(DB);
await sql`drop table if exists listing_versions`; await sql`drop table if exists listings`;
const server = Bun.spawn(["bun", Bun.env.VOUCH_ENTRY || "/home/claude/vouch-v2/index.tsx"], {
  env: { ...Bun.env, PORT: String(PORT), DATABASE_URL: DB, CAPTURE_FIXTURES: MAP, DEV_KEYS: PRO, ADMIN_KEY: ADMIN, BASE_URL: `http://localhost:${PORT}`,
    WHOP_API_BASE: `http://localhost:${WHOP_PORT}`, WHOP_APP_API_KEY: WHOP_KEY, WHOP_APP_ID: APP_ID, LINK_SECRET },
  stdout: "pipe", stderr: "pipe",
});
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) break; } catch {} await Bun.sleep(200); }
// Free account with a known key (no Whop key locally, so insert it directly).
await sql`insert into accounts (key_hash, plan, status) values (${sha(FREE)}, 'free', 'active') on conflict (key_hash) do update set plan = 'free', status = 'active', checked_at = now()`;
// Start every run unlinked (a linked account only accepts its own business's listings).
await sql`update accounts set whop_biz_id = null, whop_user_id = null, linked_at = null`;

let pass = 0, fail = 0;
const ok = (name: string, cond: any, extra?: any) => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`); };
const call = async (method: string, path: string, key?: string, body?: any) => {
  const r = await fetch(`http://localhost:${PORT}${path}`, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};

try {
  // 1. capture our own listing
  const a = await call("POST", "/api/listings", PRO, { url: VOUCH });
  ok("add listing -> 201", a.status === 201, a.status);
  ok("default plan $9 renewal, 7-day trial", a.body?.version?.default_plan?.renewalPrice === 9 && a.body?.version?.default_plan?.trialDays === 7 && a.body?.version?.default_plan?.planType === "renewal", a.body?.version?.default_plan);
  ok("2 price options, note says only default captured", a.body?.version?.plans_count === 2 && /1 more/.test(a.body?.version?.note || ""), a.body?.version?.note);
  ok("title from page", a.body?.listing?.title === "Vouch — listing checks and dispute evidence", a.body?.listing?.title);
  const id = a.body.listing.id;

  // 2. same text again -> no new version
  const b = await call("POST", "/api/listings", PRO, { url: VOUCH });
  ok("repeat capture: unchanged, still version 1", b.body?.version?.changed === false && b.body?.version?.no === 1, b.body?.version);

  // 3. page HTML noise (embedded data changes, visible listing identical) -> unchanged
  await setMap({ [VOUCH]: `${F}/vouch-v1-noise.html`, [TOM]: `${F}/tom.html`, [RISKY]: `${F}/risky.html` });
  const r1 = await call("POST", `/admin/recheck?key=${ADMIN}`);
  ok("recheck with HTML noise only: unchanged", r1.body?.changed === 0 && r1.body?.unchanged === 1, r1.body);

  // 4. real wording change -> version 2, chained
  await setMap({ [VOUCH]: `${F}/vouch-v2.html`, [TOM]: `${F}/tom.html`, [RISKY]: `${F}/risky.html` });
  const r2 = await call("POST", `/admin/recheck?key=${ADMIN}`);
  ok("recheck after edit: 1 changed", r2.body?.changed === 1, r2.body);
  const v = await call("GET", `/api/listings/${id}/versions`, PRO);
  ok("pro sees 2 versions", v.body?.stored === 2 && v.body?.visible === 2, { stored: v.body?.stored, visible: v.body?.visible });
  ok("both versions intact", v.body?.versions?.every((x: any) => x.intact), v.body?.versions?.map((x: any) => x.intact));
  ok("version 2 holds the new sentence", /VOUCH-TEST/.test(v.body?.versions?.[0]?.text || ""));
  const rows = await sql`select version_no, prev_hash, seal_hash from listing_versions where listing_id = ${id} order by version_no`;
  ok("v2.prev_hash = v1.seal_hash", rows[1].prev_hash === rows[0].seal_hash);
  ok("listing text cut before 'Powered by Whop', chrome dropped", !/Powered by Whop|Sign in|For enterprise/.test(v.body.versions[1].text) && /Check your claims before buyers do/.test(v.body.versions[1].text), v.body.versions[1].text.slice(0, 60));

  // 5. second real-page shape (one-time price, scarcity line, reviews cut)
  const t = await call("POST", "/api/listings", PRO, { url: TOM });
  ok("tom listing: $600 one-time, scarcity kept, reviews cut", t.body?.version?.default_plan?.initialPrice === 600 && t.body?.version?.default_plan?.planType === "one_time", t.body?.version?.default_plan);
  const tv = await call("GET", `/api/listings/${t.body.listing.id}/versions`, PRO);
  ok("tom text has 'Less than 2 remaining', no review text", /Less than 2 remaining/.test(tv.body.versions[0].text) && !/game-changer/.test(tv.body.versions[0].text), tv.body.versions[0].text.replace(/\n/g, " | "));

  // 6. risk check (no account, stores nothing)
  const before = (await sql`select count(*)::int as n from listing_versions`)[0].n;
  const rc = await call("POST", "/api/risk-check", undefined, { url: RISKY });
  const after = (await sql`select count(*)::int as n from listing_versions`)[0].n;
  const find = (s: string) => rc.body?.claims?.find((c: any) => c.text.includes(s));
  ok("risk-check stores nothing", rc.status === 200 && before === after, { status: rc.status, before, after });
  ok("'Make $5,000 in 30 days' -> income + time", JSON.stringify(find("Make $5,000")?.flags) === JSON.stringify(["income", "time"]), find("Make $5,000")?.flags);
  ok("'100% guaranteed results' -> guarantee", find("100% guaranteed")?.flags?.includes("guarantee"), find("100% guaranteed")?.flags);
  ok("plain feature bullet unflagged", find("Step-by-step video lessons")?.flags?.length === 0, find("Step-by-step")?.flags);
  ok("'Anyone can do this' -> absolute", find("Anyone can")?.flags?.includes("absolute"), find("Anyone can")?.flags);
  ok("'Members earn $300 a day' -> income", find("earn $300")?.flags?.includes("income"), find("earn $300")?.flags);
  ok("verb 'guarantees results' still flagged", find("system guarantees results")?.flags?.includes("guarantee"), find("system guarantees results")?.flags);
  ok("'30-day money-back guarantee' flagged", find("money-back guarantee")?.flags?.includes("guarantee"), find("money-back guarantee")?.flags);
  ok("suggestions present on flagged claims", !!find("Make $5,000")?.suggestion);
  // our own listing should not flag its price line or quoted words
  const own = await call("POST", "/api/risk-check", undefined, { url: VOUCH });
  const ownFlagged = own.body?.claims?.filter((c: any) => c.flags.length).map((c: any) => [c.text, c.flags]);
  ok("own listing: price line and quoted 'always'/'never' not flagged", !ownFlagged.some((x: any) => /Starter \(\$9\/mo\)|words like/.test(x[0])), ownFlagged);
  const bad = await call("POST", "/api/risk-check", undefined, { url: "https://evil.example.com/x" });
  ok("non-whop URL rejected", bad.status === 400, bad.body);

  // 7. free plan: 1 listing, latest version only
  const f1 = await call("POST", "/api/listings", FREE, { url: VOUCH });
  ok("free: first listing ok", f1.status === 201, f1.status);
  const f2 = await call("POST", "/api/listings", FREE, { url: TOM });
  ok("free: second listing -> 402", f2.status === 402, f2.body?.error);
  await setMap({ [VOUCH]: `${F}/vouch-v1.html`, [TOM]: `${F}/tom.html`, [RISKY]: `${F}/risky.html` });
  await call("POST", `/admin/recheck?key=${ADMIN}`);
  const fv = await call("GET", `/api/listings/${f1.body.listing.id}/versions`, FREE);
  ok("free sees latest only, history stored", fv.body?.stored === 2 && fv.body?.visible === 1 && /Upgrade/.test(fv.body?.note || ""), { stored: fv.body?.stored, visible: fv.body?.visible, note: fv.body?.note });
  const other = await call("GET", `/api/listings/${id}/versions`, FREE);
  ok("free can't read another account's listing", other.status === 404);

  // 8. failures -> stale after 2
  await setMap({ [TOM]: `${F}/tom.html`, [RISKY]: `${F}/risky.html` }); // VOUCH missing => fetch fails
  await call("POST", `/admin/recheck?key=${ADMIN}`);
  let st = (await sql`select status, fail_count from listings where id = ${id}`)[0];
  ok("1 failure: still active", st.status === "active" && st.fail_count === 1, st);
  await call("POST", `/admin/recheck?key=${ADMIN}`);
  st = (await sql`select status, fail_count from listings where id = ${id}`)[0];
  ok("2 failures: stale", st.status === "stale" && st.fail_count === 2, st);
  await setMap({ [VOUCH]: `${F}/vouch-v1.html`, [TOM]: `${F}/tom.html`, [RISKY]: `${F}/risky.html` });
  await call("POST", `/admin/recheck?key=${ADMIN}`);
  st = (await sql`select status, fail_count from listings where id = ${id}`)[0];
  ok("recovers to active after a good check", st.status === "active" && st.fail_count === 0, st);

  // 9. paste fallback labelled
  await setMap({ [TOM]: `${F}/tom.html` });
  const pasted = await call("POST", "/api/listings", PRO, { url: "https://whop.com/demo/ecom-launch-lab/", text: "Our course teaches store setup.\nMake $1,000 your first week." });
  ok("unreadable page + pasted text -> entered_by_seller", pasted.status === 201 && pasted.body?.version?.source === "entered_by_seller", pasted.body?.version);

  // 10. v1 still works: old record verifies, new review seals onto the shared chain
  const old = await call("GET", "/verify/2L5B6K");
  ok("old v1 record 2L5B6K still intact", old.body?.intact === true, old.body?.intact);
  const head = (await sql`select seal_hash from (select seal_hash, sealed_at from reviews where seal_hash is not null union all select seal_hash, sealed_at from listing_versions) s order by sealed_at desc limit 1`)[0].seal_hash;
  const rv = await call("POST", "/api/reviews", PRO, { title: "Chain test", content: "This product includes ten lessons. Each lesson is under fifteen minutes." });
  const rid = rv.body.id; const tok = new URL(rv.body.review_url).searchParams.get("t");
  const sealed = await call("POST", `/api/reviews/${rid}/seal`, undefined, { token: tok, verdicts: [{ idx: 0, verdict: "confirm" }, { idx: 1, verdict: "confirm" }] });
  const nr = await call("GET", `/verify/${sealed.body.code}`);
  ok("new v1 review seals and verifies", nr.body?.intact === true);
  ok("new review chains onto latest listing version", nr.body?.prev_hash === head, { prev: nr.body?.prev_hash?.slice(0, 10), head: head.slice(0, 10) });
  const ev = await fetch(`http://localhost:${PORT}/v/${sealed.body.code}`).then((r) => r.status);
  ok("v1 evidence page renders", ev === 200, ev);
  for (const path of ["/", "/app", "/registry", "/health"]) { const s = (await fetch(`http://localhost:${PORT}${path}`)).status; ok(`GET ${path} 200`, s === 200, s); }
  const mcp = await call("POST", `/mcp?key=${PRO}`, undefined, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  ok("MCP tools/list still works", Array.isArray(mcp.body?.result?.tools), mcp.status);

  // ---------- 11. price and stock lines in the captured text (change 1) ----------
  const TOML = "https://whop.com/tomwbtc/products/url-service-live/";
  const VL = "https://whop.com/vouch-sealed-proof/vouch-live/";
  const URG = "https://whop.com/demo/cohort-coaching/";
  const live = (tomFile: string) => setMap({ [TOML]: `${F}/${tomFile}`, [VL]: `${F}/vouch-live.html`, [URG]: `${F}/urgent.html`, [VOUCH]: `${F}/vouch-v1.html`, [TOM]: `${F}/tom.html` });
  await live("tom-live.html");
  const rcx = async (u: string, ip: string) => {
    const r = await fetch(`http://localhost:${PORT}/api/risk-check`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ url: u }) });
    return { status: r.status, retryAfter: r.headers.get("retry-after"), body: await r.json().catch(() => null) as any };
  };
  const tl = await rcx(TOML, "198.51.100.1");
  const tlLines = String(tl.body?.text || "").split("\n");
  ok("live-shape tom: risk-check returns text with structured price first", tlLines[0] === "Price: $600 one-time" && tlLines[1] === "Price options on page: 1", tlLines.slice(0, 2));
  ok("live-shape tom: '$600' and 'Less than 2 remaining' kept in text", tlLines.includes("$600") && tlLines.includes("Less than 2 remaining"), tlLines);
  ok("live-shape tom: Buy now / Add to cart / rating / avatar initials dropped", !tlLines.some((l) => /^(Buy now|Add to cart|TW|TW .*|5\.0 \( 4 \))$/.test(l)) && tlLines.includes("Thomas Woodcock"), tlLines);
  ok("risk-check listing_hash = sha256(text)", tl.body?.listing_hash === sha(tl.body?.text || ""));
  ok("header lines are not offered as claims", !tl.body?.claims?.some((c: any) => /^Price/.test(c.text)), tl.body?.claims?.map((c: any) => c.text));
  await live("tom-live-chrome.html");
  const tc = await rcx(TOML, "198.51.100.1");
  ok("Whop chrome changes (rating count, CTA wording, +options) keep the hash", tc.body?.listing_hash === tl.body?.listing_hash, { a: tl.body?.listing_hash?.slice(0, 10), b: tc.body?.listing_hash?.slice(0, 10) });
  await live("tom-live-650.html");
  const t650 = await rcx(TOML, "198.51.100.1");
  ok("price change changes the hash and the price line", t650.body?.listing_hash !== tl.body?.listing_hash && t650.body?.text?.startsWith("Price: $650 one-time\n"), t650.body?.text?.split("\n")[0]);
  const vl = await rcx(VL, "198.51.100.1");
  const vlLines = String(vl.body?.text || "").split("\n");
  ok("live-shape vouch: 'Price: $9 / month, 7-day trial' + 'Price options on page: 2'", vlLines[0] === "Price: $9 / month, 7-day trial" && vlLines[1] === "Price options on page: 2", vlLines.slice(0, 2));
  ok("live-shape vouch: sticky purchase bar not repeated, buttons dropped, avatar 'V' dropped", vlLines.filter((l) => l === "$9 / month").length === 1 && vlLines.filter((l) => l === "7 day trial").length === 1 && !vlLines.some((l) => /^(\+1 option|Start free trial|Add to cart|V Vouch)$/.test(l)) && vlLines[vlLines.length - 1].startsWith("Members can join"), vlLines);
  // stored versions: price change => new sealed version, chrome change => none
  await live("tom-live.html");
  const ta = await call("POST", "/api/listings", PRO, { url: TOML });
  ok("add live-shape tom listing", ta.status === 201, ta.status);
  await live("tom-live-chrome.html");
  const rr1 = await call("POST", `/admin/recheck?key=${ADMIN}`);
  let tvs = await call("GET", `/api/listings/${ta.body.listing.id}/versions`, PRO);
  ok("recheck after chrome-only change: still 1 version", tvs.body?.stored === 1, { stored: tvs.body?.stored, recheck: rr1.body });
  await live("tom-live-650.html");
  await call("POST", `/admin/recheck?key=${ADMIN}`);
  tvs = await call("GET", `/api/listings/${ta.body.listing.id}/versions`, PRO);
  ok("recheck after price change: version 2 sealed with new price line, both intact", tvs.body?.stored === 2 && tvs.body.versions[0].text.startsWith("Price: $650 one-time") && tvs.body.versions.every((x: any) => x.intact), { stored: tvs.body?.stored, first: tvs.body?.versions?.[0]?.text?.split("\n")[0] });
  await call("POST", `/admin/recheck?key=${ADMIN}`);
  tvs = await call("GET", `/api/listings/${ta.body.listing.id}/versions`, PRO);
  ok("second recheck with same page: no new version", tvs.body?.stored === 2, tvs.body?.stored);

  // ---------- 12. scarcity flag (change 2) ----------
  const ug = await rcx(URG, "198.51.100.2");
  const uf = (s: string) => ug.body?.claims?.find((c: any) => c.text.includes(s));
  for (const s of ["Only 3 spots left", "Limited spots", "Doors closing soon", "price goes up", "Last chance"]) ok(`'${s}' -> scarcity`, uf(s)?.flags?.includes("scarcity"), uf(s)?.flags);
  ok("Whop's own 'Less than 3 remaining' line not flagged", !!uf("Less than 3 remaining") && uf("Less than 3 remaining").flags.length === 0, uf("Less than 3 remaining"));
  ok("plain feature line not flagged", uf("Weekly group calls")?.flags?.length === 0, uf("Weekly group calls")?.flags);
  ok("scarcity suggestion present", /Urgency/.test(uf("Only 3 spots left")?.suggestion || ""));
  ok("renewal with trial price line", ug.body?.text?.startsWith("Price: $49 / month, 3-day trial\nPrice options on page: 3\n"), ug.body?.text?.split("\n").slice(0, 2));

  // ---------- 13. risk-check rate limit (change 3) ----------
  const statuses: number[] = [];
  let last: any = null;
  for (let i = 0; i < 11; i++) { last = await rcx("https://evil.example.com/x", "203.0.113.50"); statuses.push(last.status); }
  ok("10 checks allowed, 11th from same IP -> 429", statuses.slice(0, 10).every((s) => s !== 429) && statuses[10] === 429, statuses);
  ok("429 has Retry-After (seconds, <= 3600) and a plain-words message", Number(last.retryAfter) > 0 && Number(last.retryAfter) <= 3600 && /try again in about \d+ minutes?/.test(last.body?.error || ""), { retryAfter: last.retryAfter, error: last.body?.error });
  ok("uses the LAST x-forwarded-for address: spoofed first entry doesn't reset the limit", (await rcx("https://evil.example.com/x", "10.9.9.9, 203.0.113.50")).status === 429);
  ok("different last x-forwarded-for address -> allowed", (await rcx("https://evil.example.com/x", "203.0.113.50, 203.0.113.51")).status === 400);
  // without x-forwarded-for it falls back to the connection IP; 3 earlier calls in this run had no header
  const noXff: number[] = [];
  for (let i = 0; i < 8; i++) noXff.push((await call("POST", "/api/risk-check", undefined, { url: "https://evil.example.com/x" })).status);
  ok("no x-forwarded-for: connection IP limited (7 more allowed, then 429)", noXff.slice(0, 7).every((s) => s === 400) && noXff[7] === 429, noXff);

  // ---------- 14. Connect your Whop ----------
  await setMap({ [PRODUCT_URL]: `${F}/vouch-live.html`, [VOUCH]: `${F}/vouch-v1.html`, [TOM]: `${F}/tom.html` });
  const dash = async (biz: string, token?: string) => {
    const r = await fetch(`http://localhost:${PORT}/whop/dashboard/${biz}`, { headers: token ? { "x-whop-user-token": token } : {} });
    return { status: r.status, csp: r.headers.get("content-security-policy"), xfo: r.headers.get("x-frame-options"), body: await r.text() };
  };
  const d0 = await dash(BIZ);
  ok("dashboard: no token -> 401 (framable)", d0.status === 401 && d0.csp === "frame-ancestors https://whop.com https://*.whop.com", { status: d0.status, csp: d0.csp });
  ok("dashboard: garbage token -> 401", (await dash(BIZ, "a.b.c")).status === 401);
  ok("dashboard: wrong aud -> 401", (await dash(BIZ, await whopTok("user_admin", { aud: "app_other" }))).status === 401);
  ok("dashboard: wrong iss -> 401", (await dash(BIZ, await whopTok("user_admin", { iss: "x" }))).status === 401);
  ok("dashboard: valid token, not admin -> 403", (await dash(BIZ, await whopTok("user_member"))).status === 403);
  const d1 = await dash(BIZ, await whopTok("user_admin"));
  ok("dashboard: admin -> 200, CSP frame-ancestors, no X-Frame-Options", d1.status === 200 && d1.csp === "frame-ancestors https://whop.com https://*.whop.com" && !d1.xfo, { status: d1.status, csp: d1.csp, xfo: d1.xfo });
  ok("dashboard: products + price options + new-tab link + inline key fallback", /Vouch Live/.test(d1.body) && /\$29 \/ 30 days, 7-day trial/.test(d1.body) && /\$9 \/ 30 days/.test(d1.body) && /target="_blank"[^>]*>Link to Vouch|href="[^"]*\/link\?t=[^"]+" target="_blank"/.test(d1.body) && /Link with my Vouch key/.test(d1.body) && /https:\/\/whop\.com\/test-store\/vouch-live\//.test(d1.body));
  const linkTok = decodeURIComponent((d1.body.match(/\/link\?t=([^"&]+)/) || [])[1] || "");
  ok("dashboard: link token present and payload = {biz, user, exp ~ now+10min}", (() => { try { const p = JSON.parse(Buffer.from(linkTok.split(".")[0], "base64url").toString()); return p.biz === BIZ && p.user === "user_admin" && Math.abs(p.exp - (Date.now() / 1000 + 600)) < 30; } catch { return false; } })());
  ok("dashboard: access endpoint 403 -> fallback (app installed) -> 200", (await dash(BIZ, await whopTok("user_forbidden"))).status === 200);
  ok("GET /link renders key prompt with /app wording", await fetch(`http://localhost:${PORT}/link?t=x`).then(async (r) => r.status === 200 && /Your Vouch key is the license key from your Whop purchase/.test(await r.text())));

  ok("api/link: no key -> 401", (await call("POST", "/api/link", undefined, { t: linkTok })).status === 401);
  const tampered = `${b64({ biz: BIZ2, user: "user_admin", exp: Math.floor(Date.now() / 1000) + 600 })}.${linkTok.split(".")[1]}`;
  ok("api/link: tampered token -> 400", (await call("POST", "/api/link", PRO, { t: tampered })).status === 400);
  const expd = await call("POST", "/api/link", PRO, { t: signLink(BIZ, "user_admin", -5) });
  ok("api/link: expired token -> 400 with plain message", expd.status === 400 && /expired/.test(expd.body?.error || ""), expd.body);
  ok("api/whop/products before linking -> 409 connect message", await call("GET", "/api/whop/products", PRO).then((r) => r.status === 409 && /Connect your Whop/.test(r.body?.error || "")));
  ok("listings {product_id} before linking -> 403 connect message", await call("POST", "/api/listings", FREE, { product_id: "prod_T1" }).then((r) => r.status === 403 && /Connect your Whop/.test(r.body?.error || "")));
  const lk = await call("POST", "/api/link", PRO, { t: linkTok });
  ok("api/link: valid token + key -> linked", lk.status === 200 && lk.body?.biz === BIZ, lk.body);
  const acctRow = (await sql`select whop_biz_id, whop_user_id, linked_at from accounts where key_hash = ${sha(PRO)}`)[0];
  ok("account stores whop_biz_id, whop_user_id, linked_at", acctRow.whop_biz_id === BIZ && acctRow.whop_user_id === "user_admin" && !!acctRow.linked_at, acctRow);
  ok("api/me shows linked business", (await call("GET", "/api/me", PRO)).body?.whop?.biz === BIZ);
  const wp = await call("GET", "/api/whop/products", PRO);
  const p1 = wp.body?.products?.find((x: any) => x.id === "prod_T1");
  ok("api/whop/products: products with URL and all plans", wp.status === 200 && wp.body.products.length === 2 && wp.body.plans.length === 2 && p1?.url === PRODUCT_URL && p1?.price_options?.length === 2, { status: wp.status, p1 });

  const lp = await call("POST", "/api/listings", PRO, { product_id: "prod_T1" });
  const lpText = String(lp.body?.text || "");
  ok("listings {product_id}: 201, owner_verified, both price-option lines in text", lp.status === 201 && lp.body?.listing?.owner_verified === true && lpText.includes("Price option: $9 / 30 days, 7-day trial") && lpText.includes("Price option: $29 / 30 days, 7-day trial") && lp.body?.version?.plans_count === 2 && !lp.body?.version?.note, { status: lp.status, listing: lp.body?.listing, head: lpText.split("\n").slice(0, 5) });
  ok("price-option lines are not offered as claims", !lp.body?.claims?.some((c: any) => /^Price/.test(c.text)));
  const lpv = await call("GET", `/api/listings/${lp.body.listing.id}/versions`, PRO);
  const lpRow = (await sql`select listing_hash, text, plans, sealed_payload from listing_versions where listing_id = ${lp.body.listing.id}`)[0];
  ok("owner-verified version intact; plans in hash (text) and sealed payload", lpv.body?.versions?.[0]?.intact === true && lpRow.listing_hash === sha(lpRow.text) && JSON.parse(lpRow.sealed_payload).plans?.length === 2 && JSON.parse(lpRow.plans).length === 2, lpv.body?.versions?.[0]?.intact);
  ok("listings {product_id} without a public route -> 422", (await call("POST", "/api/listings", PRO, { product_id: "prod_T2" })).status === 422);
  ok("listings {product_id} not in linked business -> 404", (await call("POST", "/api/listings", PRO, { product_id: "prod_nope" })).status === 404);
  const otherUrl = await call("POST", "/api/listings", PRO, { url: "https://whop.com/someone/else-product/" });
  ok("linked account, {url} from another business -> rejected with connect message", otherUrl.status === 403 && /connect the Whop business/.test(otherUrl.body?.error || ""), otherUrl.body);
  const alias = await call("POST", "/api/listings", PRO, { url: "https://whop.com/another-alias/vouch-live/" });
  ok("linked account, {url} of own product -> owner_verified, same listing", alias.status === 200 && alias.body?.listing?.owner_verified === true && alias.body?.listing?.id === lp.body.listing.id, alias.body?.listing);
  ok("unlinked account, {url} with owner_verified:true -> 403 connect message", (await call("POST", "/api/listings", FREE, { url: VOUCH, owner_verified: true })).status === 403);

  whopState.plans[BIZ][0].renewal_price = 39; // seller changes a price in Whop
  const rcp = await call("POST", `/admin/recheck?key=${ADMIN}`);
  const lpv2 = await call("GET", `/api/listings/${lp.body.listing.id}/versions`, PRO);
  ok("daily recheck refreshes plans via API: new sealed version with $39 line", rcp.body?.plans_refreshed >= 1 && lpv2.body?.stored === 2 && lpv2.body.versions[0].text.includes("Price option: $39 / 30 days, 7-day trial") && !lpv2.body.versions[0].text.includes("$29 / 30 days") && lpv2.body.versions.every((x: any) => x.intact), { recheck: rcp.body, stored: lpv2.body?.stored });
  await call("POST", `/admin/recheck?key=${ADMIN}`);
  ok("recheck again, same plans: no new version", (await call("GET", `/api/listings/${lp.body.listing.id}/versions`, PRO)).body?.stored === 2);

  const relink = await call("POST", "/api/link", PRO, { t: signLink(BIZ2, "user_admin") });
  const ov = (await sql`select owner_verified from listings where id = ${lp.body.listing.id}`)[0];
  ok("relink to another business replaces it and clears old owner_verified", relink.status === 200 && relink.body?.relinked === true && ov.owner_verified === false && (await call("GET", "/api/me", PRO)).body?.whop?.biz === BIZ2, { relink: relink.body, ov });
} catch (e) {
  fail++; console.log("ERROR", e);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  fakeWhop.stop(true);
  server.kill();
  const err = await new Response(server.stderr).text();
  if (err.trim()) console.log("server stderr:", err.slice(0, 1500));
  const out = await new Response(server.stdout).text();
  const whopLines = out.split("\n").filter((l) => /^(whop-dashboard|api-link)/.test(l));
  if (whopLines.length) console.log("server whop log lines:\n" + whopLines.join("\n"));
}

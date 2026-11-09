// Unit tests: Whop JWT verify (local ES256 key + fake JWKS), signed link token, product URL, plan lines,
// version diff, headline variants, supporting-file checks and seals, page escaping.
// Imports index.tsx with VOUCH_UNIT_TEST=1, so no database or server is started.
const JWKS_PORT = 3997;
const KID = "test-kid-1";
const APP = "app_unit_test";
const SECRET = "unit-link-secret-0123456789abcdef";

const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const other = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
let jwksHits = 0;
const jwksServer = Bun.serve({
  port: JWKS_PORT,
  fetch() { jwksHits++; return Response.json({ keys: [{ kty: "EC", crv: "P-256", x: pub.x, y: pub.y, kid: KID, alg: "ES256", use: "sig" }] }); },
});

Object.assign(Bun.env, { VOUCH_UNIT_TEST: "1", WHOP_APP_ID: APP, LINK_SECRET: SECRET, WHOP_JWKS_URL: `http://localhost:${JWKS_PORT}/jwks.json` });
const V = await import(Bun.env.VOUCH_ENTRY || "../index.tsx");

const b64 = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
async function mint(payload: any, opts: { header?: any; key?: CryptoKey } = {}) {
  const h = b64(opts.header ?? { alg: "ES256", typ: "JWT", kid: KID });
  const p = b64(payload);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, opts.key ?? kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
}
const now = Math.floor(Date.now() / 1000);
const good = { iss: "urn:whopcom:exp-proxy", aud: APP, sub: "user_abc123", iat: now, exp: now + 300 };

let pass = 0, fail = 0;
const ok = (name: string, cond: any, extra?: any) => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`); };

try {
  // ----- JWT -----
  let r: any = await V.verifyWhopToken(await mint(good));
  ok("jwt: valid ES256 token -> ok, sub", r.ok && r.sub === "user_abc123", r);
  r = await V.verifyWhopToken(await mint({ ...good, aud: "app_someone_else" }));
  ok("jwt: wrong aud rejected with reason", !r.ok && /wrong aud/.test(r.reason), r);
  r = await V.verifyWhopToken(await mint({ ...good, aud: [APP, "x"] }));
  ok("jwt: aud array containing app id accepted", r.ok, r);
  r = await V.verifyWhopToken(await mint({ ...good, iss: "someone" }));
  ok("jwt: wrong iss rejected", !r.ok && /wrong iss/.test(r.reason), r);
  r = await V.verifyWhopToken(await mint({ ...good, exp: now - 3600 }));
  ok("jwt: expired rejected", !r.ok && r.reason === "expired", r);
  r = await V.verifyWhopToken(await mint({ ...good, sub: undefined }));
  ok("jwt: missing sub rejected", !r.ok && r.reason === "no sub", r);
  const t = await mint(good);
  const [h, p, s] = t.split(".");
  r = await V.verifyWhopToken(`${h}.${b64({ ...good, sub: "user_attacker" })}.${s}`);
  ok("jwt: tampered payload -> bad signature", !r.ok && r.reason === "bad signature", r);
  r = await V.verifyWhopToken(await mint(good, { key: other.privateKey }));
  ok("jwt: signed by a different key -> bad signature", !r.ok && r.reason === "bad signature", r);
  r = await V.verifyWhopToken(`${b64({ alg: "none", kid: KID })}.${p}.`);
  ok("jwt: alg none rejected", !r.ok, r);
  r = await V.verifyWhopToken(`${b64({ alg: "HS256", kid: KID })}.${p}.${s}`);
  ok("jwt: alg HS256 rejected", !r.ok && /bad alg/.test(r.reason), r);
  r = await V.verifyWhopToken(await mint(good, { header: { alg: "ES256", kid: "nope" } }));
  ok("jwt: unknown kid rejected", !r.ok && /unknown kid/.test(r.reason), r);
  r = await V.verifyWhopToken("garbage");
  ok("jwt: malformed rejected", !r.ok && /malformed/.test(r.reason), r);
  ok("jwt: JWKS cached (fetched once across all checks)", jwksHits === 1 && V._jwksFetches() === 1, { jwksHits });

  // ----- signed link token -----
  const lt = V.signLinkToken("biz_ABC123", "user_abc123");
  let l: any = V.verifyLinkToken(lt);
  ok("link: round trip", l.ok && l.biz === "biz_ABC123" && l.user === "user_abc123", l);
  const payload = JSON.parse(Buffer.from(lt.split(".")[0], "base64url").toString());
  ok("link: exp = now + 10 min", Math.abs(payload.exp - (now + V.LINK_TTL_SECONDS)) <= 2 && V.LINK_TTL_SECONDS === 600, payload);
  l = V.verifyLinkToken(`${b64({ ...payload, biz: "biz_EVIL999" })}.${lt.split(".")[1]}`);
  ok("link: tampered payload -> bad signature", !l.ok && l.reason === "bad signature", l);
  l = V.verifyLinkToken(`${lt.split(".")[0]}.${lt.split(".")[1].slice(0, -2)}AA`);
  ok("link: tampered signature -> bad signature", !l.ok && l.reason === "bad signature", l);
  l = V.verifyLinkToken(lt, { now: Date.now() + 11 * 60 * 1000 });
  ok("link: expired after 10 minutes", !l.ok && l.reason === "expired", l);
  l = V.verifyLinkToken(V.signLinkToken("biz_ABC123", "u", { secret: "another-secret" }));
  ok("link: other secret -> bad signature", !l.ok && l.reason === "bad signature", l);
  l = V.verifyLinkToken("abc");
  ok("link: malformed", !l.ok && l.reason === "malformed", l);

  // ----- product -> public URL -----
  const prod = { id: "prod_TWuTQ3n38wGyf", route: "vouch-sealed-proof", account: { id: "biz_YVk8MWjn8ZlccE", route: "biz_YVk8MWjn8ZlccE" } };
  ok("url: company route + product route", V.productPublicUrl(prod, "vouch-aadb") === "https://whop.com/vouch-aadb/vouch-sealed-proof/", V.productPublicUrl(prod, "vouch-aadb"));
  ok("url: account.route that is a biz id is not used as store", V.productPublicUrl(prod, null) === null, V.productPublicUrl(prod, null));
  ok("url: product.company.route used when no company lookup", V.productPublicUrl({ ...prod, company: { route: "acme" } }, null) === "https://whop.com/acme/vouch-sealed-proof/");
  ok("url: no route, purchase_url product page used", V.productPublicUrl({ id: "p", purchase_url: "https://whop.com/acme/thing/?a=1" }, "acme") === "https://whop.com/acme/thing/");
  ok("url: no route, checkout purchase_url -> null", V.productPublicUrl({ id: "p", purchase_url: "https://whop.com/checkout/plan_1" }, "acme") === null);
  ok("url: productForUrl matches by product route (any store alias)", V.productForUrl("https://whop.com/vouch-sealed-proof/vouch-sealed-proof/", [prod])?.id === prod.id && V.productForUrl("https://whop.com/vouch-aadb/vouch-sealed-proof", [prod])?.id === prod.id);
  ok("url: productForUrl rejects other products", V.productForUrl("https://whop.com/tomwbtc/products/url-service/", [prod]) === null);

  // ----- plans -> text (shapes from the live API) -----
  const apiPlan = (o: any) => V.normalizePlan({ id: "plan_x", currency: "usd", product: { id: "prod_1" }, billing_period: 30, initial_price: 0, renewal_price: 29, trial_period_days: 7, plan_type: "renewal", visibility: "visible", title: null, stock: 0, unlimited_stock: true, strike_through_initial_price: null, strike_through_renewal_price: null, ...o });
  ok("plan: $29 / 30 days, 7-day trial", V.planLine(apiPlan({})) === "Price option: $29 / 30 days, 7-day trial", V.planLine(apiPlan({})));
  ok("plan: one-time", V.planLine(apiPlan({ plan_type: "one_time", billing_period: null, initial_price: 600, renewal_price: 0, trial_period_days: null })) === "Price option: $600 one-time");
  ok("plan: free", V.planLine(apiPlan({ plan_type: "one_time", billing_period: null, initial_price: 0, renewal_price: 0, trial_period_days: null })) === "Price option: Free");
  ok("plan: setup fee then renewal", V.planLine(apiPlan({ initial_price: 50, renewal_price: 20, trial_period_days: 0 })) === "Price option: $50 first payment, then $20 / 30 days");
  ok("plan: title, strike-through, limited stock, hidden", V.planLine(apiPlan({ title: "Pro", strike_through_renewal_price: 49, unlimited_stock: false, stock: 5, visibility: "hidden" })) === "Price option (Pro): $29 / 30 days, 7-day trial, was $49, stock 5, hidden", V.planLine(apiPlan({ title: "Pro", strike_through_renewal_price: 49, unlimited_stock: false, stock: 5, visibility: "hidden" })));
  ok("plan: money objects ({amount}) understood", V.planLine(apiPlan({ renewal_price: { currency: "usd", amount: "9.00" } })) === "Price option: $9 / 30 days, 7-day trial");
  const both = V.plansText([apiPlan({ id: "plan_b", renewal_price: 29 }), apiPlan({ id: "plan_a", renewal_price: 9 })]);
  ok("plans: sorted by price, one line each", both === "Price option: $9 / 30 days, 7-day trial\nPrice option: $29 / 30 days, 7-day trial", both);
  const cap = { text: "Price: $9 / month, 7-day trial\nPrice options on page: 2\nVouch\nBody line here.", listingHash: "x", plansCount: 2 };
  const wp = V.withPlans(cap, [apiPlan({ id: "plan_b", renewal_price: 29 }), apiPlan({ id: "plan_a", renewal_price: 9 })]);
  ok("withPlans: lines after header, hash recomputed", wp.text.split("\n").slice(2, 4).join("|") === "Price option: $9 / 30 days, 7-day trial|Price option: $29 / 30 days, 7-day trial" && wp.listingHash === new Bun.CryptoHasher("sha256").update(wp.text).digest("hex") && wp.plansCount === 2, wp.text);
  ok("withPlans: idempotent (re-applying doesn't duplicate)", V.withPlans(wp, wp.plans).text === wp.text);
  ok("stripHeader removes header and plan lines (not offered as claims)", V.stripHeader(wp.text) === "Vouch\nBody line here.", V.stripHeader(wp.text));

  // ----- version history: line diff -----
  const D = (a: string, b: string) => V.lineDiff(a ? a.split("\n") : [], b.split("\n")).map((d: any) => d.op + d.line).join("|");
  ok("diff: added, removed and unchanged lines", D("a\nb\nc", "a\nB\nc\nd") === " a|-b|+B| c|+d", D("a\nb\nc", "a\nB\nc\nd"));
  ok("diff: identical text -> no changes", D("x\ny", "x\ny") === " x| y");
  ok("diff: nothing before -> every line added", D("", "x\ny") === "+x|+y");
  ok("diff: moved line shows as removed + added", D("a\nb\nc", "b\nc\na") === "-a| b| c|+a", D("a\nb\nc", "b\nc\na"));
  const big = Array.from({ length: 2100 }, (_, i) => `line ${i}`);
  ok("diff: very long texts fall back without building a huge table", V.lineDiff(big, [...big, "new"]).length === 4201);

  // ----- headline test: variant cookie -----
  ok("variant: cookie A kept, not new", JSON.stringify(V.headlineVariant("vouch_hl=A")) === '{"v":"A","isNew":false}');
  ok("variant: cookie B among others kept", JSON.stringify(V.headlineVariant("x=1; vouch_hl=B; y=2")) === '{"v":"B","isNew":false}');
  ok("variant: unknown value or other cookie name -> new assignment", V.headlineVariant("vouch_hl=C").isNew && V.headlineVariant("notvouch_hl=A").isNew && V.headlineVariant(null).isNew);
  ok("variant: rand < 0.5 -> A, else B", V.headlineVariant(null, () => 0.49).v === "A" && V.headlineVariant(null, () => 0.5).v === "B");
  let nA = 0; for (let i = 0; i < 4000; i++) if (V.headlineVariant(null).v === "A") nA++;
  ok("variant: roughly 50/50 with Math.random", nA > 1800 && nA < 2200, nA);
  const BANNED = /\bverified\b|\bproof\b|dispute-proof|win disputes|prevents disputes|protects payouts|FTC compliant|Stand behind|records a month/i;
  const lA = V.landingPage("A"), lB = V.landingPage("B");
  ok("landing A: headline + dispute-math line", lA.includes(">Check your claims before buyers do.</h1>") && lA.includes("One dispute at 20 sales puts you at 5%, five times Whop's 1% limit."));
  ok("landing B: headline + sub-line", lB.includes(">Keep a dated record of what your listing promised.</h1>") && lB.includes("If a buyer disputes, you'll have the version they saw."));
  ok("landing: CTA to /check, disclaimer, no banned words, no green-check approval", lA.includes('href="/check?src=hero"') && lA.includes("Vouch doesn't decide disputes or give legal advice.") && !BANNED.test(lA) && !BANNED.test(lB));

  // ----- supporting files -----
  const H = "ab".repeat(32), claims = ["Make $1,000 your first week.", "Weekly group calls."];
  let a: any = V.checkAttachment({ claim: claims[0], name: " refund.pdf ", sha256: H.toUpperCase(), mime: "application/pdf", note: "n".repeat(280) }, claims);
  ok("attachment: valid input normalised (sha lowercased, name trimmed, 280-char note ok)", a.sha256 === H && a.name === "refund.pdf" && a.note.length === 280 && a.mime === "application/pdf", a);
  ok("attachment: empty note -> null", V.checkAttachment({ claim: claims[1], name: "x", sha256: H, note: "  " }, claims).note === null);
  ok("attachment: 281-char note rejected", /280/.test(V.checkAttachment({ claim: claims[0], name: "x", sha256: H, note: "n".repeat(281) }, claims).error || ""));
  ok("attachment: claim must be on the version", !!V.checkAttachment({ claim: "Something else.", name: "x", sha256: H }, claims).error);
  ok("attachment: bad sha / missing name rejected", !!V.checkAttachment({ claim: claims[0], name: "x", sha256: "zz" }, claims).error && !!V.checkAttachment({ claim: claims[0], sha256: H }, claims).error);
  const f: any = { id: "F1", listing_id: "L1", version_id: "V1", claim: claims[0], name: "refund.pdf", sha256: H, mime: null, note: "terms", attached_at: new Date("2026-11-10T12:00:00Z"), prev_hash: "p".repeat(64) };
  f.sealed_payload = V.filePayload(f, "vseal"); f.seal_hash = new Bun.CryptoHasher("sha256").update(f.prev_hash + f.sealed_payload).digest("hex");
  ok("file seal: intact round trip, payload links the version seal", V.fileIntact(f, "vseal") && JSON.parse(f.sealed_payload).version_seal_hash === "vseal" && JSON.parse(f.sealed_payload).kind === "supporting_file");
  ok("file seal: edited note or different version seal -> not intact", !V.fileIntact({ ...f, note: "edited" }, "vseal") && !V.fileIntact(f, "other-seal"));

  // ----- page fragments escape listing text -----
  const evil = "<script>alert(1)</script>";
  const cr = V.checkResultHtml(evil, `Price: $9 / month\n${evil}`, [{ text: evil, flags: ["income"], suggestion: evil }, { text: "plain " + evil, flags: [], suggestion: null }]);
  ok("/check result: title, price, claims and suggestions escaped", !cr.includes("<script>") && cr.includes("&lt;script&gt;") && cr.includes("Price: $9 / month") && cr.includes('class="pill amb">Income figure') && cr.includes('class="small dim">plain'));
  const lst = { id: "L1", url: "https://whop.com/a/b/", title: evil, status: "active" };
  const row = (no: number, text: string) => ({ id: "V" + no, version_no: no, text, listing_hash: "x", source: "captured", first_seen_at: new Date(), last_seen_at: new Date(), sealed_at: new Date(), seal_hash: "s".repeat(64), prev_hash: "" });
  const rows = [row(3, "Price: $9 / month\nnew line\nsame line"), row(2, "Price: $9 / month\nold line\nsame line"), row(1, "Price: $9 / month\nfirst")];
  const paidH = V.historyHtml({ listing: lst, rows, files: [], paid: true });
  ok("history (paid): every version, diff marks, title escaped", /Version 3[\s\S]*Version 2[\s\S]*Version 1/.test(paidH) && paidH.includes("<ins>new line</ins>") && paidH.includes("<del>old line</del>") && !paidH.includes("<script>") && paidH.includes('<form class="att stack"'));
  const freeH = V.historyHtml({ listing: lst, rows, files: [], paid: false });
  ok("history (free): latest only, '2 earlier versions stored; upgrade to open them', no diff, no form", freeH.includes("Version 3") && !freeH.includes("Version 2") && freeH.includes("2 earlier versions stored; upgrade to open them") && !/<ins>|<del>/.test(freeH) && !freeH.includes('class="att'));

  // ----- rate limiter address -----
  const req = (xff?: string) => new Request("http://x/", { headers: xff ? { "x-forwarded-for": xff } : {} });
  ok("clientIp: last x-forwarded-for entry", V.clientIp(req("6.6.6.6, 1.2.3.4"), "9.9.9.9") === "1.2.3.4");
  ok("clientIp: falls back to connection IP", V.clientIp(req(), "9.9.9.9") === "9.9.9.9");
} catch (e) {
  fail++; console.log("ERROR", e);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  jwksServer.stop(true);
  process.exit(fail ? 1 : 0);
}

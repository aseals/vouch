// Unit tests for "Connect your Whop": JWT verify (local ES256 key + fake JWKS), signed link token, product URL, plan lines.
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

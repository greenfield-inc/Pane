// Browser walk over tailnet HTTPS with NO forwarder: group link → join → review page with both frames →
// a saved note (written to the Session's local Postgres). Chromium or WebKit (Safari's engine).
// usage: node taste-walk.cjs <group.json (0600)> <out-dir> [chromium|webkit]
// env: REVIEWER (reviewer name shown in the study), NOTE (the saved note; mark test notes as tests),
//      PW_MODULE (path to a playwright package).
// Adapted from the p5-taste-https kit (same 13 checks); written for montlakev2's taste app.
// Reads link/password from the group file and prints neither.
const pw = require(process.env.PW_MODULE || "/home/agent/montlakev2/node_modules/playwright");
const fs = require("fs");
const g = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = process.argv[3] || ".";
const engine = process.argv[4] || "chromium";
const PAGES = new URL(g.pagesOrigin);
fs.mkdirSync(out, { recursive: true });
const results = [];
const ok = (name, pass, detail = "") => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} [${engine}] ${name}${detail ? " — " + detail : ""}`); };
(async () => {
  const b = await pw[engine].launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const failed = [];
  p.on("requestfailed", (r) => failed.push(`${r.url().replace(/[?&]s=[^&]+/, "")} ${r.failure()?.errorText}`));
  console.log(`[${engine}] ${b.version()} · UA ${await p.evaluate(() => navigator.userAgent)}`);
  const t0 = Date.now();
  await p.goto(g.link);
  await p.waitForSelector("#pw");
  ok("group link opens the join screen over https (trusted cert, no forwarder)", p.url().startsWith(g.reviewOrigin), `${Date.now() - t0} ms; token dropped from address bar: ${!p.url().includes("g=")}`);
  const bodyText = await p.textContent("body");
  ok("join screen names the group", /Red/.test(bodyText), (bodyText.match(/Invited[^.]{0,40}/) || [""])[0]);
  await p.screenshot({ path: `${out}/01-join.png` });
  await p.fill("#pw", g.password);
  await p.fill("#nm", process.env.REVIEWER || `${engine} over tailnet https`);
  await p.click("button[type=submit]");
  await p.waitForURL(/\/review\/1$/, { timeout: 30000 });
  const cookies = await ctx.cookies(g.reviewOrigin);
  const c = cookies.find((x) => x.name === `__Host-taste-${g.slug}`);
  ok("joined → /review/1 with the Secure __Host- cookie", !!c && c.secure && c.httpOnly, p.url().replace(/\?.*/, ""));
  const frameFor = (side) => p.frames().find((f) => f.url().includes(`/${side}?`));
  for (let i = 0; i < 120 && !(frameFor("page") && frameFor("base")); i++) await p.waitForTimeout(250);
  const page = frameFor("page"), base = frameFor("base");
  ok(`both frames load from the pages origin ${PAGES.host}`, !!page && !!base && new URL(page.url()).host === PAGES.host && new URL(base.url()).host === PAGES.host);
  await page.waitForFunction(() => document.readyState === "complete", null, { timeout: 60000 });
  await base.waitForFunction(() => document.readyState === "complete", null, { timeout: 60000 });
  await p.waitForTimeout(2500);
  const info = (f) => f.evaluate((v1) => {
    const imgs = [...document.images];
    return { h1: document.querySelector("h1")?.textContent?.trim().slice(0, 90), height: document.body.scrollHeight,
      imgs: imgs.length, imgsLoaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length, localImgs: imgs.filter((i) => i.currentSrc.startsWith(v1)).length,
      insecure: imgs.filter((i) => i.currentSrc.startsWith("http:")).length,
      price: document.querySelector('[data-lp-slot="variant-buybox"] [data-lp-buybox="price"]')?.textContent?.trim(), cookie: document.cookie };
  }, `${g.pagesOrigin}/v1/`);
  const pi = await info(page), bi = await info(base);
  console.log("page frame:", JSON.stringify({ ...pi, cookie: undefined }));
  console.log("base frame:", JSON.stringify({ ...bi, cookie: undefined }));
  ok("page frame renders the generated page", pi.height > 2000 && !!pi.h1, `h1 "${pi.h1}", ${pi.height}px tall`);
  ok("base frame renders today's page", bi.height > 2000 && !!bi.h1, `h1 "${bi.h1}", ${bi.height}px tall`);
  ok("page images load from the https /v1 origin (no mixed content)", pi.localImgs > 0 && pi.imgsLoaded > 0 && pi.insecure === 0, `${pi.imgsLoaded}/${pi.imgs} loaded, ${pi.localImgs} from ${PAGES.host}/v1, ${pi.insecure} over http`);
  ok("prices display-only", pi.price === "$N/A", pi.price);
  ok("page frame holds no reviewer cookie", pi.cookie === "", JSON.stringify(pi.cookie));
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${out}/02-review.png` });
  await p.fill("#note", process.env.NOTE || `Seen in ${engine} at ${g.reviewOrigin} (tailnet HTTPS, no forwarder).`);
  const put = p.waitForResponse((r) => r.url().includes("/feedback/") && r.request().method() === "PUT");
  await p.click(".t-ship__opt--new");
  await p.keyboard.press("Control+Enter");
  const st = (await put).status();
  ok("note saves (PUT feedback, same-origin over https)", st === 200, `HTTP ${st}`);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${out}/03-after-save.png` });
  // A cancelled/aborted load (a lazy image or a video the engine stops fetching) is not a failure.
  const ours = failed.filter((u) => !/cancel|ERR_ABORTED/i.test(u)).filter((u) => u.startsWith(g.reviewOrigin) || u.startsWith(g.pagesOrigin) || u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost"));
  ok("no failed requests to the app, the pages origin or a local http origin", ours.length === 0, `${failed.length} failed or cancelled in total (third-party included)${ours.length ? ": " + ours.slice(0, 3).join(" | ") : ""}`);
  ok("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  const mctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: engine !== "firefox", hasTouch: true });
  const mp = await mctx.newPage();
  await mp.goto(g.link); await mp.waitForSelector("#pw");
  await mp.fill("#pw", g.password); await mp.fill("#nm", `${process.env.REVIEWER || engine} phone`); await mp.click("button[type=submit]");
  await mp.waitForURL(/\/review\/1$/); await mp.waitForTimeout(2500);
  await mp.screenshot({ path: `${out}/04-phone.png` });
  ok("phone 390×844: no horizontal overflow", (await mp.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  await b.close();
  fs.writeFileSync(`${out}/browser-walk.json`, JSON.stringify({ at: new Date().toISOString(), engine, results }, null, 2));
  process.exit(results.every((r) => r.pass) ? 0 : 1);
})().catch((e) => { console.error("ERROR", e.message); process.exit(2); });

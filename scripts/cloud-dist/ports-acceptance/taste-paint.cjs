// Time-to-paint of the taste review frames over tailnet HTTPS, cold and warm, with per-request timings.
// usage: node taste-paint.cjs <group.json (0600)> <out-dir> [chromium|webkit]
// env: REVIEWER (default "p5-verify paint"), PW_MODULE, THROTTLE_MBPS + THROTTLE_RTT_MS (Chromium only:
//      emulate a slower link, e.g. a home line or a DERP-relayed tailnet path), LABEL (file suffix).
// Cold = a fresh browser context (empty cache, new TLS connections); warm = reload of /review/1 in the
// same context. For each frame it samples every 100 ms: the iframe element's box/visibility/opacity in
// the parent, the frame's readyState, whether its h1 is laid out, image counts, and the frame's own
// paint/navigation timings. Every response from the pages origin is recorded (timing, size, headers).
// Writes <out>/paint-<engine>.json and screenshots at fixed times; signed query strings are redacted.
const pw = require(process.env.PW_MODULE || '/home/agent/montlakev2/node_modules/playwright');
const fs = require('fs');
const g = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = process.argv[3] || '.';
const engine = process.argv[4] || 'chromium';
const PAGES = new URL(g.pagesOrigin);
fs.mkdirSync(out, { recursive: true });
const redact = (u) => u.replace(/([?&](s|sig|g|t|token)=)[^&]+/g, '$1…');

async function measure(ctx, p, label, navigate) {
  const reqs = [];
  const onDone = async (r) => {
    const u = r.url();
    if (!u.startsWith(g.pagesOrigin) && !u.startsWith(g.reviewOrigin)) return;
    const res = await r.response().catch(() => null);
    const t = r.timing();
    let sizes = {};
    try { sizes = await r.sizes(); } catch {}
    const h = res ? await res.allHeaders().catch(() => ({})) : {};
    reqs.push({ url: redact(u), origin: new URL(u).port, type: r.resourceType(), status: res?.status(), frame: r.frame()?.url().includes('/page?') ? 'page' : r.frame()?.url().includes('/base?') ? 'base' : 'top',
      startTime: t.startTime, dns: t.domainLookupEnd - t.domainLookupStart, connect: t.connectEnd - t.connectStart, tls: t.secureConnectionStart >= 0 ? t.connectEnd - t.secureConnectionStart : -1,
      ttfb: t.responseStart - t.requestStart, responseEnd: t.responseEnd, bytes: sizes.responseBodySize, cacheControl: h['cache-control'], etag: !!h.etag, encoding: h['content-encoding'], ctype: h['content-type'], length: h['content-length'] });
  };
  p.on('requestfinished', onDone);
  p.on('requestfailed', (r) => reqs.push({ url: redact(r.url()), failed: r.failure()?.errorText }));
  const t0 = Date.now();
  await navigate();
  const samples = [];
  const firsts = {};
  const shots = new Set([2000, 4000, 8000, 12000, 16000, 25000]);
  while (Date.now() - t0 < Number(process.env.MAX_MS || 40000)) {
    const ms = Date.now() - t0;
    const row = { ms };
    for (const side of ['page', 'base']) {
      const f = p.frames().find((x) => x.url().includes(`/${side}?`));
      const el = await p.evaluate((s) => {
        const ifr = [...document.querySelectorAll('iframe')].find((i) => (i.src || '').includes(`/${s}?`));
        if (!ifr) return null;
        const cs = getComputedStyle(ifr); const r = ifr.getBoundingClientRect();
        let anc = ifr, hidden = '';
        while (anc && anc !== document.body) { const c = getComputedStyle(anc); if (c.visibility === 'hidden' || c.opacity === '0' || c.display === 'none') { hidden = `${anc.tagName}.${anc.className}`.slice(0, 60) + ` vis=${c.visibility} op=${c.opacity} disp=${c.display}`; break; } anc = anc.parentElement; }
        return { w: Math.round(r.width), h: Math.round(r.height), vis: cs.visibility, op: cs.opacity, hidden, cls: ifr.className.slice(0, 60) };
      }, side).catch(() => null);
      let inner = null;
      if (f) inner = await f.evaluate(() => {
        const h1 = document.querySelector('h1'); const r = h1?.getBoundingClientRect();
        const imgs = [...document.images]; const nav = performance.getEntriesByType('navigation')[0];
        const fcp = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
        const bodyVis = document.body ? getComputedStyle(document.body) : null;
        return { rs: document.readyState, h1: !!(r && r.height > 0), imgs: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
          fcp: fcp ? Math.round(fcp.startTime) : null, respEnd: nav ? Math.round(nav.responseEnd) : null, dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null, load: nav ? Math.round(nav.loadEventEnd) : null,
          bodyOp: bodyVis?.opacity, bodyVis: bodyVis?.visibility, res: performance.getEntriesByType('resource').length, now: Math.round(performance.now()) };
      }).catch((e) => ({ err: String(e).slice(0, 80) }));
      row[side] = { el, inner };
      const shown = el && el.w > 0 && el.h > 0 && el.vis !== 'hidden' && el.op !== '0' && !el.hidden;
      if (inner?.h1 && !firsts[`${side}H1`]) firsts[`${side}H1`] = ms;
      if (shown && !firsts[`${side}Shown`]) firsts[`${side}Shown`] = ms;
      if (shown && inner?.h1 && !firsts[`${side}Visible`]) firsts[`${side}Visible`] = ms;
      if (inner?.rs === 'complete' && !firsts[`${side}Complete`]) firsts[`${side}Complete`] = ms;
    }
    samples.push(row);
    for (const s of [...shots]) if (ms >= s) { shots.delete(s); await p.screenshot({ path: `${out}/${engine}${process.env.LABEL ? '-' + process.env.LABEL : ''}-${label}-${String(s / 1000).padStart(2, '0')}s.png` }); }
    if (firsts.pageVisible && firsts.baseVisible && firsts.pageComplete && firsts.baseComplete && ms > 26000) break;
    await p.waitForTimeout(100);
  }
  p.off('requestfinished', onDone);
  const pages = reqs.filter((r) => r.origin === PAGES.port && !r.failed);
  const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
  const summary = { label, firsts, pagesRequests: pages.length, pagesBytes: sum(pages.map((r) => r.bytes)),
    maxTtfb: Math.max(0, ...pages.map((r) => r.ttfb)), medianTtfb: pages.map((r) => r.ttfb).sort((a, b) => a - b)[Math.floor(pages.length / 2)] || 0,
    lastResponseEnd: Math.max(0, ...pages.map((r) => r.responseEnd)), failed: reqs.filter((r) => r.failed).length,
    cacheControls: [...new Set(pages.map((r) => `${r.type}:${r.cacheControl}`))].slice(0, 12) };
  console.log(`[${engine}] ${label}:`, JSON.stringify(summary));
  return { summary, samples, reqs };
}

(async () => {
  const b = await pw[engine].launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  if (process.env.THROTTLE_MBPS && engine === 'chromium') {
    const cdp = await ctx.newCDPSession(p);
    const bps = Number(process.env.THROTTLE_MBPS) * 1e6 / 8;
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: Number(process.env.THROTTLE_RTT_MS || 40), downloadThroughput: bps, uploadThroughput: bps / 4 });
    console.log(`[${engine}] throttled to ${process.env.THROTTLE_MBPS} Mbit/s, ${process.env.THROTTLE_RTT_MS || 40} ms`);
  }
  await p.goto(g.link);
  await p.waitForSelector('#pw');
  await p.fill('#pw', g.password);
  await p.fill('#nm', process.env.REVIEWER || 'p5-verify paint');
  const cold = await measure(ctx, p, 'cold', async () => { await p.click('button[type=submit]'); await p.waitForURL(/\/review\/1$/, { timeout: 30000 }); });
  const warm = await measure(ctx, p, 'warm', async () => { await p.reload(); });
  await b.close();
  fs.writeFileSync(`${out}/paint-${engine}${process.env.LABEL ? '-' + process.env.LABEL : ''}.json`, JSON.stringify({ at: new Date().toISOString(), engine, version: b.version?.(), cold, warm }, null, 1));
})().catch((e) => { console.error('ERROR', e.stack); process.exit(2); });

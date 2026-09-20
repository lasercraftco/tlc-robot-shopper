// Robot shopper — walks real products through the Design Center to the
// storefront cart and reports anything that stops a shopper. Never checks out.
import { chromium, devices } from 'playwright';
import fs from 'node:fs';

const DC = 'https://design.thelasercraft.co';
const STORE = 'https://www.thelasercraft.co';
const TOKEN = process.env.ROBOT_TOKEN || '';
const SET = process.env.ROBOT_SET || 'core';           // core | full
const ONLY = process.env.ROBOT_ONLY ? process.env.ROBOT_ONLY.split(',') : null;
const DEVICES = (process.env.ROBOT_DEVICES || 'phone,laptop').split(',');
const OUT = process.env.ROBOT_OUT || 'out';
fs.mkdirSync(OUT, { recursive: true });

const products = JSON.parse(fs.readFileSync(new URL('./products.json', import.meta.url)))
  .filter((p) => (ONLY ? ONLY.includes(p.type) : SET === 'full' || p.core));

// Only our own sites + what they need to render. Everything else (ad pixels,
// analytics, session replay, Sentry) is blocked so the robot never counts as a
// shopper anywhere. First-party tracking endpoints are blocked by path too.
const ALLOW_HOSTS = [/(^|\.)thelasercraft\.co$/, /\.supabase\.co$/, /(^|\.)shopify\.com$/, /\.myshopify\.com$/,
  /(^|\.)shopifycdn\.com$/, /fonts\.(googleapis|gstatic)\.com$/, /(^|\.)vercel\.(app|com)$/, /(^|\.)vercel-insights\.com$/,
  /cdn\.jsdelivr\.net$/, /unpkg\.com$/, /cdnjs\.cloudflare\.com$/, /challenges\.cloudflare\.com$/];
const BLOCK_PATHS = /\/api\/(funnel|meta-capi|analytics|track|events|clientlog)|\/_vercel\/insights|\/monitoring|\/ingest/;

function dcUrl(p) {
  const q = new URLSearchParams({ source: 'shopify', variant: p.style, lock: '1', variantId: p.vid, qty: String(p.qty),
    returnUrl: `${STORE}/cart/design-return` });
  if (p.color) q.set('color', p.color);
  return `${DC}/design/${p.type}?${q}`;
}

async function runOne(browser, p, dev) {
  const t0 = Date.now();
  const ctxOpts = dev === 'phone' ? { ...devices['iPhone 13'] } : { viewport: { width: 1366, height: 768 } };
  const ctx = await browser.newContext({ ...ctxOpts, userAgent: (ctxOpts.userAgent || (await browser.newPage().then(async (pg) => { const ua = await pg.evaluate(() => navigator.userAgent); await pg.close(); return ua; }))) + ' TLCRobotShopper/1' });
  if (TOKEN) await ctx.addCookies([{ name: 'tlc_robot', value: TOKEN, domain: 'design.thelasercraft.co', path: '/', secure: true, sameSite: 'Lax' }]);
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (!ALLOW_HOSTS.some((re) => re.test(u.hostname)) || BLOCK_PATHS.test(u.pathname)) return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const bad = [];
  page.on('response', (r) => { const u = r.url(); if (r.status() >= 400 && /thelasercraft\.co|myshopify|shopify\.com/.test(u) && !BLOCK_PATHS.test(new URL(u).pathname)) bad.push(`${r.status()} ${r.request().method()} ${u.replace(/\?.*/, '').slice(0, 90)}`); });
  page.on('requestfailed', (r) => { const u = r.url(); const f = r.failure()?.errorText || ''; if (!/ERR_FAILED|ERR_ABORTED/.test(f) || /thelasercraft/.test(u)) { if (!BLOCK_PATHS.test(new URL(u).pathname) && ALLOW_HOSTS.some((re) => re.test(new URL(u).hostname))) bad.push(`FAILED ${f} ${u.replace(/\?.*/, '').slice(0, 90)}`); } });
  let step = 'open design center';
  const res = { product: p.type, device: dev, ok: false, step: '', detail: '', ms: 0 };
  try {
    const r = await page.goto(dcUrl(p), { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!r || r.status() >= 400) throw new Error(`HTTP ${r?.status()}`);
    step = 'load editor';
    const fileInput = page.locator('input[type=file]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 45000 });
    step = 'upload artwork';
    await fileInput.setInputFiles(new URL('./art.png', import.meta.url).pathname);
    const cta = page.getByRole('button', { name: /(add (order )?to cart|approve)/i }).first();
    await cta.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction((el) => !el.disabled, await cta.elementHandle(), { timeout: 30000 });
    step = 'add to cart';
    for (let attempt = 0; attempt < 3; attempt++) {
      await cta.click();
      const outcome = await Promise.race([
        page.waitForURL((u) => u.hostname === 'www.thelasercraft.co', { timeout: 60000 }).then(() => 'left'),
        page.locator('[data-testid=editor-notice]').first().waitFor({ state: 'visible', timeout: 60000 }).then(() => 'notice'),
        page.locator('[data-testid=oob-confirm]').waitFor({ state: 'visible', timeout: 60000 }).then(() => 'oob'),
      ]).catch(() => 'timeout');
      if (outcome === 'left') break;
      if (outcome === 'oob') { await page.getByRole('button', { name: /submit anyway/i }).click(); step = 'add to cart (after crop confirm)'; continue; }
      if (outcome === 'notice') {
        const msg = (await page.locator('[data-testid=editor-notice]').first().innerText()).trim();
        if (/side 2 is blank/i.test(msg) && await page.getByRole('button', { name: /^1 side$/i }).count()) {
          await page.getByRole('button', { name: /^1 side$/i }).first().click(); continue;
        }
        throw new Error(`cart refused: ${msg.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
      throw new Error('clicked Add to cart, nothing happened for 60s');
    }
    step = 'storefront cart';
    await page.waitForURL(/\/cart(\?|$|\/?$)/, { timeout: 45000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded');
    const checkout = page.getByRole('button', { name: /check ?out/i }).or(page.getByRole('link', { name: /check ?out/i })).first();
    await checkout.waitFor({ state: 'visible', timeout: 30000 });
    const body = await page.locator('body').innerText();
    if (/your cart is empty/i.test(body)) throw new Error('landed on an empty cart');
    res.ok = true;
  } catch (e) {
    res.step = step;
    res.detail = String(e.message || e).split('\n')[0].slice(0, 300);
    if (errors.length) res.detail += ` | page errors: ${errors.slice(0, 2).join(' ; ')}`;
    if (bad.length) res.detail += ` | bad responses: ${[...new Set(bad)].slice(0, 4).join(' ; ')}`;
    await page.screenshot({ path: `${OUT}/${p.type}-${dev}.png` }).catch(() => {});
  }
  res.ms = Date.now() - t0;
  await ctx.close();
  return res;
}

const browser = await chromium.launch();
const jobs = [];
for (const p of products) for (const d of DEVICES) jobs.push([p, d]);
const results = [];
const CONC = Number(process.env.ROBOT_CONCURRENCY || 4);
let i = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < jobs.length) { const [p, d] = jobs[i++]; const r = await runOne(browser, p, d); results.push(r);
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.product} ${r.device} ${(r.ms / 1000).toFixed(1)}s ${r.ok ? '' : `— ${r.step}: ${r.detail}`}`); }
}));
// Retry each failure once, alone. Shopify/Vercel hiccups under a burst are
// not an outage; two failures in a row on the same product+device are.
const firstFails = results.filter((r) => !r.ok);
for (const f of firstFails) {
  const p = products.find((x) => x.type === f.product);
  const r2 = await runOne(browser, p, f.device);
  f.retried = true; f.retryOk = r2.ok;
  if (r2.ok) { f.ok = true; f.flaky = true; console.log(`RETRY-PASS ${f.product} ${f.device} (first try: ${f.step}: ${f.detail})`); }
  else { f.detail = r2.detail; f.step = r2.step; console.log(`RETRY-FAIL ${f.product} ${f.device} — ${r2.step}: ${r2.detail}`); }
}
await browser.close();
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;

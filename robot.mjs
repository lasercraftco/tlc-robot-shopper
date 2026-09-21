// Robot shopper — walks real products from the storefront page through the
// Design Center to the cart and into Shopify checkout (never pays), on a
// laptop (Chromium) and a phone (WebKit = Safari's engine). Checks price
// agreement at every hop. Scenario rotation covers file types, entry paths
// and 2-sided designs across runs without making any single run longer.
import { chromium, webkit, devices } from 'playwright';
import fs from 'node:fs';

// Point at a Vercel preview build to test a change BEFORE it reaches
// customers (ROBOT_DC_BASE + ROBOT_BYPASS, set by design-center's CI).
const DC = (process.env.ROBOT_DC_BASE || 'https://design.thelasercraft.co').replace(/\/$/, '');
const BYPASS = process.env.ROBOT_BYPASS || '';
const STORE = 'https://www.thelasercraft.co';
const TOKEN = process.env.ROBOT_TOKEN || '';
console.log(`robot cookie: ${TOKEN ? 'set (' + TOKEN.length + ' chars)' : 'MISSING — designs will not be tagged or cleaned up'}`);
const SET = process.env.ROBOT_SET || 'core';           // core | full
const ONLY = process.env.ROBOT_ONLY ? process.env.ROBOT_ONLY.split(',') : null;
const DEVICES = (process.env.ROBOT_DEVICES || 'phone,laptop').split(',');
const OUT = process.env.ROBOT_OUT || 'out';
const CHECKOUT = process.env.ROBOT_CHECKOUT !== '0';
const RUN_INDEX = Number(process.env.ROBOT_RUN_INDEX ?? Math.floor(Date.now() / (30 * 60 * 1000)));
const here = (f) => new URL(`./${f}`, import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

const products = JSON.parse(fs.readFileSync(here('products.json')))
  .filter((p) => (ONLY ? ONLY.includes(p.type) : SET === 'full' || p.core));

// Rotation: each run, each product+device gets a different scenario. Over
// 8 runs (4 hours) every product sees every scenario on both devices.
const SCENARIOS = [
  { entry: 'page',   file: 'art.png' },
  { entry: 'direct', file: 'art.jpg' },
  { entry: 'page',   file: 'art.heic' },
  { entry: 'direct', file: 'art.pdf' },
  { entry: 'page',   file: 'art.jpg', sides: 2 },
  { entry: 'direct', file: 'art.png', sides: 2 },
  { entry: 'page',   file: 'art.pdf' },
  { entry: 'direct', file: 'art.heic' },
];
const pickScenario = (pi, dev) => {
  const sc = process.env.ROBOT_SCENARIO ? SCENARIOS[Number(process.env.ROBOT_SCENARIO)]
    : SCENARIOS[(RUN_INDEX + pi * 3 + (dev === 'phone' ? 1 : 0)) % SCENARIOS.length];
  // 2-sided runs on the laptop only: on the phone the sides toggle sits in a
  // collapsible sheet the robot can't drive reliably, and a half-done 2-sided
  // setup reads as a false outage.
  return dev === 'phone' && sc.sides === 2 ? { ...sc, sides: 1 } : sc;
};

// Only our own sites + what they need to render. Every ad/analytics pixel,
// session replay and error reporter is blocked so the robot never counts as a
// shopper anywhere; first-party tracking endpoints are blocked by path.
const ALLOW_HOSTS = [/(^|\.)thelasercraft\.co$/, /\.supabase\.co$/, /(^|\.)shopify\.com$/, /\.myshopify\.com$/,
  /(^|\.)shopifycdn\.com$/, /(^|\.)shopifycloud\.com$/, /fonts\.(googleapis|gstatic)\.com$/, /(^|\.)vercel\.(app|com)$/,
  /cdn\.jsdelivr\.net$/, /unpkg\.com$/, /cdnjs\.cloudflare\.com$/, /challenges\.cloudflare\.com$/, /(^|\.)shop\.app$/];
const BLOCK_PATHS = /\/api\/(funnel|meta-capi|analytics|track|events|clientlog)|\/_vercel\/(insights|speed-insights)|\/monitoring|\/ingest|\/monorail|\/web-pixels|\/\.well-known\/shopify\/monorail|\/api\/collect|\/v1\/produce/;

const money = (s) => { const m = String(s).replace(/,/g, '').match(/\$\s?(\d+(?:\.\d{2})?)/); return m ? Math.round(parseFloat(m[1]) * 100) : null; };
const allMoney = (s) => [...String(s).replace(/,/g, '').matchAll(/\$\s?(\d+\.\d{2})/g)].map((m) => Math.round(parseFloat(m[1]) * 100));

function dcUrl(p) {
  const q = new URLSearchParams({ source: 'shopify', variant: p.style, lock: '1', variantId: p.vid, qty: String(p.qty),
    returnUrl: `${STORE}/cart/design-return` });
  if (p.color) q.set('color', p.color);
  return `${DC}/design/${p.type}?${q}`;
}

async function enterFromPage(page, p) {
  const r = await page.goto(STORE + p.page, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (!r || r.status() >= 400) throw new Error(`storefront page HTTP ${r?.status()}`);
  await page.waitForTimeout(2500);
  const re = new RegExp(p.cta || '^\\s*(start designing|design (your|yours|now)|start your design|customize|personalize)', 'i');
  const cands = page.locator('a,button').filter({ hasText: re });
  const n = await cands.count();
  for (let i = n - 1; i >= 0; i--) {
    const c = cands.nth(i);
    if (!(await c.isVisible().catch(() => false))) continue;
    await c.scrollIntoViewIfNeeded().catch(() => {});
    await Promise.all([page.waitForURL(/design\.thelasercraft\.co/, { timeout: 10000 }), c.click()]).catch(() => {});
    if (page.url().includes('design.thelasercraft.co')) return;
  }
  throw new Error(`no working "design" button on ${p.page}`);
}

// A Shopify checkout page, not an error page or a bounce back to the cart.
const CHECKOUT_ERROR = /something went wrong|there was a problem|out of stock|no longer available|this (invoice|checkout) (is|has) (expired|no longer)|page not found/i;
async function assertCheckoutPage(page) {
  if (!/\/checkouts?\//.test(new URL(page.url()).pathname)) throw new Error(`not a checkout URL: ${page.url().replace(/[?#].*/, '').slice(0, 120)}`);
  const text = await page.locator('body').innerText().catch(() => '');
  const err = text.match(CHECKOUT_ERROR);
  if (err) throw new Error(`checkout error: ${text.slice(err.index, err.index + 120).split('\n')[0]}`);
  if (!/(contact|delivery|shipping|payment|pay now|order summary|express checkout)/i.test(text)) {
    throw new Error('checkout URL loaded but the page has no checkout form');
  }
}

// Daily (nightly full run, or ROBOT_BULK_QUOTE=1): the internal test bulk
// quote BQ-ROBOTPAY. POST its /pay link exactly as the customer's "Check out
// now" button does — for that quote the server re-runs the catalogue rebuild
// + Shopify draftOrderUpdate every time, which fails if any variant id has
// gone stale (Sep 18: ~29 failed pays) — then load the Shopify invoice
// checkout it redirects to. Never pays. The quote has no email on it, so
// nothing about this check can reach a customer.
const BQ_TOKEN = process.env.ROBOT_BULK_QUOTE_TOKEN || '';
const BULK_QUOTE = !!BQ_TOKEN && (process.env.ROBOT_BULK_QUOTE === '1' || (SET === 'full' && !ONLY));
async function bulkQuotePayOnce(browsers) {
  const res = { product: 'bulk-quote-pay', device: 'laptop', scenario: { entry: 'pay', file: 'BQ-ROBOTPAY' }, ok: false, step: '', detail: '', ms: 0, prices: {}, daily: true };
  const t0 = Date.now();
  let step = 'POST /pay';
  const ctx = await browsers.chromium.newContext({ viewport: { width: 1366, height: 768 } });
  try {
    const r = await fetch(`${STORE}/api/bulk-quote/${encodeURIComponent(BQ_TOKEN)}/pay`, {
      method: 'POST', redirect: 'manual', headers: { 'user-agent': 'tlc-robot-shopper/1.0 (bot; synthetic monitor)' },
    });
    const loc = r.headers.get('location') || '';
    if (r.status !== 303 || !loc) throw new Error(`pay returned HTTP ${r.status}${loc ? ` → ${loc.slice(0, 120)}` : ''}`);
    if (/payError=([^&]+)/.test(loc)) throw new Error(`pay refused: payError=${loc.match(/payError=([^&]+)/)[1]} (stale variant ids / Shopify draft error — see Vercel logs for bulk-quote-convert)`);
    if (/\/bulk-orders\?/.test(loc)) throw new Error(`pay bounced to the quote page: ${loc.replace(/quote=[^&]+/, 'quote=…').slice(0, 120)}`);
    step = 'invoice → Shopify checkout loads';
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
      if (!ALLOW_HOSTS.some((re) => re.test(u.hostname)) || BLOCK_PATHS.test(u.pathname)) return route.abort();
      return route.continue();
    });
    const page = await ctx.newPage();
    const resp = await page.goto(loc, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!resp || resp.status() !== 200) throw new Error(`invoice checkout HTTP ${resp?.status()}`);
    await page.waitForTimeout(3000);
    await assertCheckoutPage(page);
    const amounts = allMoney(await page.locator('body').innerText());
    res.prices.checkout = amounts.length ? Math.max(...amounts) : null;
    if (res.prices.checkout === 0) throw new Error('invoice checkout total is $0.00');
    res.ok = true;
  } catch (e) {
    res.step = step;
    res.detail = String(e.message || e).split('\n')[0].slice(0, 300);
    const pages = ctx.pages();
    if (pages.length) await pages[0].screenshot({ path: `${OUT}/bulk-quote-pay.png` }).catch(() => {});
  }
  res.ms = Date.now() - t0;
  await ctx.close();
  return res;
}
async function bulkQuotePay(browsers) {
  const first = await bulkQuotePayOnce(browsers);
  if (first.ok) return first;
  const second = await bulkQuotePayOnce(browsers);
  if (second.ok) return { ...second, flaky: `${first.step}: ${first.detail}` };
  return second;
}

async function runOne(browsers, p, pi, dev) {
  const sc = pickScenario(pi, dev);
  const t0 = Date.now();
  const res = { product: p.type, device: dev, scenario: sc, ok: false, step: '', detail: '', ms: 0, prices: {} };
  const browser = dev === 'phone' ? browsers.webkit : browsers.chromium;
  const ctx = await browser.newContext(dev === 'phone' ? { ...devices['iPhone 13'] } : { viewport: { width: 1366, height: 768 } });
  if (TOKEN) await ctx.addCookies([{ name: 'tlc_robot', value: TOKEN, domain: 'design.thelasercraft.co', path: '/', secure: true, sameSite: 'Lax' }]);
  const dcHost = new URL(DC).hostname;
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (!ALLOW_HOSTS.some((re) => re.test(u.hostname)) || BLOCK_PATHS.test(u.pathname)) return route.abort();
    // Vercel preview builds sit behind login; this header is the official way past it.
    if (BYPASS && u.hostname === dcHost) {
      return route.continue({ headers: { ...route.request().headers(), 'x-vercel-protection-bypass': BYPASS, 'x-vercel-set-bypass-cookie': 'true' } });
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  const errors = [], bad = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('response', (r) => { try { const u = new URL(r.url()); if (r.status() >= 400 && /thelasercraft\.co|shopify/.test(u.hostname) && !BLOCK_PATHS.test(u.pathname) && !/private_access_tokens/.test(u.pathname)) bad.push(`${r.status()} ${r.request().method()} ${u.hostname}${u.pathname.slice(0, 70)}`); } catch {} });
  let step = 'open';
  try {
    if (sc.entry === 'page' && p.page && !BYPASS) { step = 'storefront page → design button'; await enterFromPage(page, p); }
    else { step = 'open design center'; const r = await page.goto(dcUrl(p), { waitUntil: 'domcontentloaded', timeout: 45000 }); if (!r || r.status() >= 400) throw new Error(`HTTP ${r?.status()}`); }
    res.entry = page.url().replace(/[?#].*/, '');
    step = 'load editor';
    const fileInput = page.locator('input[type=file]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 45000 });
    step = `upload ${sc.file}`;
    await fileInput.setInputFiles(here(sc.file));
    const cta = page.getByRole('button', { name: /(add (order )?to cart|approve)/i }).first();
    await cta.waitFor({ state: 'visible', timeout: 45000 });
    // Contour products ask how to cut a photo with a solid background — a
    // required choice for shoppers too. Pick "cut the whole image".
    const keep = page.locator('[data-testid=contour-bg-keep]');
    await keep.waitFor({ state: 'visible', timeout: 8000 }).then(() => keep.click()).catch(() => {});
    await page.waitForFunction((el) => !el.disabled, await cta.elementHandle(), { timeout: 45000 });

    if (sc.sides === 2) {
      // Laptop: a failure here is a real failure. Phone: the sides toggle sits
      // in a collapsible sheet the robot can't always drive; if it can't, it
      // finishes the order 1-sided (the blank-side gate is then exercised).
      try {
        const two = page.getByRole('button', { name: /^2 sides?$/i }).first();
        // On the phone the sides toggle lives in the Setup sheet — open it only if needed.
        // The Setup rail button toggles the sheet, and the sheet may be open
        // but collapsed — try until the toggle is actually tappable.
        const tappable = async () => (await two.isVisible().catch(() => false)) && (await two.click({ trial: true, timeout: 1500 }).then(() => true).catch(() => false));
        if (dev === 'phone') {
          const setup = page.getByRole('button', { name: /^setup$/i }).first();
          for (let k = 0; k < 3 && !(await tappable()); k++) {
            const header = page.getByRole('button', { name: /^set(up|…|\.\.\.)?$/i }).filter({ hasNotText: /^setup$/i }).first();
            if (k === 1 && await header.count()) await header.click().catch(() => {});
            else if (await setup.count()) await setup.click().catch(() => {});
            await page.waitForTimeout(800);
          }
        }
        if (await tappable()) {
          step = '2-sided: switch to 2 sides';
          await two.click({ timeout: 15000 });
          const back = page.getByRole('button', { name: /^(side 2|back)$/i }).or(page.getByRole('tab', { name: /^(side 2|back)$/i })).first();
          await back.waitFor({ state: 'visible', timeout: 10000 });
          await back.click({ timeout: 10000 });
          step = '2-sided: upload back';
          await page.locator('input[type=file]').first().setInputFiles(here(sc.file));
          await page.waitForTimeout(2500);
          res.twoSided = true;
        } else res.twoSided = 'n/a';

      } catch (e) {
        if (dev !== 'phone') throw e;
        res.twoSided = 'skipped (phone sheet)';
      }
    }
    // The order-summary chip ("1 unit · 5 pieces · $129.85") is on every layout.
    const buyText = (await page.locator('body').innerText()).replace(/,/g, '');
    const chip = buyText.match(/\d+\s+units?\s*·[^$\n]*\$\s?(\d+\.\d{2})/i);
    res.prices.dc = chip ? Math.round(parseFloat(chip[1]) * 100) : null;

    step = 'add to cart';
    for (let attempt = 0; attempt < 3; attempt++) {
      const tClick = Date.now();
      await cta.click();
      const outcome = await Promise.race([
        page.waitForURL((u) => u.hostname === 'www.thelasercraft.co', { timeout: 90000 }).then(() => 'left'),
        page.locator('[data-testid=editor-notice]').first().waitFor({ state: 'visible', timeout: 90000 }).then(() => 'notice'),
        page.locator('[data-testid=oob-confirm]').waitFor({ state: 'visible', timeout: 90000 }).then(() => 'oob'),
      ]).catch(() => 'timeout');
      if (outcome === 'left') { res.submitMs = Date.now() - tClick; break; }
      if (outcome === 'oob') { await page.getByRole('button', { name: /submit anyway/i }).click(); continue; }
      if (outcome === 'notice') {
        const msg = (await page.locator('[data-testid=editor-notice]').first().innerText()).trim();
        if (/side 2 is blank/i.test(msg) && await page.getByRole('button', { name: /^1 side$/i }).count()) {
          await page.getByRole('button', { name: /^1 side$/i }).first().click(); continue;
        }
        throw new Error(`cart refused: ${msg.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
      throw new Error('tapped Add to cart, still on "Submitting" after 90s');
    }

    step = 'storefront cart';
    await page.waitForURL(/\/cart(\?|$|\/?$)/, { timeout: 60000 }).catch(() => {});
    const checkout = page.getByRole('button', { name: /check ?out/i }).or(page.getByRole('link', { name: /check ?out/i })).first();
    await checkout.waitFor({ state: 'visible', timeout: 45000 });
    const cartText = await page.locator('body').innerText();
    if (/your cart is empty/i.test(cartText)) throw new Error('landed on an empty cart');
    const sub = cartText.replace(/,/g, '').match(/subtotal[^$]{0,40}\$\s?(\d+\.\d{2})/i);
    res.prices.cart = sub ? Math.round(parseFloat(sub[1]) * 100) : null;
    step = 'price check (design center vs cart)';
    if (res.prices.dc != null && res.prices.cart != null && Math.abs(res.prices.dc - res.prices.cart) > 1) {
      throw new Error(`price mismatch: design center showed $${(res.prices.dc / 100).toFixed(2)}, cart subtotal $${(res.prices.cart / 100).toFixed(2)}`);
    }
    if (res.prices.cart === 0) throw new Error('cart subtotal is $0.00');

    if (CHECKOUT) {
      step = 'Shopify checkout loads';
      // The checkout document itself must answer 200 (redirect hops skipped),
      // not merely change the URL — a 4xx/5xx checkout page is still a URL.
      const coDoc = page.waitForResponse((r) => r.request().isNavigationRequest() && r.frame() === page.mainFrame()
        && /\/checkouts?\//.test(new URL(r.url()).pathname) && (r.status() < 300 || r.status() >= 400), { timeout: 45000 }).catch(() => null);
      await Promise.all([page.waitForURL(/checkouts?\//, { timeout: 45000 }), checkout.click()]);
      const coResp = await coDoc;
      if (!coResp) throw new Error('checkout URL reached but the checkout document never answered');
      if (coResp.status() !== 200) throw new Error(`checkout page HTTP ${coResp.status()}`);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(3000);
      await assertCheckoutPage(page);
      res.checkout = 'loaded';
      // Phones collapse the order summary and show a tax-inclusive total; open it.
      const toggle = page.getByRole('button', { name: /order summary/i }).first();
      if (await toggle.isVisible().catch(() => false)) { await toggle.click().catch(() => {}); await page.waitForTimeout(1200); }
      const co = await page.locator('body').innerText();
      if (/something went wrong|there was a problem|out of stock|no longer available/i.test(co)) throw new Error(`checkout error: ${co.match(/(something went wrong|there was a problem|out of stock|no longer available)[^\n]*/i)?.[0]}`);
      const coAmounts = allMoney(co);
      step = 'price check (cart vs checkout)';
      // Subtotal must appear; if the summary stayed collapsed, the total may
      // only exceed it by tax (NV ≤ 8.4%) — anything else is a real mismatch.
      const taxOnly = coAmounts.length > 0 && coAmounts.every((a) => a >= res.prices.cart && a <= Math.round(res.prices.cart * 1.1));
      if (res.prices.cart != null && coAmounts.length && !coAmounts.includes(res.prices.cart) && !taxOnly) {
        throw new Error(`checkout doesn't show the cart subtotal $${(res.prices.cart / 100).toFixed(2)} (saw ${coAmounts.slice(0, 5).map((c) => '$' + (c / 100).toFixed(2)).join(', ')})`);
      }
      res.prices.checkout = coAmounts.length ? Math.max(...coAmounts) : null;
    }
    res.ok = true;
  } catch (e) {
    res.step = step;
    res.detail = String(e.message || e).split('\n')[0].slice(0, 300);
    if (errors.length) res.detail += ` | page errors: ${errors.slice(0, 2).join(' ; ')}`;
    if (bad.length) res.detail += ` | bad responses: ${[...new Set(bad)].slice(0, 3).join(' ; ')}`;
    await page.screenshot({ path: `${OUT}/${p.type}-${dev}.png` }).catch(() => {});
  }
  res.ms = Date.now() - t0;
  await ctx.close();
  return res;
}

const browsers = { chromium: await chromium.launch(), webkit: DEVICES.includes('phone') ? await webkit.launch() : null };
const jobs = [];
products.forEach((p, pi) => DEVICES.forEach((d) => jobs.push([p, pi, d])));
const results = [];
const CONC = Number(process.env.ROBOT_CONCURRENCY || 2);
let i = 0;
const fmt = (r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.product} ${r.device} [${r.scenario.entry} ${r.scenario.file}${r.scenario.sides === 2 ? ' 2-sided' : ''}] ${(r.ms / 1000).toFixed(1)}s ${r.prices.dc != null ? `$${(r.prices.dc / 100).toFixed(2)}` : ''}${r.submitMs > 30000 ? ` SLOW-SUBMIT ${(r.submitMs / 1000).toFixed(0)}s` : ''}${r.ok ? '' : ` — ${r.step}: ${r.detail}`}`;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < jobs.length) { const [p, pi, d] = jobs[i++]; const r = await runOne(browsers, p, pi, d); results.push(r); console.log(fmt(r)); }
}));
// Retry each failure once, alone, same scenario. Hiccups under a burst are
// not an outage; two failures in a row on the same product+device are.
for (const f of results.filter((r) => !r.ok)) {
  const pi = products.findIndex((x) => x.type === f.product);
  const r2 = await runOne(browsers, products[pi], pi, f.device);
  if (r2.ok) { f.ok = true; f.flaky = `${f.step}: ${f.detail}`; console.log(`RETRY-PASS ${f.product} ${f.device}`); }
  else { Object.assign(f, { step: r2.step, detail: r2.detail }); console.log(`RETRY-FAIL ${f.product} ${f.device} — ${r2.step}: ${r2.detail}`); }
}
// After the product retries on purpose: bulkQuotePay does its own retry.
if (BULK_QUOTE) { const r = await bulkQuotePay(browsers); results.push(r); console.log(fmt(r)); }
else if (SET === 'full' && !BQ_TOKEN) console.log('bulk-quote pay check skipped: ROBOT_BULK_QUOTE_TOKEN not set');
await browsers.chromium.close(); await browsers.webkit?.close();
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;

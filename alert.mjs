// Reads out/results.json and decides whether a human needs to know.
//
// Debounce: a product+device must fail (after its in-run retry) in TWO
// CONSECUTIVE runs before anyone is emailed or paged. The previous run's
// failures live in a "robot-watch" issue; confirmed failures open the
// "robot-down" issue + email + page once, and one all-clear goes out when
// they recover. A single hiccup never reaches Tyler.
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const results = JSON.parse(fs.readFileSync('out/results.json', 'utf8'));
const failed = results.filter((r) => !r.ok);
const flaky = results.filter((r) => r.flaky);
const slow = results.filter((r) => r.submitMs > 30000);
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const id = (r) => `${r.product}/${r.device}`;

const issue = (label) => JSON.parse(sh(`gh issue list --label ${label} --state open --json number,body --limit 1`))[0];
const sigOf = (body) => new Set(((body || '').match(/sig:([^ ]*) -->/) || [])[1]?.split(',').filter(Boolean) ?? []);
const writeBody = (s) => fs.writeFileSync('/tmp/body.md', s);

async function email(subject, html) {
  if (!process.env.RESEND_API_KEY) return console.log('no RESEND_API_KEY; skipping email');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Robot Shopper <alerts@thelasercraft.co>', to: ['hello@thelasercraft.co'], subject, html }),
  });
  console.log('email', r.status);
}
async function page(title, message) {
  const topic = process.env.NTFY_TOPIC;
  if (topic) {
    const r = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: 'POST',
      headers: { Title: title.slice(0, 200), Priority: 'urgent', Tags: 'rotating_light', Click: runUrl },
      body: message.slice(0, 1000) });
    console.log('ntfy', r.status);
  }
  const token = process.env.PUSHOVER_APP_TOKEN, user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return;
  const r = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST',
    body: new URLSearchParams({ token, user, title, message: message.slice(0, 1000), priority: '2', retry: '300', expire: '3600', url: runUrl, url_title: 'Run' }) });
  console.log('page', r.status);
}

// Step summary on every run.
const lines = [`${results.length - failed.length}/${results.length} checks passed.`,
  ...failed.map((f) => `- FAIL **${id(f)}** [${f.scenario.entry} ${f.scenario.file}${f.scenario.sides === 2 ? ' 2-sided' : ''}] at *${f.step}*: ${f.detail}`),
  ...(flaky.length ? ['', `Passed on retry: ${flaky.map(id).join(', ')}`] : []),
  ...(slow.length ? ['', `Slow add-to-cart (>30s): ${slow.map((r) => `${id(r)} ${(r.submitMs / 1000).toFixed(0)}s`).join(', ')}`] : [])];
fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY || '/dev/null', lines.join('\n') + '\n');

// 1. Watch list: what failed last run vs now.
const watch = issue('robot-watch');
const prev = sigOf(watch?.body);
const now = new Set(failed.map(id));
// Daily checks (r.daily, e.g. bulk-quote-pay) run once a day and already
// retried in-run — waiting for "two runs in a row" would mean a day's delay,
// so they confirm on their own.
const confirmed = failed.filter((f) => f.daily || prev.has(id(f)));
const checked = new Set(results.map(id));
if (now.size) {
  writeBody(`<!-- sig:${[...now].join(',')} -->\nFailed this run (not yet confirmed — alerts only if the same check fails next run too):\n\n${lines.join('\n')}\n\n${runUrl}`);
  if (watch) sh(`gh issue edit ${watch.number} --body-file /tmp/body.md`);
  else sh(`gh issue create --title "Robot shopper: watching (1 failed run)" --label robot-watch --body-file /tmp/body.md`);
} else if (watch) sh(`gh issue close ${watch.number} --comment "Clean run. ${runUrl}"`);

// 2. Confirmed outage.
const down = issue('robot-down');
// A confirmed failure of a check this run did NOT perform (a daily check,
// between its runs) is still an outage: it is carried, never "recovered".
const carried = down ? [...sigOf(down.body)].filter((s) => !checked.has(s)) : [];
if (confirmed.length) {
  const sig = [...new Set([...confirmed.map(id), ...carried])].sort().join(',');
  writeBody(`<!-- sig:${sig} -->\nFailed two runs in a row (daily checks: failed after an in-run retry):\n\n${confirmed.map((f) => `- **${id(f)}** at *${f.step}*: ${f.detail}`).join('\n')}${carried.length ? `\n\nStill failing, not rechecked this run: ${carried.join(', ')}` : ''}\n\nScreenshots: ${runUrl} (artifacts)\n\nLast checked: ${new Date().toISOString()}`);
  const products = [...new Set(confirmed.map((f) => f.product))].join(', ');
  if (!down) {
    sh(`gh issue create --title "Robot shopper: shoppers can't reach the cart" --label robot-down --body-file /tmp/body.md`);
    await email(`🚨 Checkout broken: ${products}`,
      `<p>The robot shopper failed these two runs in a row (30 min apart):</p><ul>${confirmed.map((f) => `<li><b>${esc(f.product)}</b> on ${f.device}: stuck at <i>${esc(f.step)}</i> — ${esc(f.detail)}</li>`).join('')}</ul><p><a href="${runUrl}">Run + screenshots</a></p>`);
    await page('Checkout broken', confirmed.map((f) => `${id(f)}: ${f.step}`).join('\n'));
  } else {
    const prevSig = [...sigOf(down.body)].sort().join(',');
    sh(`gh issue edit ${down.number} --body-file /tmp/body.md`);
    if (prevSig !== sig) await email('Checkout still broken (changed)', `<ul>${confirmed.map((f) => `<li>${esc(id(f))}: ${esc(f.step)} — ${esc(f.detail)}</li>`).join('')}</ul><p><a href="${runUrl}">Run</a></p>`);
  }
} else if (down && !carried.length && !failed.some((f) => sigOf(down.body).has(id(f)))) {
  sh(`gh issue close ${down.number} --comment "All clear. ${runUrl}"`);
  await email('✅ Checkout recovered', `<p>The robot shopper's checks pass again.</p><p><a href="${runUrl}">Run</a></p>`);
}

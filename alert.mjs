// Reads out/results.json; opens/updates/closes one GitHub issue and emails
// hello@ on state changes only (broken -> email once; still broken with a
// different set -> email; fixed -> one "all clear"). Silent when nothing changed.
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const results = JSON.parse(fs.readFileSync('out/results.json', 'utf8'));
const failed = results.filter((r) => !r.ok);
const flaky = results.filter((r) => r.flaky);
const LABEL = 'robot-down';
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const open = JSON.parse(sh(`gh issue list --label ${LABEL} --state open --json number,body --limit 1`))[0];
const sig = failed.map((f) => `${f.product}/${f.device}`).sort().join(',');
const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;

async function email(subject, html) {
  if (!process.env.RESEND_API_KEY) return console.log('no RESEND_API_KEY; skipping email');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Robot Shopper <alerts@thelasercraft.co>', to: ['hello@thelasercraft.co'], subject, html }),
  });
  console.log('email', r.status, await r.text());
}

async function page(title, message) {
  const token = process.env.PUSHOVER_APP_TOKEN, user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return;
  const r = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST',
    body: new URLSearchParams({ token, user, title, message: message.slice(0, 1000), priority: '2', retry: '300', expire: '3600', url: runUrl, url_title: 'Run' }) });
  console.log('page', r.status);
}

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const summary = [`${results.length - failed.length}/${results.length} product+device checks passed.`, ...failed.map((f) => `- **${f.product}** on ${f.device} — stuck at *${f.step}*: ${f.detail}`),
  ...(flaky.length ? ['', `Passed on retry (watch): ${flaky.map((f) => `${f.product}/${f.device}`).join(', ')}`] : [])].join('\n');
fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY || '/dev/null', summary + '\n');

if (failed.length) {
  const body = `<!-- sig:${sig} -->\n${summary}\n\nScreenshots: ${runUrl} (artifacts)\n\nLast checked: ${new Date().toISOString()}`;
  fs.writeFileSync('/tmp/body.md', body);
  if (!open) {
    sh(`gh issue create --title "Robot shopper: shoppers can't reach the cart" --label ${LABEL} --body-file /tmp/body.md`);
    await page("Checkout broken", failed.map((f) => `${f.product}/${f.device}: ${f.step}`).join('\n'));
    await email(`🚨 Checkout broken: ${failed.map((f) => f.product).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`,
      `<p>The robot shopper could not get these to the cart (failed twice in a row):</p><ul>${failed.map((f) => `<li><b>${esc(f.product)}</b> on ${f.device}: stuck at <i>${esc(f.step)}</i> — ${esc(f.detail)}</li>`).join('')}</ul><p><a href="${runUrl}">Run + screenshots</a></p>`);
  } else {
    const prevSig = (open.body.match(/sig:([^ ]*) -->/) || [])[1] || '';
    sh(`gh issue edit ${open.number} --body-file /tmp/body.md`);
    if (prevSig !== sig) await email('Checkout still broken (changed)', `<pre>${esc(summary)}</pre><p><a href="${runUrl}">Run</a></p>`);
  }
} else if (open) {
  sh(`gh issue close ${open.number} --comment "All clear: ${results.length}/${results.length} passed. ${runUrl}"`);
  await email('✅ Checkout recovered', `<p>All ${results.length} robot shopper checks pass again.</p><p><a href="${runUrl}">Run</a></p>`);
}

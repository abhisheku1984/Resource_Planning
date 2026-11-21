// Optional real-browser acceptance check for the guided CRM. Uses the existing
// optional Playwright dependency, no microphone, external services or user DB.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = createRequire(new URL('../voice/package.json', import.meta.url))('playwright-core');
if (!process.env.CHROME_PATH) throw Error('Set CHROME_PATH to your Chrome or Edge executable.');
const dir = await mkdtemp(path.join(os.tmpdir(), 'rp-guided-'));
process.env.DB_FILE = ':memory:'; process.env.DATA_DIR = dir;
const { app } = require('../server/index'), { q, db } = require('../server/db');
require('../server/seed').run({ quiet: true });
const project = 'Giga One';
const person = q.get(`SELECT g.assignment_id id, e.emp_code FROM giga_assignments g JOIN employees e ON e.id=g.employee_id
  JOIN projects p ON p.id=g.project_id WHERE p.code='NEXUS' AND g.project_name=? GROUP BY e.id HAVING count(*)=1 ORDER BY g.assignment_id LIMIT 1`, project);
const stored = (key) => q.get(`SELECT v.value FROM assignment_values v JOIN fields f ON f.id=v.field_id
  WHERE v.assignment_id=? AND f.key=?`, person.id, key)?.value ?? '';
const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  for (const language of ['en', 'hi']) {
    const page = await browser.newPage(), errors = [], posts = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('request', req => { if (req.method() === 'POST') posts.push(new URL(req.url()).pathname); if (!req.url().startsWith(base + '/')) errors.push(req.url()); });
    await page.goto(base); await page.fill('#login-email', 'priya.nair@resourceplanning.io'); await page.fill('#login-pw', 'Super@12345');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.locator('.assistant-launch').first().click();
    const panel = page.locator('.assistant'), msg = panel.locator('.assistant-input'), log = panel.locator('.assistant-log');
    const l = (en, hi) => language === 'hi' ? hi : en;
    const turn = async (text, reply) => {
      const count = await log.locator('.msg.user').count();
      await msg.fill(text); await msg.press('Enter');
      await log.locator('.msg.user').nth(count).waitFor();
      await log.locator('.msg.agent:not(.suggestions) .msg-body:not(.wide)').last().filter({ hasText: reply }).waitFor({ timeout: 5000 });
    };
    await panel.getByRole('button', { name: l('English','हिन्दी'), exact:true }).click();
    const note = l('Ready for a client interview','साक्षात्कार के लिए तैयार'), final = l('Interview scheduled for Monday','सोमवार को साक्षात्कार');
    const original = stored('detail_comments');
    await turn(l('Update the interview note','इंटरव्यू नोट अपडेट करें'), l(/Which Giga/, /कौन सा गीगा/));
    await turn(project, l(/Whose CRM/, /किसका CRM/));
    await turn(person.emp_code, l(/What should Detail Comments say/, /टिप्पणी में क्या दर्ज/));
    await turn(l('Set the note to ' + note, 'टिप्पणी में ' + note + ' लिखें'), l(/Save these changes/, /ये बदलाव सहेजें/));
    const input = panel.locator('[data-field-key="detail_comments"]'); assert.ok(await input.isVisible()); assert.equal(await input.inputValue(), note);
    assert.equal(stored('detail_comments'), original);
    const diff = panel.locator('.guide-preview .guide-change'); assert.ok(await diff.isVisible());
    assert.equal(await diff.locator('del').innerText(), original || l('(empty)','(खाली)')); assert.ok((await diff.innerText()).includes(note));
    await turn(l(`Actually, say “${final}”`, `नहीं, इसकी जगह ${final} लिखें`), l(/Save these changes/, /ये बदलाव सहेजें/));
    assert.equal(await input.inputValue(), final); assert.equal(stored('detail_comments'), original);
    await turn(l('Yes','हाँ'), l(/Saved CRM/, /सहेज लिए गए/)); assert.equal(stored('detail_comments'), final);
    const owner = stored('account_owner');
    await turn(l(`For ${person.emp_code} in ${project}, set the account owner to Mira and the billing start date to May 12 2027`,
      `${project} में ${person.emp_code} का खाता स्वामी में मीरा और बिलिंग शुरू होने की तारीख में १२ मई २०२७ लिखें`), l(/Save these changes/, /ये बदलाव सहेजें/));
    assert.equal(await panel.locator('[data-field-key="account_owner"]').inputValue(), l('Mira','मीरा'));
    assert.equal(await panel.locator('[data-field-key="billing_start_date"]').inputValue(), '2027-05-12');
    await turn(l('Cancel','रद्द करें'), l(/Draft discarded/, /बदलाव रद्द/)); assert.equal(stored('account_owner'), owner);
    await turn(l('How many people?','कुल कितने कर्मचारी हैं?'), l(/people in/, /कर्मचारी/));
    // Check the follow-up against real live scoped SQL, not against shown totals.
    await turn(l('Show their names','उनके नाम दिखाएं'), l(/people in/, /कर्मचारी/));
    const roster = q.all(`SELECT DISTINCT e.emp_code,e.name FROM giga_assignments g JOIN employees e ON e.id=g.employee_id
      JOIN projects p ON p.id=g.project_id WHERE p.code='NEXUS' AND g.project_name=? ORDER BY e.name,e.emp_code LIMIT 25`, project);
    const listed = await log.locator('.msg-table').last().locator('tbody tr').evaluateAll(rows => rows.map(r => [...r.cells].map(c => c.textContent)));
    assert.deepEqual(listed, roster.map(r => [r.emp_code, r.name, project]));
    assert.equal(posts.filter(x => x.endsWith('/confirm')).length, 1); assert.deepEqual(errors, []);
    console.log(`${language}: project → employee → visible note → correction → one confirmed DB write; two-field draft cancelled without a write`);
    await page.close();
  }
} finally { await browser?.close(); await new Promise(r => server.close(r)); db.close(); await rm(dir, {recursive:true, force:true}); }

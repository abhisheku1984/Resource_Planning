import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuide } from '../public/js/views/crm-guide.js';
import goalParser from '../server/agent-guide.js';

function dialogue() {
  const fields = [ ['detail_comments','Detail Comments'], ['account_owner','Account Owner'],
    ['billing_start_date','Billing Start Date'], ['billing_end_date','Billing Ended Date'], ['opp_id', 'Opp ID'], ['block_status', 'Hard Block / Soft Block'] ]
    .map(([key, label]) => ({ key, label, editable: !['opp_id','block_status'].includes(key) }));
  const draft = new Map();
  const g = createGuide({ fields, t: en => en, label: f => f.label, option: v => v, dirtyKeys: () => [...draft.keys()],
    normalize: (f, raw) => ({ value: raw }), apply: (f, value) => draft.set(f.key, value), review: () => 'review' });
  return { g, draft };
}

test('guided field planning preserves note prose, multiple fields, literal confirmations and identifiers', () => {
  const {g, draft} = dialogue();
  assert.equal(g.start('interview note to “Research and account owner to Mira” and account owner to QA-0002'), 'review');
  assert.deepEqual(Object.fromEntries(draft), { detail_comments: 'Research and account owner to Mira', account_owner: 'QA-0002' });
  assert.match(g.turn('Actually, say “Confirm save”'), /Which field/); // two changes, no guessed pronoun
  assert.deepEqual(g.choices(), ['Detail Comments', 'Account Owner']);
  assert.equal(g.turn('notes'), 'review'); assert.equal(draft.get('detail_comments'), 'Confirm save');
  assert.equal(g.turn('Actually, change that to Ready for an interview in May'), 'review');
  assert.equal(draft.get('detail_comments'), 'Ready for an interview in May');
  assert.equal(g.turn('Actually, say “account owner to Mira”'), 'review');
  assert.equal(draft.get('detail_comments'), 'account owner to Mira');
  assert.equal(draft.get('account_owner'), 'QA-0002', 'a literal replacement cannot switch fields');
});
test('ambiguous field asks which date and carries its value, unknown and read-only fields do not partially apply', () => {
  const {g, draft} = dialogue();
  g.start('billing date to May 12 2027'); assert.deepEqual(g.choices(), ['Billing Start Date','Billing Ended Date']);
  g.turn('billing end'); assert.deepEqual(Object.fromEntries(draft), { billing_end_date: 'May 12 2027' });
  assert.match(g.start('note to secret and Opp ID to X'), /read-only/); assert.equal(draft.has('detail_comments'), false);
  assert.match(g.start('block status to Hard Block'), /administrator/); assert.equal(draft.has('block_status'), false);
  assert.match(g.start('unknown field to other'), /Which field/); assert.equal(g.awaiting(), true);
  assert.match(g.start('interview note'), /What should Detail Comments say/); g.turn('Account Owner');
  assert.equal(draft.get('detail_comments'), 'Account Owner', 'a bare answer is a literal, even if it names another field');
});

test('explicitly answering a missing field value preserves the rest of the multi-field instruction', () => {
  const { g, draft } = dialogue();
  assert.match(g.start('account owner to Mira and billing date to May 12 2027 and notes'), /Which field/);
  assert.match(g.turn('billing end'), /What should Detail Comments say/);
  assert.equal(draft.size, 0);
  assert.equal(g.turn('Set the note to Confirm save'), 'review');
  assert.deepEqual(Object.fromEntries(draft), { account_owner: 'Mira', billing_end_date: 'May 12 2027', detail_comments: 'Confirm save' });
});

test('update goal grammar separates project/person from field prose in both languages; status requests stay proposals', () => {
  const { parseGuide } = goalParser;
  for (const msg of ['Please update the interview note for EMP-001 in Giga One to ready for an interview in May',
    'For EMP-001 in Giga One, set the interview note to ready for an interview in May',
    'Set the interview note to ready for an interview in May for EMP-001 in Giga One']) {
    assert.deepEqual(parseGuide(msg, 'en'), { person: 'EMP-001', project: 'Giga One', instruction: 'the interview note to ready for an interview in May' });
  }
  assert.deepEqual(parseGuide('Giga One में बिलिंग शुरू होने की तारीख अपडेट करें', 'hi'), { project:'Giga One', person:'', instruction:'बिलिंग शुरू होने की तारीख' });
  assert.deepEqual(parseGuide('टिप्पणी में साक्षात्कार के लिए तैयार लिखें', 'hi'), { project:null, person:'', instruction:'टिप्पणी में साक्षात्कार के लिए तैयार' });
  assert.equal(parseGuide('Set EMP-001 to Hard Block in Giga One', 'en'), null);
  assert.equal(parseGuide('Giga One में EMP-001 को हार्ड ब्लॉक करें', 'hi'), null);
});

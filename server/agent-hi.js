'use strict';
// Hindi command grammar for Ask, not a general translator. Split off the whole
// project clause before interpreting a question. Only translate command words
// and known workbook terms; never fuzzy-match project or employee names.
const digits = (s) => s.replace(/[०-९]/g, (d) => String('०१२३४५६७८९'.indexOf(d)));
const projectWords = new Map(Object.entries({
  'गीगा': 'giga', 'गिगा': 'giga', 'वन': 'one', 'एक': 'one', 'टू': 'two', 'दो': 'two', 'थ्री': 'three', 'तीन': 'three',
}));
const projectAlias = (s) => digits(s).split(/\s+/).map((w) => projectWords.get(w) || w).join(' ');
function projectClause(text, matches) {
  const select = text.match(/^(.+?)\s+(?:चुनें|चुनिए|चुनो)$/u);
  if (select) return { explicit: select[1], ask: '' };
  // A workbook name can itself contain “में”. Prefer the longest matching
  // complete prefix; pass unknown names to the same fail-closed resolver.
  const parts = [...text.matchAll(/\s+(?:में|के लिए)(?:\s*[:,]\s*|\s+)/gu)];
  const split = parts.findLast((m) => matches(text.slice(0, m.index)).length) || parts[0];
  return split ? { explicit: text.slice(0, split.index), ask: text.slice(split.index + split[0].length) } : null;
}

// The left column is the value/field vocabulary understood by the shared
// report engine. It still checks the actual fields and options in this DB.
const terms = [
  ['bench category', 'बेंच श्रेणी', 'बेंच कैटेगरी', 'बेंच वर्ग'], ['block status', 'ब्लॉक स्थिति', 'ब्लॉक स्टेटस'],
  ['billing status', 'बिलिंग स्थिति', 'बिलिंग स्टेटस'], ['offsite onsite', 'ऑफ़साइट ऑनसाइट', 'ऑफसाइट ऑनसाइट'], ['bl status', 'बीएल स्थिति', 'बीएल स्टेटस'],
  ['bench', 'बेंच', 'बेंच पर'], ['hard block', 'हार्ड ब्लॉक', 'हार्ड ब्लाक'], ['soft block', 'सॉफ्ट ब्लॉक', 'सॉफ़्ट ब्लॉक'], ['no block', 'कोई ब्लॉक नहीं'],
  ['billable', 'बिलेबल'], ['non-billable', 'नॉन बिलेबल', 'नॉन-बिलेबल'], ['available', 'उपलब्ध'], ['not available', 'अनुपलब्ध'],
  ['allocated', 'आवंटित'], ['partially allocated', 'आंशिक आवंटित'], ['pid allocated', 'पीआईडी आवंटित'], ['shadow', 'शैडो'],
  ['rolling off', 'रोलिंग ऑफ'], ['onboarding', 'ऑनबोर्डिंग'], ['offsite', 'ऑफसाइट', 'ऑफ़साइट'], ['onsite', 'ऑनसाइट'],
];
const aliases = new Map(terms.flatMap(([key, ...variants]) => variants.map((v) => [v, key])));
const labels = new Map(terms.map(([key, label]) => [key, label]));
function term(s) {
  if (aliases.has(s)) return aliases.get(s);
  const bl = digits(s).match(/^(?:बी\s*एल|bl)[- ]?(\d+)$/iu);
  if (bl) return 'BL-' + bl[1];
  // Accept an explicitly qualified value such as “बेंच श्रेणी शैडो” when
  // the value alone would be ambiguous. Never drop an unknown remainder.
  for (const [phrase, field] of aliases) {
    if (s.startsWith(phrase + ' ')) {
      const value = aliases.get(s.slice(phrase.length + 1));
      if (value) return field + ' ' + value;
    }
  }
  return s;
}
const label = (s) => labels.get(s.toLowerCase().replace(/_/g, ' ')) || s;
const fillers = new Set('लोग लोगों कर्मचारी कर्मचारियों व्यक्ति सदस्य पर हैं है का की के कुल बताएँ बताएं बताओ दिखाएँ दिखाएं दिखाओ दें'.split(' '));
function intent(text) {
  const open = /^(?:सी\s*आर\s*एम|c\.?\s*r\.?\s*m\.?)\s+(?:खोलें|खोलिए|खोलो)(?:\s*[:：]\s*(.+))?$/iu;
  const crm = text.match(open);
  if (crm) return crm[1] ? 'Open CRM for ' + crm[1] : 'Open CRM';
  const person = text.match(/^(.+?)\s+का\s+(.+)$/u);
  if (person && open.test(person[2])) return 'Open CRM for ' + person[1];
  const change = text.match(/^(.+?)\s+को\s+(.+?)\s+(?:करें|करो|कर दीजिए)$/u);
  if (change) return `Set ${change[1]} to ${term(change[2])}`;

  const tokens = text.toLowerCase().split(/\s+/);
  const verbs = [ ['break down', /^(?:विवरण|ब्योरा|ब्रेकडाउन)$/u], ['list', /^(?:कौन(?:[-–]कौन)?|सूची|नाम)$/u], ['count', /^(?:कितने|कितनी|संख्या|गिनती|कुल)$/u] ];
  const verb = verbs.find(([, marker]) => tokens.some((w) => marker.test(w)));
  if (!verb) return text; // also allow an English workbook command in Hindi mode
  const remainder = tokens.filter((w) => !verb[1].test(w) && !fillers.has(w)).join(' ');
  // Do not discard an unknown qualifier or answer it with unfiltered headcount.
  return verb[0] + ' ' + term(remainder);
}
const digitNames = new Map('शून्य एक दो तीन चार पाँच छह सात आठ नौ'.split(' ').map((w, i) => [w, String(i)]));
function employeeTerm(raw) {
  // Normalize only the numeric portion of an ID; preserve every leading zero.
  const numeric = (s) => digits(s).split(/\s+/).map((w) => digitNames.get(w) ?? w).join('');
  const placement = raw.match(/^प्लेसमेंट\s+(.+)$/u);
  if (placement && /^\d+$/.test(numeric(placement[1]))) return 'placement ' + numeric(placement[1]);
  const code = raw.match(/^(ई\s*एम\s*पी|[a-z](?:\s*[a-z])*)\s*(?:डैश|हाइफ़न|हाइफन|-|\s)\s*(.+)$/iu);
  if (!code || !/^\d+$/.test(numeric(code[2]))) return raw;
  return (/^ई/u.test(code[1]) ? 'EMP' : code[1].replace(/\s/g, '')) + '-' + numeric(code[2]);
}
module.exports = { projectAlias, projectClause, intent, employeeTerm, label };

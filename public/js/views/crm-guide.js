/* A bounded, local dialogue over ONE server-returned form. It may ask a
   question or stage data. There is deliberately no network/save function. */
import { fieldsHi, crmCommandHi } from './crm-hindi.js';

const aliases = {
  detail_comments: ['note', 'notes', 'interview note', 'interview notes', 'comment', 'comments', 'interview feedback', 'नोट', 'इंटरव्यू नोट', 'साक्षात्कार नोट', 'इंटरव्यू टिप्पणी'],
  interviewed_by: ['interviewer', 'interviewer name', 'इंटरव्यूअर'],
  account_owner: ['owner', 'account contact', 'खाता मालिक', 'अकाउंट ओनर'],
  account_name: ['client name', 'अकाउंट का नाम'],
  billing_start_date: ['billing start', 'billing begins', 'billing date', 'बिलिंग की तारीख', 'बिलिंग शुरू तारीख'],
  billing_end_date: ['billing end', 'billing end date', 'billing date', 'बिलिंग की तारीख', 'बिलिंग समाप्ति तारीख'],
  leader_input_this_week: ['this week’s update', "this week's update", 'this week', 'इस हफ्ते की राय'],
  leader_input_last_week: ['last week’s update', "last week's update", 'last week', 'पिछले हफ्ते की राय'],
  demand_number: ['demand id', 'डिमांड नंबर'], opp_id: ['opportunity id', 'अवसर नंबर'],
  allocation_closure_eta: ['closure date', 'closure eta', 'समापन तारीख'],
  block_status: ['block', 'block status', 'ब्लॉक स्टेटस'], bench_category: ['bench status', 'बेंच श्रेणी'],
};
const words = (s) => s.toLowerCase().replace(/[’]/g, "'").replace(/[_./-]+/g, ' ').replace(/\s+/g, ' ').trim();
const plain = (s) => s.trim().replace(/[.!?।]+$/u, '').trim();
const literal = (s) => {
  const quoted = s.trim().match(/^(?:"(.*)"|“(.*)”|‘(.*)’|'(.*)')[.!।]?$/su);
  return quoted ? quoted.slice(1).find((v) => v !== undefined) : s.trim();
};
function match(term, fields) {
  const key = words(plain(term));
  return fields.filter((f) => [f.key, f.label, fieldsHi[f.key], ...(aliases[f.key] || [])].some((v) => v && words(v) === key));
}
function part(raw, fields) {
  const text = raw.trim().replace(/^(?:please\s+)?(?:(?:also|then)\s+)?(?:(?:update|edit|add|record|set|change|fill|write)\s+)?(?:(?:an?|the)\s+)?/i, '');
  const pair = text.match(/^(.+?)(?:\s+(?:to|as|is|should (?:be|say|read)|में|को)\s+|\s*[:=]\s*)(.+)$/isu);
  const term = pair ? pair[1] : text;
  return { term, fields: match(term, fields), value: pair ? literal(pair[2]) : null };
}
// An “and” in ordinary prose is not a field boundary. Only split before a
// recognized field (or an explicit new set command); leave quoted text alone.
function parseParts(text, fields) {
  const out = []; let start = 0;
  for (const m of text.matchAll(/"[^"]*"|“[^”]*”|‘[^’]*’|'[^']*'|(\s+(?:and(?: then)?|और)\s+|[,;]\s*)/giu)) {
    if (!m[1]) continue;
    const rest = text.slice(m.index + m[0].length);
    if (!part(rest, fields).fields.length && !/^(?:set|update|change)\s+.+\s+to\s+/i.test(rest)) continue;
    out.push(part(text.slice(start, m.index), fields)); start = m.index + m[0].length;
  }
  out.push(part(text.slice(start), fields)); return out;
}
function correction(text) {
  const m = text.match(/^(?:(?:actually|no|sorry)[,،]?\s+(?:(change (?:that|it) to|make (?:that|it)|say|use|i meant)\s+)?|(i meant|make that|change (?:that|it) to|replace (?:that|it) with)\s+)(.+)$/isu)
    || text.match(/^(?:(?:नहीं|दरअसल)[,،]?\s+(?:(इसकी जगह|इसके बजाय|इसे)\s+)?|(इसकी जगह|इसके बजाय|इसे)\s+)(.+?)(?:\s+(?:लिखें|लिखो|कर दें|करें))?[।]?$/su);
  if (!m) return null;
  const value = literal(m[3]);
  return { value, valueOnly: !!(m[1] || m[2]) || value !== m[3].trim() };
}

export function createGuide({ fields, t, label, option, normalize, apply, review, dirtyKeys }) {
  let tasks = [], waiting = null, last = null;
  const common = ['detail_comments', 'account_owner', 'billing_start_date', 'interviewed_by'];
  const rank = (f) => common.includes(f.key) ? common.indexOf(f.key) : common.length;
  const editable = fields.filter((f) => f.editable).sort((a, b) => rank(a) - rank(b));
  const reset = () => { tasks = []; waiting = null; last = null; };
  const choices = () => waiting?.kind === 'field' ? waiting.options.map(label) : waiting?.field?.type === 'select'
    ? (waiting.field.options || []).map(option) : [];
  function advance() {
    waiting = null;
    const changes = new Map();
    for (const item of tasks) {
      if (item.fields.length !== 1) {
        const options = item.fields.length ? item.fields : editable;
        waiting = { kind: 'field', item, options };
        const ask = item.term ? t(`Which field did you mean by “${item.term}”?`, `“${item.term}” से आपका मतलब किस फ़ील्ड से है?`) : t('Which field would you like to update?', 'कौन सा फ़ील्ड बदलना है?');
        return ask + ' ' + options.slice(0, 5).map(label).join(', ') + (options.length > 5 ? '…' : '.');
      }
      const [f] = item.fields;
      if (!f.editable) {
        reset();
        return ['bench_category', 'block_status'].includes(f.key)
          ? t('Bench and block requests go to an administrator. Close this draft and ask “Set” followed by the employee ID and the new status. Nothing was applied.', 'बेंच और ब्लॉक बदलाव के लिए व्यवस्थापक की मंज़ूरी चाहिए। ड्राफ़्ट बंद करके कर्मचारी आईडी के साथ प्रस्ताव दें। कोई बदलाव लागू नहीं हुआ।')
          : t(`${f.label} is read-only. Nothing was applied.`, `${label(f)} केवल पढ़ने के लिए है। कोई बदलाव लागू नहीं हुआ।`);
      }
      const normalized = item.value === null ? null : normalize(f, item.value);
      if (!normalized || normalized.error) {
        item.value = null; waiting = { kind: 'value', item, field: f };
        const ask = t(`What should ${f.label} say?`, `${label(f)} में क्या दर्ज करूँ?`);
        const hints = choices();
        return [normalized?.error, ask, hints.length ? hints.join(' / ') : ''].filter(Boolean).join(' ');
      }
      if (changes.has(f)) { reset(); return t(`You named ${f.label} twice. Please give one value for it.`, `${label(f)} के लिए दो मान मिले हैं। कृपया एक मान बताएं।`); }
      changes.set(f, normalized.value);
    }
    // Do not partially apply a multi-field utterance if one part is invalid.
    last = changes.size === 1 ? [...changes.keys()][0] : null;
    for (const [f, value] of changes) apply(f, value);
    tasks = [];
    return review();
  }
  function start(instruction) {
    reset(); tasks = parseParts(instruction, fields); return advance();
  }
  function turn(text) {
    const replacement = correction(text), phrase = replacement?.value ?? text;
    const canonical = crmCommandHi(phrase); // accepts English too; values stay literal
    const explicit = parseParts(canonical, fields);
    if (!replacement?.valueOnly && explicit[0].fields.length && (!waiting || explicit[0].value !== null)) {
      // Answering the outstanding question with “set <field> to …” must
      // not drop already-resolved siblings from the same multi-field turn.
      if (waiting && explicit[0].fields.length === 1 &&
          (waiting.kind === 'field' ? waiting.options : [waiting.field]).includes(explicit[0].fields[0])) {
        tasks.splice(tasks.indexOf(waiting.item), 1, ...explicit);
      } else tasks = explicit;
      return advance();
    }
    if (waiting?.kind === 'field') {
      const found = match(phrase, waiting.options);
      if (found.length === 1) waiting.item.fields = found;
      return advance();
    }
    if (waiting?.kind === 'value') { waiting.item.value = literal(phrase); return advance(); }
    if (replacement !== null) {
      const options = last ? [last] : fields.filter((f) => dirtyKeys().includes(f.key));
      tasks = [{ term: '', fields: options, value: replacement.value }]; return advance();
    }
    tasks = explicit; return advance();
  }
  return { start, turn, reset, choices, namesField: (text) => part(text, fields).fields.length > 0, awaiting: () => !!waiting, activeField: () => waiting?.field?.key || last?.key };
}

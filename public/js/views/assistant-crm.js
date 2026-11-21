/* Keystrokes and dictation edit the same scoped draft. Changing language
   preserves its values, but invalidates the review. There is NO autosave. */
import { h, mount, api } from '../core.js';
import { fieldsHi, optionsHi, crmCommandHi, hindiDate, digits } from './crm-hindi.js';

const words = (v) => String(v).toLowerCase().replace(/[_/.-]+/g, ' ').replace(/\s+/g, ' ').trim();
function dateValue(value) {
  const clean = value.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1').replace(/,/g, '');
  let iso = clean;
  if (!/^\d{4}-\d\d-\d\d$/.test(clean)) {
    const months = 'january february march april may june july august september october november december'.split(' ');
    const m = clean.match(/^(?:(\d{1,2}) (\w+)|(\w+) (\d{1,2})) (\d{4})$/);
    if (!m) return '';
    const month = months.indexOf((m[2] || m[3]).toLowerCase()) + 1;
    iso = `${m[5]}-${String(month).padStart(2, '0')}-${(m[1] || m[4]).padStart(2, '0')}`;
  }
  const d = new Date(iso + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === iso ? iso : '';
}
export function createAssistantCrm(host, onCommand, getLanguage = () => 'en') {
  let form = null, reviewed = false, saving = false;
  const controls = new Map(), draft = new Map();
  const hi = () => getLanguage() === 'hi';
  const t = (en, hindi) => hi() ? hindi : en;
  const label = (f) => hi() && Object.hasOwn(fieldsHi, f.key) ? fieldsHi[f.key] : f.label;
  const option = (v) => hi() && Object.hasOwn(optionsHi, v) ? optionsHi[v] : v;
  const display = (f, v) => f.type === 'select' ? option(v) : v;
  const identity = () => `${form.name} (${form.empCode})` + t(' in ', ', प्रोजेक्ट ') + form.projectName;
  function clear() { form = null; draft.clear(); controls.clear(); reviewed = false; saving = false; mount(host); }
  function update(f, value) {
    reviewed = false;
    if (String(f.value) === value) draft.delete(f.key); else draft.set(f.key, value);
    controls.get(f.key).value = value;
    controls.get(f.key).classList.toggle('is-changed', draft.has(f.key));
  }
  function render() {
    if (!form) return;
    controls.clear();
    const close = t('Close CRM', 'सीआरएम बंद करें'), review = t('Review changes', 'बदलाव की समीक्षा करें');
    mount(host, h('div', { class: 'spread' }, h('strong', null, t('Employee CRM', 'कर्मचारी CRM')),
      h('button', { class: 'btn btn-xs', disabled: saving, onclick: () => onCommand(close) }, close)),
      h('div', { class: 'subtle' }, identity()),
      h('details', { open: true }, h('summary', null, `${t('CRM fields', 'CRM फ़ील्ड')} (${form.fields.length})`),
        ...form.fields.map((f) => {
          const input = f.type === 'select' ? h('select', { class: 'select' },
            h('option', { value: '' }, t('Not set', 'खाली')), ...(f.options || []).map((v) => h('option', { value: v }, option(v))))
            : f.type === 'textarea' ? h('textarea', { class: 'textarea', rows: 2 }) : h('input', { class: 'input', type: f.type || 'text' });
          input.disabled = saving || !f.editable; input.value = draft.get(f.key) ?? f.value; input.dataset.fieldKey = f.key;
          input.classList.toggle('is-changed', draft.has(f.key));
          input.addEventListener('input', () => update(f, input.value)); controls.set(f.key, input);
          return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label(f) === f.label ? f.label : `${label(f)} · ${f.label}`), input);
        })),
      form.fields.some((f) => f.editable) ? h('button', { class: 'btn btn-sm', disabled: saving, onclick: () => onCommand(review) }, review) : null);
  }
  function show(next) { clear(); form = next; render(); }
  function changeLanguage() { reviewed = false; render(); }
  async function command(message) {
    const text = hi() ? crmCommandHi(message) : message;
    const cmd = text.trim().replace(/[.!?।]+$/u, ''), lower = cmd.toLowerCase();
    if (/^(?:discard changes|cancel|cancel changes)$/.test(lower)) {
      for (const f of form.fields) update(f, String(f.value));
      return t('Draft discarded. Nothing was saved.', 'बदलाव रद्द कर दिए गए। कुछ भी नहीं सहेजा गया।');
    }
    if (lower === 'close crm') {
      if (draft.size) return t('There are unsaved CRM changes. Say “review changes” to save or “discard changes” before closing.', 'अभी बदलाव नहीं सहेजे गए हैं। “बदलाव की समीक्षा करें” या बंद करने से पहले “बदलाव रद्द करें” कहें।');
      clear(); return t('CRM closed. You can ask another project question.', 'CRM बंद है। अब प्रोजेक्ट के बारे में दूसरा सवाल पूछ सकते हैं।');
    }
    if (/^(?:list|read|show) (?:the )?fields$/.test(lower)) return t('CRM fields: ', 'CRM फ़ील्ड: ') + form.fields.map(label).join('; ') + '.';
    if (/^(?:review(?: changes)?|save(?: changes)?|save crm)$/.test(lower)) {
      if (!draft.size) return t('No CRM changes to save.', 'सहेजने के लिए कोई बदलाव नहीं है।');
      reviewed = true;
      const changes = [...draft].map(([key, val]) => {
        const f = form.fields.find((f) => f.key === key);
        return `${label(f)}: ${display(f, val) || t('(clear)', '(खाली)')}`;
      }).join('; ');
      return t('Review for ', 'बदलाव की समीक्षा: ') + identity() + ': ' + changes + t('. Say “confirm save” to write these changes, or “discard changes”.', '। बदलाव लिखने के लिए “सहेजने की पुष्टि करें” या “बदलाव रद्द करें” कहें।');
    }
    if (lower === 'confirm save') {
      if (!draft.size || !reviewed || saving) return t('First say “review changes” and check the employee and values.', 'पहले “बदलाव की समीक्षा करें” कहें और कर्मचारी व दर्ज किए गए मान जाँचें।');
      reviewed = false; saving = true;
      const target = form;
      for (const input of controls.values()) input.disabled = true;
      try {
        const res = await api(`/employees/${form.assignmentId}/submit`, { method: 'POST', body: {
          crmProjectName: form.projectName, changes: Object.fromEntries(draft), rev: form.rev, reason: 'Confirmed CRM form in assistant',
        } });
        if (target !== form) return '';
        const reply = t(`Saved CRM changes for ${identity()}.`, `${identity()} के CRM बदलाव सहेज लिए गए हैं।`);
        show({ ...form, rev: res.record.rev, fields: form.fields.map((f) => ({ ...f, value: res.record.values[f.key] ?? '' })) });
        document.dispatchEvent(new CustomEvent('rp:data-changed'));
        return reply;
      } catch (err) {
        if (target !== form) return '';
        if ([401, 403, 404, 409].includes(err.status)) { clear(); return t(`Not saved. ${err.message} Reopen the CRM record to review it.`, `बदलाव नहीं सहेजे गए। ${err.message} जाँच के लिए CRM रिकॉर्ड फिर खोलें।`); }
        const reason = Object.values(err.data?.errors || {})[0] || err.message;
        return t(`Not saved. ${reason} Review your draft again before retrying.`, `बदलाव नहीं सहेजे गए। ${reason} फिर कोशिश करने से पहले बदलाव की समीक्षा करें।`);
      } finally {
        saving = false;
        if (form === target) for (const f of form.fields) controls.get(f.key).disabled = !f.editable;
      }
    }
    const set = text.trim().match(/^(?:set|change|fill)\s+(.+?)\s+to\s+(.+)$/is);
    const op = cmd.match(/^(read|clear)\s+(.+)$/i);
    if (!set && !op) return t('In CRM, say “list fields”, “read Detail Comments”, “set Detail Comments to” and your note, “review changes”, or “close CRM”.', 'CRM में “फ़ील्ड बताएं”, “टिप्पणी पढ़ें”, “टिप्पणी में अपना नोट लिखें”, “बदलाव की समीक्षा करें” या “सीआरएम बंद करें” कहें।');
    const key = words(set ? set[1] : op[2]);
    const matches = form.fields.filter((f) => [f.label, f.key, label(f)].some((k) => words(k) === key));
    if (matches.length !== 1) return t('That field is not on this CRM form or is ambiguous. Say “list fields” for its exact labels.', 'फ़ील्ड की पहचान नहीं हो सकी। सही नाम सुनने के लिए “फ़ील्ड बताएं” कहें।');
    const f = matches[0];
    if (op?.[1].toLowerCase() === 'read') return `${label(f)}: ${display(f, draft.get(f.key) ?? f.value) || t('not set', 'खाली')}.`;
    if (!f.editable) return t(`${f.label} is read-only. Nothing was changed.`, `${label(f)} केवल पढ़ने के लिए है। कोई बदलाव नहीं हुआ।`);
    let value = set ? set[2].trim() : '';
    if (!value && f.required) return t(`${f.label} is required.`, `${label(f)} खाली नहीं हो सकता।`);
    if (value && f.type === 'select') {
      value = (f.options || []).find((v) => [v, option(v)].some((o) => words(o) === words(value)));
      if (!value) return t('Choose one of: ', 'इनमें से एक चुनें: ') + (f.options || []).map(option).join(', ') + '.';
    } else if (value && f.type === 'date') {
      const clean = value.replace(/[.!?।]+$/u, ''); value = dateValue(hi() ? hindiDate(clean) : clean);
      if (!value) return t('Use a date like “May 12 2027” or YYYY-MM-DD.', 'तारीख “१२ मई २०२७” या YYYY-MM-DD के रूप में दें।');
    } else if (value && f.type === 'number') {
      if (hi()) value = digits(value);
      if (!Number.isFinite(Number(value))) return t('Please give a number.', 'कृपया कोई संख्या दें।');
    }
    update(f, value);
    return t(`Draft ${f.label}: ${value || '(clear)'}. Not saved. Dictate another field or say “review changes”.`, `ड्राफ़्ट में ${label(f)}: ${display(f, value) || '(खाली)'}। अभी सहेजा नहीं गया है। अगला फ़ील्ड भरें या “बदलाव की समीक्षा करें” कहें।`);
  }
  return { show, clear, command, changeLanguage, isOpen: () => !!form, isSaving: () => saving, reviewReady: () => reviewed };
}

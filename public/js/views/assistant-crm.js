/* A scoped CRM editor inside Ask. Keystrokes and dictation edit the same draft.
   There is deliberately NO autosave here: read back the employee and changes,
   then require a separate confirmation before the normal CRM write. */
import { h, mount, api } from '../core.js';

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
export function createAssistantCrm(host, onCommand) {
  let form = null, draft = new Map(), reviewed = false, saving = false;
  const controls = new Map();
  const identity = () => `${form.name} (${form.empCode}) in ${form.projectName}`;
  function clear() { form = null; draft.clear(); controls.clear(); reviewed = false; saving = false; mount(host); }
  function update(f, value) {
    reviewed = false;
    if (String(f.value) === value) draft.delete(f.key); else draft.set(f.key, value);
    controls.get(f.key).value = value;
    controls.get(f.key).classList.toggle('is-changed', draft.has(f.key));
  }
  function show(next) {
    clear(); form = next;
    mount(host, h('div', { class: 'spread' }, h('strong', null, 'Employee CRM'),
      h('button', { class: 'btn btn-xs', onclick: () => onCommand('Close CRM') }, 'Close CRM')),
      h('div', { class: 'subtle' }, identity()),
      h('details', { open: true }, h('summary', null, `CRM fields (${form.fields.length})`),
        ...form.fields.map((f) => {
          const input = f.type === 'select' ? h('select', { class: 'select' },
            h('option', { value: '' }, 'Not set'), ...(f.options || []).map((v) => h('option', { value: v }, v)))
            : f.type === 'textarea' ? h('textarea', { class: 'textarea', rows: 2 }) : h('input', { class: 'input', type: f.type || 'text' });
          input.disabled = !f.editable; input.value = f.value; input.dataset.fieldKey = f.key;
          input.addEventListener('input', () => update(f, input.value));
          controls.set(f.key, input);
          return h('label', { class: 'field' }, h('span', { class: 'field-label' }, f.label), input);
        })),
      form.fields.some((f) => f.editable) ? h('button', { class: 'btn btn-sm', onclick: () => onCommand('Review changes') }, 'Review changes') : null);
  }
  async function command(text) {
    const cmd = text.trim().replace(/[.!?]+$/, ''), t = cmd.toLowerCase();
    if (/^(?:discard changes|cancel|cancel changes)$/.test(t)) {
      for (const f of form.fields) update(f, String(f.value));
      return 'Draft discarded. Nothing was saved.';
    }
    if (t === 'close crm') {
      if (draft.size) return 'There are unsaved CRM changes. Say “review changes” to save or “discard changes” before closing.';
      clear(); return 'CRM closed. You can ask another project question.';
    }
    if (/^(?:list|read|show) (?:the )?fields$/.test(t)) return 'CRM fields: ' + form.fields.map((f) => f.label).join('; ') + '.';
    if (/^(?:review(?: changes)?|save(?: changes)?|save crm)$/.test(t)) {
      if (!draft.size) return 'No CRM changes to save.';
      reviewed = true;
      return `Review for ${identity()}: ` + [...draft].map(([key, val]) => `${form.fields.find((f) => f.key === key).label}: ${val || '(clear)'}`).join('; ') + '. Say “confirm save” to write these changes, or “discard changes”.';
    }
    if (t === 'confirm save') {
      if (!draft.size || !reviewed || saving) return 'First say “review changes” and check the employee and values.';
      reviewed = false; saving = true;
      const target = form;
      for (const input of controls.values()) input.disabled = true;
      try {
        const res = await api(`/employees/${form.assignmentId}/submit`, { method: 'POST', body: {
          crmProjectName: form.projectName, changes: Object.fromEntries(draft), rev: form.rev, reason: 'Confirmed CRM form in assistant',
        } });
        if (target !== form) return '';
        const reply = `Saved CRM changes for ${identity()}.`;
        show({ ...form, rev: res.record.rev, fields: form.fields.map((f) => ({ ...f, value: res.record.values[f.key] ?? '' })) });
        document.dispatchEvent(new CustomEvent('rp:data-changed'));
        return reply;
      } catch (err) {
        if (target !== form) return '';
        if ([401, 403, 404, 409].includes(err.status)) { clear(); return `Not saved. ${err.message} Reopen the CRM record to review it.`; }
        return `Not saved. ${Object.values(err.data?.errors || {})[0] || err.message} Review your draft again before retrying.`;
      } finally {
        saving = false;
        if (form === target) for (const f of form.fields) controls.get(f.key).disabled = !f.editable;
      }
    }
    const set = text.trim().match(/^(?:set|change|fill)\s+(.+?)\s+to\s+(.+)$/is);
    const op = cmd.match(/^(read|clear)\s+(.+)$/i);
    if (!set && !op) return 'In CRM, say “list fields”, “read Detail Comments”, “set Detail Comments to” and your note, “review changes”, or “close CRM”.';
    const key = words(set ? set[1] : op[2]);
    const field = form.fields.find((f) => [words(f.label), words(f.key)].includes(key));
    if (!field) return 'That field is not on this CRM form. Say “list fields” for its exact labels.';
    if (op?.[1].toLowerCase() === 'read') return `${field.label}: ${draft.get(field.key) ?? (field.value || 'not set')}.`;
    if (!field.editable) return `${field.label} is read-only. Nothing was changed.`;
    let value = set ? set[2].trim() : '';
    if (!value && field.required) return `${field.label} is required.`;
    if (value && field.type === 'select') {
      value = (field.options || []).find((v) => words(v) === words(value));
      if (!value) return `Choose one of: ${(field.options || []).join(', ')}.`;
    } else if (value && field.type === 'date') {
      value = dateValue(value.replace(/[.!?]+$/, ''));
      if (!value) return 'Use a date like “May 12 2027” or YYYY-MM-DD.';
    } else if (value && field.type === 'number' && !Number.isFinite(Number(value))) return 'Please give a number.';
    update(field, value);
    return `Draft ${field.label}: ${value || '(clear)'}. Not saved. Dictate another field or say “review changes”.`;
  }
  return { show, clear, command, isOpen: () => !!form, reviewReady: () => reviewed };
}

import { api, downloadExport, fmtNum, h, modal, mount, spinner, state, toast } from '../core.js';

// Both merge and replacement use the browser's native encoder. No Office app,
// cloud account, or function call with one argument per workbook byte.
export function readWorkbook(file) {
  return new Promise((resolve, reject) => {
    if (!/\.xlsx$/i.test(file.name)) return reject(new Error('Choose an Excel .xlsx workbook.'));
    if (state.user?.browserDemo && file.size > 15_000_000) return reject(new Error('Choose the sample workbook or an export from this tab.'));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read this file. Select the local .xlsx workbook again.'));
    reader.readAsDataURL(file);
  });
}

export function openRosterReplacement(placementPicker) {
  const host = h('div', { class: 'col', style: { gap: '12px' } });
  const footer = h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end', width: '100%' } });
  const ref = modal({ title: 'Replace entire roster', subtitle: 'Administrator · full daily workbook only', body: host, footer, size: 'modal-lg' });
  const cancel = h('button', { class: 'btn', onclick: () => ref.close() }, 'Cancel');
  const step = text => h('div', { class: 'crm-section-title' }, text);
  const message = h('div', { role: 'alert' });
  const fail = err => mount(message, h('div', { class: 'note warn' }, err.message));
  const busy = (btn, label) => { btn.disabled = true; btn.replaceChildren(spinner(), label); mount(message); };
  let archive;

  const exportBtn = h('button', { class: 'btn btn-primary', onclick: async () => {
    busy(exportBtn, 'Exporting…');
    try {
      archive = await downloadExport({ forReplacement: 1 }); // no filters or project scope
      if (!archive.receipt) throw new Error('The server did not confirm a full export. Update the app before replacing the roster.');
      if (ref.box.isConnected) chooseFile();
    } catch (err) { fail(err); exportBtn.disabled = false; exportBtn.textContent = 'Export current roster'; }
  } }, 'Export current roster');
  mount(host, step('1 of 3 · Save the current roster'),
    h('p', null, 'Download all current placements before loading the next full dataset. Save the dated .xlsx in your team’s private archive. No Microsoft 365 or Excel installation is needed.'),
    h('div', { class: 'note warn' }, 'Replacement removes all old employees, placements, manual edits and group memberships. Accounts, access, project setup and audit history stay. For a file containing only changes, cancel and use Upload a daily dataset instead.'), message);
  mount(footer, cancel, exportBtn);

  function chooseFile() {
    const place = {};
    const file = h('input', { class: 'input', type: 'file', accept: '.xlsx', id: 'roster-file', onchange: () => { preview.disabled = !file.files[0]; } });
    const preview = h('button', { class: 'btn btn-primary', disabled: true, onclick: async () => {
      const chosen = file.files[0];
      if (!chosen) return;
      file.disabled = true; busy(preview, 'Checking workbook…');
      try {
        const payload = { receipt: archive.receipt, filename: chosen.name, ...(place.categoryId ? { ...place } : {}), content: await readWorkbook(chosen) };
        const { result } = await api('/import/replace', { method: 'POST', body: { ...payload, dryRun: true } });
        if (ref.box.isConnected) review(result, payload);
      } catch (err) { fail(err); file.disabled = false; preview.disabled = false; preview.textContent = 'Preview replacement'; }
    } }, 'Preview replacement');
    mount(message);
    mount(host, step('2 of 3 · Choose the complete new roster'),
      h('div', { class: 'note' }, `Export: ${archive.filename} · ${fmtNum(archive.rows)} placements. Check that your download was saved before continuing.`),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'roster-file' }, state.user.browserDemo ? 'Sample workbook (unchanged fixture or export from this tab)' : 'New full workbook (.xlsx)'), file),
      placementPicker(place), h('div', { class: 'subtle' }, 'Preview does not change the current roster.'), message);
    mount(footer, cancel, preview);
  }

  function review(r, payload) {
    const counts = v => `${fmtNum(v.people)} people · ${fmtNum(v.placements)} placements`;
    const again = h('button', { class: 'btn', onclick: chooseFile }, 'Choose another file');
    mount(message);
    mount(host, step('3 of 3 · Review before deleting anything'),
      h('div', { class: 'field' }, h('strong', null, 'Current roster to delete'), h('span', null, `${counts(r.before)} · ${fmtNum(r.before.locks)} protected values`)),
      h('div', { class: 'field' }, h('strong', null, 'New roster from ', payload.filename), h('span', null, counts(r.after))));
    if (!r.canReplace) {
      host.append(h('div', { class: 'note warn', role: 'alert' }, `Replacement blocked. ${fmtNum(r.errors.length)} issues · ${fmtNum(r.flagged)} possible duplicates. Your old roster is unchanged.`),
        ...r.errors.slice(0, 20).map(e => h('div', { class: 'subtle' }, `${e.row ? `Row ${e.row}: ` : ''}${e.message}`)));
      mount(footer, cancel, again);
      return;
    }
    const confirm = h('input', { class: 'input', id: 'roster-confirm', autocomplete: 'off', placeholder: 'REPLACE',
      oninput: () => { apply.disabled = confirm.value !== 'REPLACE'; } });
    const apply = h('button', { class: 'btn btn-danger', disabled: true, onclick: async () => {
      busy(apply, 'Replacing roster…'); confirm.disabled = true; again.disabled = true; cancel.disabled = true;
      try {
        const { result } = await api('/import/replace', { method: 'POST', body: { ...payload, confirmation: confirm.value } });
        if (ref.box.isConnected) ref.close();
        toast('Roster replaced', counts(result.after), 'success', 6500);
        document.dispatchEvent(new CustomEvent('rp:data-changed'));
      } catch (err) {
        apply.textContent = 'Check replacement status';
        fail(err.status === 0 ? new Error('Connection interrupted. Check Dashboard and Recent uploads before retrying.') : err);
        cancel.disabled = false; again.disabled = err.status === 409;
        // No blind retry if the response was lost after commit. A new preview
        // checks whether the export receipt is still valid.
      }
    } }, 'Delete old roster and import');
    host.append(h('div', { class: 'note' }, state.user.browserDemo ? 'This replaces only the sample roster in this tab. The export is your copy of any edits; reloading restores the original 1,000 samples.' : 'No row issues or duplicate placements. The old roster stays visible until the new one is ready. A private database restore point is saved before replacement.'),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'roster-confirm' }, 'If your export is saved and these totals are correct, type REPLACE.'), confirm), message);
    mount(footer, cancel, again, apply);
  }
}

import { api, h, modal, closeModal, state, toast } from '../public/js/core.js';
export async function openAccountModal() {
  try {
    const {personas} = await api('/demo/personas');
    const picker = h('select', {class:'select', id:'persona'}, ...personas.map(p => h('option', {value:p.id,selected:p.id === state.user.id}, `${p.name} · ${p.title}`)));
    modal({title:'Sample workspace', subtitle:'Try the administrator or a project supervisor. No sign-in required.',
      body:h('div', {class:'col',style:{gap:'12px'}}, h('label',{for:'persona',class:'field-label'},'View as'), picker,
        h('p',null,'Changes stay in this tab until you reload. Use the private app for actual employee records and shared edits.')),
      footer:[h('button',{class:'btn',onclick:closeModal},'Cancel'),h('button',{class:'btn btn-primary',onclick:async () => {
        try { await api('/demo/persona',{method:'POST',body:{id:Number(picker.value)}}); closeModal();
          document.dispatchEvent(new CustomEvent('rp:logout')); location.hash='#/dashboard'; await window.__rp.refreshAll(); }
        catch (err) { toast('Could not switch view',err.message,'error'); }
      }},'Open workspace')]});
  } catch (err) { toast('Could not load sample accounts',err.message,'error'); }
}
export function renderLogin(root) {
  // Never solicit a password on the public website, even after a startup error.
  root.replaceChildren(h('div',{class:'empty'},h('h1',null,'Sample workspace could not start'),
    h('p',null,'No account is required. Use a current browser with JavaScript and WebAssembly enabled.'),
    h('button',{class:'btn',onclick:()=>location.reload()},'Reload workspace')));
}

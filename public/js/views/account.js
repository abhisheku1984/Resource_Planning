import { h, api, state, returnToSignIn, modal, toast, icon, initials } from '../core.js';

export function openAccountModal() {
  const user = state.user || {};
  const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'hidden' });

  const saveBtn = h('button', {
    class: 'btn btn-primary',
    onclick: async () => {
      err.classList.add('hidden');
      if (next.value.length < 8) {
        mountErr('Use at least 8 characters for the new password.');
        return;
      }
      saveBtn.disabled = true;
      try {
        await api('/auth/password', { method: 'POST', body: { current: current.value, next: next.value } });
        toast('Password updated', 'Please sign in again with your new password.', 'success');
        returnToSignIn();
      } catch (e) {
        mountErr(e.message);
        saveBtn.disabled = false;
      }
    },
  }, 'Update password');

  function mountErr(msg) {
    err.replaceChildren(h('div', { class: 'note warn' }, icon('alert', 15), msg));
    err.classList.remove('hidden');
  }

  modal({
    title: 'Account & session',
    subtitle: 'Review your access and update your password.',
    body: h('div', null,
      h('div', { class: 'row', style: { gap: '12px', paddingBottom: '16px', borderBottom: '1px solid var(--line)' } },
        h('div', { class: 'avatar avatar-lg' }, initials(user.name)),
        h('div', { class: 'col grow' },
          h('div', { style: { fontWeight: '650', fontSize: '14px' } }, user.name),
          h('div', { class: 'muted', style: { fontSize: '12.5px' } }, user.email),
          h('div', { class: 'row', style: { marginTop: '5px', gap: '6px' } },
            h('span', { class: `badge ${user.isAdmin ? 'badge-brand' : 'badge-neutral'}` }, user.isAdmin ? 'Administrator' : 'Supervisor'),
            h('span', { class: 'badge badge-outline' }, user.gigaAccess ? (user.gigaAccess.name ? '1 Giga project' : 'No project access') : `${user.projects?.length || 0} project${user.projects?.length === 1 ? '' : 's'}`),
          ),
        ),
      ),
      h('div', { style: { paddingTop: '16px' } },
        user.gigaAccess ? h('div', { class: 'note' }, icon('shield', 15), user.gigaAccess.name
          ? `Giga Project Name: ${user.gigaAccess.name}. Only matching records are accessible.` : 'No project access assigned.') : null,
        h('div', { class: 'crm-section-title' }, user.gigaAccess ? 'Placements in your Giga project' : 'Authorized projects'),
        (user.projects || []).length
          ? h('div', { class: 'col', style: { gap: '6px' } },
            ...user.projects.map((p) => h('div', { class: 'spread', style: { fontSize: '12.5px' } },
              h('span', { class: 'row', style: { gap: '7px' } }, icon('folder', 14), p.name),
              h('span', { class: 'row', style: { gap: '5px' } },
                h('span', { class: `badge ${p.can_edit ? 'badge-success' : 'badge-warn'}` }, p.can_edit ? 'Edit' : 'Read only'),
                p.can_export ? h('span', { class: 'badge badge-info' }, 'Export') : null,
                p.can_crm ? h('span', { class: 'badge badge-brand' }, 'CRM') : null,
              ),
            )),
          )
          : h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'No projects assigned. Ask an administrator for access.'),
        h('div', { class: 'crm-section-title' }, 'Change password'),
        h('div', { class: 'crm-grid' },
          h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Current password'), current),
          h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'New password'), next),
        ),
        err,
        h('div', { class: 'row', style: { marginTop: '12px', justifyContent: 'flex-end' } }, saveBtn),
      ),
    ),
    footer: h('div', { class: 'spread', style: { width: '100%' } },
      h('button', {
        class: 'btn btn-danger',
        onclick: () => signOut(),
      }, icon('logout', 15), 'Sign out'),
      h('button', { class: 'btn', onclick: () => document.querySelector('.overlay')?.remove() }, 'Close'),
    ),
  });
}

async function signOut() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  returnToSignIn();
}

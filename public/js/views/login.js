import { h, mount, icon, api, setToken, state, spinner } from '../core.js';

export function renderLogin(root, onSuccess, notice = '') {
  const emailInput = h('input', { class: 'input', type: 'email', name: 'email', autocomplete: 'username', placeholder: 'you@company.com', required: true });
  const pwInput = h('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'current-password', placeholder: 'Enter your password', required: true });
  const errBox = h('div', { class: 'hidden', role: 'alert' });
  const submitBtn = h('button', { class: 'btn btn-primary btn-block', type: 'submit', style: { height: '38px' } }, 'Sign in');
  const form = h('form', { onsubmit: submit, novalidate: true },
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'login-email' }, 'Work email'), emailInput),
    h('div', { class: 'field', style: { marginTop: '13px' } }, h('label', { class: 'field-label', for: 'login-pw' }, 'Password'), pwInput),
    errBox,
    h('div', { style: { marginTop: '18px' } }, submitBtn),
  );
  emailInput.id = 'login-email';
  pwInput.id = 'login-pw';

  async function submit(e) {
    e.preventDefault();
    errBox.classList.add('hidden');
    emailInput.classList.remove('is-error');
    pwInput.classList.remove('is-error');
    if (!emailInput.value.trim() || !pwInput.value) {
      showError('Enter your email and password to continue.');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.replaceChildren(spinner(), 'Signing in…');
    try {
      const data = await api('/auth/login', { method: 'POST', body: { email: emailInput.value.trim(), password: pwInput.value } });
      setToken(data.token);
      state.user = data.user;
      onSuccess();
    } catch (err) {
      if (err.status === 401) pwInput.value = '';
      showError(err.message || 'Sign-in failed.');
      submitBtn.disabled = false;
      submitBtn.replaceChildren('Sign in');
    }
  }

  function showError(msg) {
    mount(errBox, h('div', { class: 'note warn', style: { marginTop: '14px' } }, icon('alert', 15), msg));
    errBox.classList.remove('hidden');
  }

  mount(root,
    h('div', { class: 'auth-shell' },
      h('aside', { class: 'auth-aside' },
        h('div', { class: 'row', style: { gap: '11px' } },
          h('div', { class: 'brand-mark' }, 'RP'),
          h('div', { class: 'col' },
            h('div', { style: { color: '#fff', fontWeight: '650', fontSize: '14px' } }, 'Resource Planning'),
            h('div', { class: 'brand-sub' }, 'Workforce data platform'),
          ),
        ),
        h('div', { style: { position: 'relative', zIndex: '1' } },
          h('h1', null, 'One source of truth for every project, person and placement.'),
          h('p', null, 'Drill from programme to subproject to category, update records inline, and keep a complete audit trail — without emailing spreadsheets.'),
          h('div', { class: 'auth-features' },
            feature('layers', 'Project drill-down', 'Programme → subproject → category with per-category permissions.'),
            feature('columns', 'Dynamic data tables', 'Columns adapt to the selected category, configured by the administrator.'),
            feature('contact', 'Embedded CRM', 'Search, create and update people without leaving the project.'),
            feature('download', 'Live Excel exports', 'Consolidated workbooks generated from the database on demand.'),
          ),
        ),
        h('div', { style: { color: '#6f819c', fontSize: '12px', position: 'relative', zIndex: '1' } },
          `© ${new Date().getFullYear()} Resource Planning · Built for delivery supervisors`),
      ),
      h('main', { class: 'auth-main' },
        h('div', { class: 'auth-card' },
          h('div', { class: 'auth-title' }, 'Sign in'),
          h('div', { class: 'auth-sub' }, 'Enter your own work email and password to access your projects.'),
          notice ? h('div', { class: 'note warn', style: { marginBottom: '14px' } }, icon('alert', 15), notice) : null,
          form,
        ),
      ),
    ),
  );
}

const feature = (iconName, title, desc) =>
  h('div', { class: 'auth-feature' },
    h('div', { class: 'auth-feature-icon' }, icon(iconName, 15)),
    h('div', null,
      h('div', { class: 'auth-feature-t' }, title),
      h('div', { class: 'auth-feature-d' }, desc),
    ),
  );

'use strict';
/**
 * Checks the five filter dropdowns against a running server.
 *
 *   npm start                 # in one window
 *   node scripts/check-filters.js
 *
 * It signs in as the administrator, asks for the Employee Directory exactly the
 * way the browser does (no project filter), and prints the values and counts the
 * five dropdowns are built from. Then it picks one value in each and confirms
 * the header total becomes that value's count -- the "exact number" the
 * requirement asks for.
 *
 * Options (environment variables):
 *   BASE_URL  default http://localhost:4000
 *   EMAIL     your assigned sign-in email (required)
 *   PASSWORD  your own password (required; never commit it)
 */

const BASE = (process.env.BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const { EMAIL, PASSWORD } = process.env;
if (!EMAIL || !PASSWORD) {
  console.error('Set EMAIL and PASSWORD for your own account before running the check.');
  process.exit(1);
}

// The five dimensions the filter is allowed to expose.
const FIVE = ['billing_status', 'bench_category', 'bl_status', 'offsite_onsite', 'giga_project_name'];

async function api(path, token, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned ${res.status} and not JSON: ${text.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${json.error || ''}`.trim());
  return json;
}

(async () => {
  let failures = 0;
  const fail = (msg) => {
    failures += 1;
    console.log(`   FAIL  ${msg}`);
  };

  console.log(`Server   ${BASE}`);
  let token;
  try {
    token = (await api('/auth/login', null, { email: EMAIL, password: PASSWORD })).token;
  } catch (err) {
    console.error(`\nCould not sign in: ${err.message}`);
    console.error('Check that the server is running and the account details are correct.');
    process.exit(1);
  }
  console.log('Signed in.\n');

  const started = Date.now();
  const page = await api('/employees?pageSize=25', token);
  const ms = Date.now() - started;

  console.log(`Directory: ${page.total.toLocaleString()} rows, ${page.facets.length} filter sets, ${ms} ms\n`);

  for (const key of FIVE) {
    const facet = page.facets.find((f) => f.key === key);
    if (!facet) {
      fail(`${key}: no dropdown values returned (the disabled-dropdown bug is back)`);
      continue;
    }
    const shown = facet.values
      .filter((v) => v.value !== '')
      .slice(0, 6)
      .map((v) => `${v.value} ${v.count}`)
      .join(' | ');
    console.log(`${facet.label} (${facet.values.length} values, total ${facet.total.toLocaleString()})`);
    console.log(`   ${shown}`);

    // Selecting a value must give exactly the count the dropdown advertised.
    const pick = facet.values.find((v) => v.value !== '');
    if (!pick) {
      fail(`${key}: every option is blank`);
      continue;
    }
    const filtered = await api(
      `/employees?pageSize=5&f_${key}[]=${encodeURIComponent(pick.value)}`,
      token
    );
    if (filtered.total === pick.count) {
      console.log(`   OK    picking "${pick.value}" gives ${filtered.total.toLocaleString()} rows, as advertised`);
    } else {
      fail(`${key}: picking "${pick.value}" gave ${filtered.total} rows but the dropdown said ${pick.count}`);
    }
    console.log('');
  }

  if (failures) {
    console.log(`${failures} problem(s) found.`);
    process.exit(1);
  }
  console.log('All five dropdowns are populated and their counts match the rows you get.');
  console.log('If the browser still shows them disabled, hard-reload with Ctrl+Shift+R.');
})();

'use strict';
/**
 * Generate a realistic 12,000-row HR resource-management dataset.
 *
 *   node server/gen-dummy.js              # build the demo database
 *   node server/gen-dummy.js --rows 12000 --reset
 *
 * Also produces `exports/hr-master-12000.xlsx` — a 12k x 78 workbook that is
 * byte-for-byte the shape of the file an HR team would hand you. Upload that in
 * the Data Hub to exercise the real import path.
 */
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { q, tx, DATA_DIR } = require('./db');
const auth = require('./auth');
const schema = require('./schema');
const fielddefs = require('./fielddefs');
const { record } = require('./audit');

/* --------------------------------------------------------------- helpers */
function mulberry32(a) {
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = mulberry32(20261120);
const pick = (arr) => arr[Math.floor(R() * arr.length)];
const int = (min, max) => Math.floor(min + R() * (max - min + 1));
const chance = (p) => R() < p;
const pad = (n, len = 2) => String(n).padStart(len, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, days) => { const x = new Date(d); x.setDate(x.getDate() + days); return x; };
const TODAY = new Date('2026-11-20T00:00:00Z');

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Arjun', 'Rohan', 'Karthik', 'Siddharth', 'Rahul', 'Vikram', 'Nikhil',
  'Ananya', 'Priya', 'Meera', 'Sneha', 'Divya', 'Kavya', 'Aishwarya', 'Nandini', 'Pooja', 'Ishita',
  'Ravi', 'Suresh', 'Manoj', 'Deepak', 'Prakash', 'Anil', 'Rakesh', 'Sanjay', 'Vinod', 'Ajay',
  'Fatima', 'Zara', 'Ayesha', 'Imran', 'Salman', 'Naveen', 'Tarun', 'Gautam', 'Harsha', 'Lakshmi',
  'Ritu', 'Shalini', 'Preeti', 'Anjali', 'Swati', 'Varun', 'Yash', 'Mihir', 'Kabir', 'Neha'];
const LAST = ['Sharma', 'Reddy', 'Patel', 'Nair', 'Iyer', 'Rao', 'Kumar', 'Gupta', 'Menon', 'Verma',
  'Desai', 'Chowdhury', 'Bhat', 'Pillai', 'Joshi', 'Mehta', 'Shah', 'Kulkarni', 'Naidu', 'Prasad',
  'Shetty', 'Bansal', 'Khan', 'Fernandes', 'Malhotra', 'Agarwal', 'Sinha', 'Das', 'Kapoor', 'Mishra'];

const SUPPLIERS = [
  ['TECHCORE', 'TechCore Staffing'], ['BLUESKY', 'BlueSky Resourcing'], ['ATLASPRT', 'Atlas Partner Network'],
  ['NOVAT', 'Nova Talent Solutions'], ['QUANTM', 'Quantum Minds'], ['STRATX', 'Strategix Consulting'],
  ['EASTBR', 'EastBridge Partners'], ['INNOVA', 'Innova Workforce'], ['PINNCL', 'Pinnacle IT Services'],
  ['VECTRA', 'Vectra Global'], ['HELIOS', 'Helios Managed Services'], ['SUMMIT', 'Summit Consulting'],
  ['ORION', 'Orion Tech Partners'], ['DELTA', 'Delta Resource Group'],
];

const CLIENTS = ['Northwind Bank', 'Helios Retail', 'Meridian Insurance', 'Aurora Health',
  'Vertex Manufacturing', 'Cobalt Telecom', 'Summit Energy', 'Lumen Media'];

/** 6 projects so every supervisor has a distinct slice to look at. */
const PROJECTS = [
  { code: 'NEXUS', name: 'Nexus Digital Transformation', client: 'Northwind Bank', weight: 0.20,
    subprojects: [
      { code: 'NEX-CORE', name: 'Core Banking Migration', categories: ['Delivery Status', 'Billing & Allocation', 'Training Cohort'] },
      { code: 'NEX-API', name: 'API Gateway Rebuild', categories: ['Delivery Status', 'Billing & Allocation'] },
      { code: 'NEX-DATA', name: 'Data Modernisation', categories: ['Delivery Status', 'Training Cohort'] },
    ] },
  { code: 'ATLAS', name: 'Atlas Data Platform', client: 'Helios Retail', weight: 0.18,
    subprojects: [
      { code: 'ATL-ING', name: 'Ingestion & Pipelines', categories: ['Delivery Status', 'Billing & Allocation'] },
      { code: 'ATL-BI', name: 'Analytics & Reporting', categories: ['Delivery Status', 'Training Cohort'] },
      { code: 'ATL-GOV', name: 'Data Governance', categories: ['Delivery Status'] },
    ] },
  { code: 'ORBIT', name: 'Orbit Cloud Migration', client: 'Meridian Insurance', weight: 0.17,
    subprojects: [
      { code: 'ORB-ASS', name: 'Assessment & Wave Planning', categories: ['Delivery Status'] },
      { code: 'ORB-MIG', name: 'Wave Execution', categories: ['Delivery Status', 'Billing & Allocation'] },
      { code: 'ORB-OPS', name: 'Cloud Operations', categories: ['Delivery Status', 'Billing & Allocation'] },
    ] },
  { code: 'VERTEX', name: 'Vertex Workforce Uplift', client: 'Internal', weight: 0.15,
    subprojects: [
      { code: 'VTX-TRN', name: 'Reskilling Academy', categories: ['Training Cohort'] },
      { code: 'VTX-BEN', name: 'Bench & Allocation', categories: ['Billing & Allocation', 'Delivery Status'] },
    ] },
  { code: 'HORIZON', name: 'Horizon ERP Rollout', client: 'Aurora Health', weight: 0.16,
    subprojects: [
      { code: 'HRZ-FIN', name: 'Finance Module', categories: ['Delivery Status', 'Billing & Allocation'] },
      { code: 'HRZ-SCM', name: 'Supply Chain Module', categories: ['Delivery Status'] },
      { code: 'HRZ-HCM', name: 'HR Module', categories: ['Delivery Status', 'Training Cohort'] },
    ] },
  { code: 'ZENITH', name: 'Zenith Support Services', client: 'Cobalt Telecom', weight: 0.14,
    subprojects: [
      { code: 'ZEN-L1', name: 'L1 Support', categories: ['Delivery Status', 'Billing & Allocation'] },
      { code: 'ZEN-L2', name: 'L2 Engineering', categories: ['Delivery Status'] },
    ] },
];

const ACCOUNTS = ['Northwind Bank', 'Helios Retail', 'Vertex Insurance', 'Cobalt Telecom',
  'Meridian Health', 'Aurora Energy', 'Summit Logistics', 'Lakeside Media'];
const VERTICALS = ['BFSI', 'Retail & CPG', 'Healthcare', 'Manufacturing', 'Technology', 'Communications'];
const CAPABILITY = ['Data', 'Advisory', 'Tech', 'Support'];
const MANAGEMENT_LEVEL = ['1', '2', '3', '4A', '4B', '4C', '4D', '5A', '5B'];
const SERVICE_STATUS = ['Located', 'Growth Training Development', 'Internal Project', 'Maternity',
  'Operation Challenge', 'Project Role', 'IT Deployment', 'RGFTE', 'Supervise', 'Support'];

const CATEGORY_DEFS = {
  'Delivery Status': {
    show: ['emp_code', 'first_name', 'last_name', 'account', 'account_name', 'status', 'bench_category',
      'allocation_percentage', 'allocation_start_date', 'allocation_end_date', 'block_status'],
    filterable: ['bench_category', 'status', 'allocation_percentage', 'account', 'block_status'],
  },
  'Billing & Allocation': {
    show: ['emp_code', 'first_name', 'last_name', 'account', 'build_status', 'billing_status',
      'allocation_percentage', 'billing_start_date', 'billing_end_date', 'revised_allocation'],
    filterable: ['billing_status', 'build_status', 'bench_category', 'account'],
  },
  'Training Cohort': {
    show: ['emp_code', 'first_name', 'last_name', 'capability', 'job_profile_family', 'management_level',
      'doj', 'country', 'bench_aging_category', 'bench_aging'],
    filterable: ['capability', 'management_level', 'bench_aging_category', 'country'],
  },
};

/** Bench category drives everything downstream, so make it coherent. */
/**
 * Bench category drives the row Status column from the workbook:
 *   Allocated / Leadership / Not Available / Unbilled
 * and `onBench` decides whether bench-aging fields are populated.
 */
function allocationProfile() {
  const roll = R();
  if (roll < 0.52) return { bench: 'Allocated', rowStatus: 'Allocated', pct: pick([100, 100, 100, 80, 90]) };
  if (roll < 0.60) return { bench: 'PID Allocated', rowStatus: 'Allocated', pct: pick([100, 50, 0]) };
  if (roll < 0.72) return { bench: 'Bench', rowStatus: 'Unbilled', pct: 0, onBench: true };
  if (roll < 0.80) return { bench: 'Available', rowStatus: 'Unbilled', pct: 0, onBench: true };
  if (roll < 0.86) return { bench: 'Not Available', rowStatus: 'Not Available', pct: 0 };
  if (roll < 0.92) return { bench: 'Shadow', rowStatus: 'Unbilled', pct: pick([0, 25, 50]), onBench: true };
  if (roll < 0.96) return { bench: 'Partially Allocated', rowStatus: 'Allocated', pct: pick([25, 40, 50, 60, 75]) };
  if (roll < 0.99) return { bench: 'Rolling Off', rowStatus: 'Allocated', pct: pick([50, 75, 100]) };
  return { bench: 'Onboarding', rowStatus: 'Leadership', pct: 0 };
}

/* --------------------------------------------------------------- generator */
async function run({ rows = 12000, reset = true, writeExcel = true, quiet = false } = {}) {
  if (reset) {
    for (const t of ['field_overrides', 'assignment_values', 'assignments', 'group_members', 'employee_groups',
      'category_fields', 'employees', 'categories', 'subprojects', 'projects', 'suppliers', 'fields',
      'duplicate_reviews', 'imports', 'import_jobs', 'audit_log', 'user_capabilities', 'user_subprojects',
      'user_projects', 'sessions', 'users']) {
      q.run(`DELETE FROM ${t}`);
    }
    q.run('DELETE FROM sqlite_sequence');
  }

  schema.seedFields();
  const fields = schema.listFields();
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));

  const counts = tx(() => {
    /* ---------------- users ---------------- */
    const USERS = [
      { email: 'admin@resourceplanning.io', name: 'Ananya Deshmukh', role: 'admin', title: 'HR Systems Administrator', password: 'Admin@12345', projects: '*' },
      { email: 'priya.nair@resourceplanning.io', name: 'Priya Nair', role: 'supervisor', title: 'Delivery Supervisor — Nexus', password: 'Super@12345', projects: ['NEXUS'] },
      { email: 'rohit.verma@resourceplanning.io', name: 'Rohit Verma', role: 'supervisor', title: 'Delivery Supervisor — Atlas & Horizon', password: 'Super@12345', projects: ['ATLAS', 'HORIZON'] },
      { email: 'meera.iyer@resourceplanning.io', name: 'Meera Iyer', role: 'supervisor', title: 'Delivery Supervisor — Orbit', password: 'Super@12345', projects: ['ORBIT'] },
      { email: 'sameer.khan@resourceplanning.io', name: 'Sameer Khan', role: 'supervisor', title: 'Programme Supervisor — Multi', password: 'Super@12345', projects: ['NEXUS', 'ATLAS', 'ORBIT', 'VERTEX'] },
      { email: 'arun.pillai@resourceplanning.io', name: 'Arun Pillai', role: 'supervisor', title: 'Delivery Supervisor — Vertex & Zenith', password: 'Super@12345', projects: ['VERTEX', 'ZENITH'] },
      { email: 'kavita.rao@resourceplanning.io', name: 'Kavita Rao', role: 'supervisor', title: 'Read-only Reviewer', password: 'Super@12345', projects: ['NEXUS', 'ORBIT'], readonly: true },
      { email: 'hr.upload@resourceplanning.io', name: 'HR Data Team', role: 'supervisor', title: 'HR Master Data Uploader', password: 'Hr@1234567', projects: [], uploader: true },
    ];
    const userIds = new Map();
    for (const u of USERS) {
      const r = q.run('INSERT INTO users (email, name, role, title, password_hash) VALUES (?, ?, ?, ?, ?)',
        u.email, u.name, u.role || 'supervisor', u.title, auth.hashPassword(u.password));
      userIds.set(u.email, Number(r.lastInsertRowid));
    }
    const admin = { id: userIds.get('admin@resourceplanning.io'), name: 'Ananya Deshmukh', isAdmin: true, role: 'admin' };

    /* ---------------- suppliers ---------------- */
    const supplierIds = [];
    for (const [code, name] of SUPPLIERS) {
      const r = q.run('INSERT INTO suppliers (code, name, contact_name, email, phone) VALUES (?, ?, ?, ?, ?)',
        code, name, 'Vendor Manager', `${code.toLowerCase()}@vendors.example`, `+91 ${int(70, 99)}${int(10000000, 99999999)}`);
      supplierIds.push(Number(r.lastInsertRowid));
    }

    /* ---------------- hierarchy ---------------- */
    const projectIds = new Map();
    const categoryIds = new Map();
    const plates = [];   // flat list of {projectId, subprojectId, categoryId, categoryName, weight}
    for (const p of PROJECTS) {
      const pr = q.run(
        'INSERT INTO projects (code, name, client, description, status, start_date) VALUES (?, ?, ?, ?, ?, ?)',
        p.code, p.name, p.client, `${p.name} — delivery programme for ${p.client}.`, 'active',
        iso(addDays(TODAY, -int(200, 700)))
      );
      const pid = Number(pr.lastInsertRowid);
      projectIds.set(p.code, pid);
      record({ entity: 'project', entityId: pid, ref: p.code, action: 'create', newValue: p.name, actor: admin });
      p.subprojects.forEach((s, si) => {
        const sr = q.run('INSERT INTO subprojects (project_id, code, name, description, sort_order) VALUES (?, ?, ?, ?, ?)',
          pid, s.code, s.name, `${s.name} workstream.`, si * 10);
        const sid = Number(sr.lastInsertRowid);
        s.categories.forEach((catName, ci) => {
          const def = CATEGORY_DEFS[catName];
          const cr = q.run('INSERT INTO categories (subproject_id, code, name, description, sort_order) VALUES (?, ?, ?, ?, ?)',
            sid, `${s.code}-${catName.split(' ')[0].toUpperCase().slice(0, 4)}`, catName, null, ci * 10);
          const cid = Number(cr.lastInsertRowid);
          categoryIds.set(`${p.code}|${s.code}|${catName}`, cid);
          plates.push({
            projectId: pid, projectCode: p.code, subprojectId: sid, categoryId: cid,
            categoryName: catName, weight: p.weight,
          });
          // column layout for this category
          let order = 10;
          for (const f of fields) {
            // Filterable and supervisor-editable columns must always be
            // resolvable, so facets and the Submit form work even when the
            // column is not displayed as a table column by default.
            const isSubmit = !!fielddefs.ALL.find((x) => x.key === f.key)?.submit;
            // the leader's update columns (BC-BS) must exist in every category,
            // whether or not that category shows them as a table column
            const isCrm = fielddefs.CRM_KEYS.includes(f.key);
            const visible = def.show.includes(f.key) || def.filterable.includes(f.key)
              || isSubmit || isCrm;
            q.run(
              `INSERT INTO category_fields
                 (category_id, field_id, visible, editable, required, filterable, submit_field, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              cid, f.id, visible ? 1 : 0,
              f.key === 'emp_code' ? 0 : 1,
              f.key === 'bench_category' && catName === 'Delivery Status' ? 1 : 0,
              def.filterable.includes(f.key) ? 1 : 0,
              (isSubmit || isCrm) ? 1 : 0,
              visible ? order++ : 900 + f.id
            );
          }
        });
      });
    }

    /* ---------------- access grants ---------------- */
    for (const u of USERS) {
      const uid = userIds.get(u.email);
      if (u.role === 'admin') continue;
      for (const code of u.projects) {
        q.run('INSERT INTO user_projects (user_id, project_id, can_edit, can_export, can_crm) VALUES (?, ?, ?, ?, ?)',
          uid, projectIds.get(code), u.readonly ? 0 : 1, 1, u.readonly ? 0 : 1);
      }
      const caps = {
        'project.view': 1,
        'employee.edit': u.readonly ? 0 : 1,
        'employee.create': u.readonly ? 0 : 1,
        'crm.use': u.readonly ? 0 : 1,
        'export.data': 1,
        'import.data': u.uploader ? 1 : 0,
        'schema.manage': 0, 'users.manage': 0, 'audit.view': 1, 'project.manage': 0,
      };
      for (const [cap, allowed] of Object.entries(caps)) {
        q.run('INSERT INTO user_capabilities (user_id, capability, allowed) VALUES (?, ?, ?)', uid, cap, allowed);
      }
    }

    /* ---------------- employees & assignments ---------------- */
    // Names are deliberately NOT unique: real HR data has duplicate names and
    // the employee ID is the identity. Requiring uniqueness here would both be
    // unrealistic and make generation combinatorially impossible.
    let empSeq = 10001;
    let nameSuffix = 0;

    // distribute rows across categories proportionally to project weight
    const totalWeight = plates.reduce((a, p) => a + p.weight, 0);
    const plan = plates.map((p) => ({ ...p, target: Math.max(1, Math.round((p.weight / totalWeight) * rows)) }));
    let assigned = plan.reduce((a, p) => a + p.target, 0);
    // trim / pad to hit the exact row count
    let i = 0;
    while (assigned > rows) { const p = plan[i % plan.length]; if (p.target > 1) { p.target -= 1; assigned -= 1; } i += 1; }
    while (assigned < rows) { const p = plan[i % plan.length]; p.target += 1; assigned += 1; i += 1; }

    const valueInsert = q.prepare(
      `INSERT OR REPLACE INTO assignment_values (assignment_id, field_id, value, source, updated_at, updated_by)
       VALUES (?, ?, ?, 'import', datetime('now'), ?)`
    );

    for (const plate of plan) {
      for (let n = 0; n < plate.target; n++) {
        // ---- identity ----
        const first = pick(FIRST);
        const last = pick(LAST);
        // ~8% share a plain name with someone else, as often happens in practice
        const full = chance(0.08) ? `${first} ${last} ${++nameSuffix}` : `${first} ${last}`;
        const code = `EMP-${String(empSeq++).padStart(5, '0')}`;
        const join = addDays(TODAY, -int(60, 2200));
        const r = q.run(
          `INSERT INTO employees (emp_code, name, first_name, last_name, email, phone, created_at, updated_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          code, full, first, last,
          `${first.toLowerCase()}.${last.toLowerCase()}${empSeq}@example.com`,
          `+91 ${int(70, 99)}${int(10000000, 99999999)}`,
          iso(join), iso(addDays(TODAY, -int(0, 30))), admin.id
        );
        const empId = Number(r.lastInsertRowid);

        // ---- assignment ----
        const profile = allocationProfile();
        const supplierId = chance(0.35) ? null : pick(supplierIds);
        const ar = q.run(
          `INSERT INTO assignments (employee_id, project_id, subproject_id, category_id, supplier_id, status, remarks, created_at, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          empId, plate.projectId, plate.subprojectId, plate.categoryId, supplierId,
          profile.rowStatus,
          null, iso(join), iso(addDays(TODAY, -int(0, 45))), admin.id
        );
        const aid = Number(ar.lastInsertRowid);

        // ---- the ~78 configurable columns ----
        const startDate = profile.pct > 0 ? addDays(TODAY, -int(10, 240)) : (chance(0.5) ? addDays(TODAY, -int(60, 300)) : null);
        const endDate = startDate ? addDays(startDate, int(30, 420)) : null;
        const eta = ['Bench', 'Available', 'Rolling Off', 'Onboarding'].includes(profile.bench)
          ? addDays(TODAY, int(-20, 120)) : null;

        const blocked = ['Allocated', 'PID Allocated', 'Shadow', 'Partially Allocated'].includes(profile.bench)
          ? pick(['No Block', 'No Block', 'Soft Block', 'Hard Block', 'Hard Block'])
          : 'No Block';

        const vals = {
          // ---- allocation ----
          bench_category: profile.bench,
          allocation_percentage: String(profile.pct),
          revised_allocation: String(chance(0.4) ? profile.pct : int(0, 100)),
          allocation_start_date: startDate ? iso(startDate) : null,
          allocation_end_date: endDate ? iso(endDate) : null,
          last_week_end_date: iso(addDays(TODAY, -((TODAY.getDay() + 6) % 7) - 7)),
          status: profile.rowStatus,
          service_status: pick(SERVICE_STATUS),
          billing_status: pick(['Billable', 'Billable', 'Non-Billable', 'Shadow', 'T&M', 'Fixed Price']),
          build_status: pick(['Billed', 'Billed', 'Partially Billed', 'Unbilled', 'Not Available']),

          // ---- account & delivery ----
          account: pick(ACCOUNTS),
          account_name: pick(ACCOUNTS),
          account_manual: chance(0.3) ? pick(ACCOUNTS) : null,
          account_owner: `${pick(FIRST)} ${pick(LAST)}`,
          vertical: pick(VERTICALS),
          vertical_manual: chance(0.25) ? pick(VERTICALS) : null,
          unit_manual: chance(0.25) ? pick(['Unit A', 'Unit B', 'Unit C']) : null,
          ae: `${pick(FIRST)} ${pick(LAST)}`,
          vp_mapping: `${pick(FIRST)} ${pick(LAST)}`,
          source: pick(['As per RAR', 'As per System']),
          offsite_onsite: pick(['Offsite', 'Offsite', 'Offsite-Onsite', 'Onsite']),

          // ---- bench ----
          bench_aging: String(profile.onBench ? int(1, 180) : 0),
          bench_aging_category: profile.onBench
            ? pick(['0-30 days', '31-60 days', '61-90 days', '90+ days']) : null,
          bench_aging_comment: profile.onBench && chance(0.35)
            ? pick(['Awaiting release confirmation', 'Skillset under review', 'Client decision pending']) : null,
          bench_subcategory: profile.onBench ? pick(['Core Bench', 'Skill Bench', 'Training Bench']) : null,
          bl_status: pick(['BL-1', 'BL-1', 'BL-2', 'BL-3']),
          bench_later_issue_date: chance(0.2) ? iso(addDays(TODAY, -int(1, 60))) : null,
          bench_later_end_date: chance(0.15) ? iso(addDays(TODAY, int(1, 90))) : null,

          // ---- PID and demand ----
          pid_aging_weeks: String(int(0, 26)),
          pid_segment: pick(['Segment A', 'Segment B', 'Segment C']),
          pid_awaited_account: blocked === 'No Block' ? null : pick(ACCOUNTS),
          pid_awaited_blocked_date: blocked === 'No Block' ? null : iso(addDays(TODAY, -int(1, 45))),
          opp_id: `OPP-${int(100000, 999999)}`,
          demand_number: chance(0.6) ? `DEM-${int(10000, 99999)}` : null,
          giga_project_name: chance(0.25) ? pick(['Giga One', 'Giga Two', 'Giga Three']) : null,
          ard_date: chance(0.3) ? iso(addDays(TODAY, int(-30, 120))) : null,
          interviewed_by: chance(0.3) ? `${pick(FIRST)} ${pick(LAST)}` : null,
          role_of_month: chance(0.35) ? pick(['Developer', 'Lead', 'Analyst', 'Tester', 'Architect']) : null,
          role_of_responses: chance(0.2) ? pick(['Shortlisted', 'On hold', 'Interview scheduled', 'Rejected']) : null,

          // ---- leadership input ----
          leader_input_last_week: chance(0.2) ? pick(['Deploy to Atlas phase 2', 'Keep on current account', 'Move to bench pool']) : null,
          leader_input_this_week: chance(0.2) ? pick(['Confirm by Friday', 'No update', 'Escalated to VP']) : null,
          leader_input_pid_account: chance(0.25) ? pick(ACCOUNTS) : null,
          detail_comments: chance(0.25) ? pick(['Handover in progress', 'Client asked for extension', 'Rate revision pending']) : null,

          // ---- billing window ----
          billing_start_date: chance(0.6) ? iso(addDays(TODAY, -int(30, 400))) : null,
          billing_end_date: chance(0.2) ? iso(addDays(TODAY, int(1, 200))) : null,

          // ---- block ----
          block_status: blocked,

          // ---- profile & organisation ----
          capability: pick(CAPABILITY),
          job_profile_family: pick(['Engineering', 'Data & Analytics', 'Quality', 'Cloud', 'Functional']),
          management_level: pick(MANAGEMENT_LEVEL),
          doj: iso(join),
          country: pick(['India', 'India', 'India', 'India', 'United States', 'United Kingdom', 'Singapore']),
          manager_id: `EMP-${String(int(1001, 12000)).padStart(5, '0')}`,
          manager_name: `${pick(FIRST)} ${pick(LAST)}`,
          cost_center_id: `CC-${int(1000, 9999)}`,
          cost_center_name: pick(['Delivery', 'Platform Engineering', 'Data Practice', 'Quality Engineering', 'Support']),
        };

        for (const [key, value] of Object.entries(vals)) {
          if (value === null || value === undefined || value === '') continue;
          const f = fieldByKey.get(key);
          if (!f) continue;
          valueInsert.run(aid, f.id, String(value), admin.id);
        }
      }
    }

    /* ---------------- a few supervisor-edited records, for realism ---------- */
    const samples = q.all('SELECT id FROM assignments ORDER BY id LIMIT 40');
    const supervisor = { id: userIds.get('priya.nair@resourceplanning.io'), name: 'Priya Nair' };
    const notesField = fieldByKey.get('follow_up_notes');
    const benchField = fieldByKey.get('bench_category');
    for (const s of samples.slice(0, 25)) {
      if (!notesField) break;
      valueInsert.run(s.id, notesField.id, 'Reviewed with supervisor — plan confirmed for next quarter.', supervisor.id);
      q.run('INSERT OR REPLACE INTO field_overrides (assignment_id, field_id, locked, reason, updated_at) VALUES (?, ?, 1, ?, datetime(\'now\'))',
        s.id, notesField.id, 'CRM edit');
    }
    // move six people from Bench -> PID Allocated so the board shows a real shift
    for (const s of samples.slice(25, 31)) {
      if (!benchField) break;
      valueInsert.run(s.id, benchField.id, 'PID Allocated', supervisor.id);
      q.run("INSERT OR REPLACE INTO field_overrides (assignment_id, field_id, locked, reason, updated_at) VALUES (?, ?, 1, 'CRM edit', datetime('now'))",
        s.id, benchField.id);
      const a = q.get('SELECT * FROM assignments WHERE id = ?', s.id);
      record({ entity: 'assignment', entityId: s.id, ref: `assignment ${s.id}`, action: 'update',
        fieldKey: 'bench_category', oldValue: 'Bench', newValue: 'PID Allocated', actor: supervisor });
      void a;
    }

    /* ---------------- employee groups ---------------- */
    const g1 = q.run('INSERT INTO employee_groups (name, description) VALUES (?, ?)', 'Bench Review Cohort', 'People currently sitting on the bench');
    const g2 = q.run('INSERT INTO employee_groups (name, description) VALUES (?, ?)', 'Critical Skills', 'Flagged as critical-skill retention');
    for (const e of q.all('SELECT id FROM employees ORDER BY id LIMIT 60')) {
      q.run('INSERT OR IGNORE INTO group_members (group_id, employee_id) VALUES (?, ?)', Number(g1.lastInsertRowid), e.id);
    }
    for (const e of q.all('SELECT id FROM employees ORDER BY id DESC LIMIT 40')) {
      q.run('INSERT OR IGNORE INTO group_members (group_id, employee_id) VALUES (?, ?)', Number(g2.lastInsertRowid), e.id);
    }

    /* ---------------- activity history for the feed ---------------------- */
    const actors = [
      { id: userIds.get('priya.nair@resourceplanning.io'), name: 'Priya Nair' },
      { id: userIds.get('rohit.verma@resourceplanning.io'), name: 'Rohit Verma' },
      { id: userIds.get('meera.iyer@resourceplanning.io'), name: 'Meera Iyer' },
      { id: userIds.get('sameer.khan@resourceplanning.io'), name: 'Sameer Khan' },
    ];
    for (const [i, s] of q.all('SELECT id FROM assignments ORDER BY id LIMIT 120').entries()) {
      const actor = actors[i % actors.length];
      record({ entity: 'assignment', entityId: s.id, ref: `assignment ${s.id}`, action: 'update',
        fieldKey: pick(['bench_category', 'allocation_plan', 'pid', 'eta_available', 'allocation_end_date']),
        oldValue: pick(['Bench', 'Allocated', 'Awaiting confirmation', 'PID-12345']),
        newValue: pick(['PID Allocated', 'Available', 'Nexus phase 2', 'PID-55012']), actor });
      const day = 19 - (i % 14);
      q.run("UPDATE audit_log SET at = ? WHERE id = last_insert_rowid()",
        `2026-11-${pad(day)} ${pad(int(8, 18))}:${pad(int(0, 59))}:00`);
    }

    return {
      users: q.get('SELECT COUNT(*) c FROM users').c,
      projects: q.get('SELECT COUNT(*) c FROM projects').c,
      categories: q.get('SELECT COUNT(*) c FROM categories').c,
      employees: q.get('SELECT COUNT(*) c FROM employees').c,
      assignments: q.get('SELECT COUNT(*) c FROM assignments').c,
      values: q.get('SELECT COUNT(*) c FROM assignment_values').c,
      fields: q.get('SELECT COUNT(*) c FROM fields').c,
    };
  });

  if (!quiet) console.log('Generated dataset:', counts);

  if (writeExcel) {
    const file = path.join(DATA_DIR, '..', 'exports', 'hr-master-12000.xlsx');
    const info = await writeWorkbook(file);
    if (!quiet) console.log(`Sample workbook: ${file} (${info.rows} rows x ${info.cols} columns)`);
    return { counts, file };
  }
  return { counts };
}

/**
 * Write the 12k x 78 workbook used to exercise the import path.
 * Streamed row-by-row so memory stays flat.
 */
async function writeWorkbook(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: true });
  const fields = schema.listFields();
  const headers = ['Project', 'Subproject', 'Category', ...fields.map((f) => f.label)];
  const ws = wb.addWorksheet('Employees');
  ws.columns = headers.map((h) => ({ header: h, width: Math.min(34, Math.max(14, h.length + 4)) }));
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.commit();

  const rows = q.all(
    `SELECT a.id, p.name pname, s.name sname, c.name cname,
            e.emp_code, e.name, e.first_name, e.last_name, e.email, e.phone, a.status, a.remarks, sup.name supplier
       FROM assignments a
       JOIN employees e ON e.id = a.employee_id
       JOIN projects p ON p.id = a.project_id
       JOIN subprojects s ON s.id = a.subproject_id
       JOIN categories c ON c.id = a.category_id
       LEFT JOIN suppliers sup ON sup.id = a.supplier_id
      ORDER BY a.id`
  );
  const values = new Map();
  for (const v of q.all(
    `SELECT av.assignment_id, f.key, av.value FROM assignment_values av JOIN fields f ON f.id = av.field_id`
  )) {
    if (!values.has(v.assignment_id)) values.set(v.assignment_id, {});
    values.get(v.assignment_id)[v.key] = v.value;
  }

  for (const r of rows) {
    const extra = values.get(r.id) || {};
    const line = [r.pname, r.sname, r.cname];
    for (const f of fields) {
      switch (f.key) {
        case 'emp_code': line.push(r.emp_code); break;
        case 'name': line.push(r.name); break;
        case 'first_name': line.push(r.first_name); break;
        case 'last_name': line.push(r.last_name); break;
        case 'email': line.push(r.email); break;
        case 'phone': line.push(r.phone); break;
        case 'status': line.push(r.status); break;
        case 'remarks': line.push(r.remarks); break;
        case 'supplier': line.push(r.supplier); break;
        default: line.push(extra[f.key] ?? null);
      }
    }
    ws.addRow(line).commit();
  }
  header.commit();
  await wb.commit();
  return { rows: rows.length, cols: headers.length };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const rowsArg = args.indexOf('--rows');
  const rows = rowsArg >= 0 ? Number(args[rowsArg + 1]) : 12000;
  const noExcel = args.includes('--no-excel');
  const reset = !args.includes('--keep');
  run({ rows, reset, writeExcel: !noExcel }).then((r) => {
    if (r && r.file) console.log('Done.');
  }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { run, writeWorkbook, PROJECTS, SUPPLIERS };

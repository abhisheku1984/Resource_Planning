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

const CATEGORY_DEFS = {
  'Delivery Status': {
    show: ['emp_code', 'name', 'bench_category', 'allocation_status', 'allocation_percentage',
      'allocation_start_date', 'allocation_end_date', 'supplier', 'designation', 'remarks'],
    filterable: ['bench_category', 'allocation_status', 'allocation_percentage', 'work_location', 'grade'],
  },
  'Billing & Allocation': {
    show: ['emp_code', 'name', 'bench_category', 'allocation_percentage', 'billing_status', 'rate_card',
      'allocation_start_date', 'allocation_end_date', 'supplier', 'effective_date'],
    filterable: ['billing_status', 'bench_category', 'allocation_status'],
  },
  'Training Cohort': {
    show: ['emp_code', 'name', 'training_status', 'certification_status', 'primary_skill',
      'joining_date', 'completion_status', 'supplier', 'remarks'],
    filterable: ['training_status', 'primary_skill', 'skill_category'],
  },
};

/** Bench category drives everything downstream, so make it coherent. */
function allocationProfile() {
  const roll = R();
  if (roll < 0.52) return { bench: 'Allocated', allocStatus: 'Allocated', pct: pick([100, 100, 100, 80, 90]) };
  if (roll < 0.60) return { bench: 'PID Allocated', allocStatus: 'Reserved', pct: pick([100, 50, 0]) };
  if (roll < 0.72) return { bench: 'Bench', allocStatus: 'Unallocated', pct: 0 };
  if (roll < 0.80) return { bench: 'Available', allocStatus: 'Unallocated', pct: 0 };
  if (roll < 0.86) return { bench: 'Not Available', allocStatus: 'Unallocated', pct: 0 };
  if (roll < 0.92) return { bench: 'Shadow', allocStatus: 'Allocated', pct: pick([0, 25, 50]) };
  if (roll < 0.96) return { bench: 'Partially Allocated', allocStatus: 'Partially Allocated', pct: pick([25, 40, 50, 60, 75]) };
  if (roll < 0.99) return { bench: 'Rolling Off', allocStatus: 'Rolling Off', pct: pick([50, 75, 100]) };
  return { bench: 'Onboarding', allocStatus: 'Reserved', pct: 0 };
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
            const visible = def.show.includes(f.key) || def.filterable.includes(f.key) || isSubmit;
            q.run(
              `INSERT INTO category_fields
                 (category_id, field_id, visible, editable, required, filterable, submit_field, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              cid, f.id, visible ? 1 : 0,
              f.key === 'emp_code' ? 0 : 1,
              f.key === 'bench_category' && catName === 'Delivery Status' ? 1 : 0,
              def.filterable.includes(f.key) ? 1 : 0,
              isSubmit ? 1 : 0,
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
          `INSERT INTO employees (emp_code, name, email, phone, designation, created_at, updated_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          code, full,
          `${first.toLowerCase()}.${last.toLowerCase()}${empSeq}@example.com`,
          `+91 ${int(70, 99)}${int(10000000, 99999999)}`,
          pick(['Software Engineer', 'Senior Software Engineer', 'Technical Lead', 'Data Engineer',
            'Senior Data Engineer', 'QA Analyst', 'Cloud Engineer', 'Business Analyst',
            'Scrum Master', 'Solution Architect', 'Associate', 'Principal Engineer']),
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
          profile.bench === 'Not Available' ? 'On Leave' : profile.bench === 'Onboarding' ? 'Training' : 'Active',
          null, iso(join), iso(addDays(TODAY, -int(0, 45))), admin.id
        );
        const aid = Number(ar.lastInsertRowid);

        // ---- the ~78 configurable columns ----
        const startDate = profile.pct > 0 ? addDays(TODAY, -int(10, 240)) : (chance(0.5) ? addDays(TODAY, -int(60, 300)) : null);
        const endDate = startDate ? addDays(startDate, int(30, 420)) : null;
        const eta = ['Bench', 'Available', 'Rolling Off', 'Onboarding'].includes(profile.bench)
          ? addDays(TODAY, int(-20, 120)) : null;

        const vals = {
          bench_category: profile.bench,
          allocation_status: profile.allocStatus,
          allocation_percentage: String(profile.pct),
          allocation_start_date: startDate ? iso(startDate) : null,
          allocation_end_date: endDate ? iso(endDate) : null,

          allocation_plan: ['Bench', 'Available', 'Rolling Off', 'Onboarding'].includes(profile.bench)
            ? pick([`Target: ${pick(['Nexus phase 2', 'Horizon Finance', 'Orbit Wave 4', 'Zenith L2', 'Internal platform'])}`,
              'Awaiting client confirmation', 'Interview in progress', 'Skillset refresh first', ''])
            : null,
          pid: chance(0.6) ? `PID-${int(10000, 99999)}` : null,
          opid: chance(0.45) ? `OPID-${int(1000, 9999)}` : null,
          project_role: chance(0.7) ? pick(['Developer', 'Lead', 'Analyst', 'Tester', 'Architect', 'Consultant']) : null,
          eta_available: eta ? iso(eta) : null,
          follow_up_notes: chance(0.22) ? pick([
            'Available for immediate deployment after release.',
            'Needs 2 weeks handover before roll-off.',
            'Client requested extension for one quarter.',
            'Pending security clearance — cannot be allocated yet.',
            'Discussed upskilling plan with the supervisor.',
            'Rate renegotiation in progress with the vendor.',
          ]) : null,
          critical_flag: chance(0.14) ? 'Yes' : 'No',
          risk_flag: pick(['Low', 'Low', 'Low', 'Medium', 'Medium', 'High', 'Not assessed']),

          grade: pick(['L1', 'L2', 'L2', 'L3', 'L3', 'L4', 'L4', 'L5', 'M1', 'M2']),
          department: pick(['Engineering', 'Data & Analytics', 'Quality Engineering', 'Cloud & Infrastructure',
            'Product', 'Business Analysis', 'DevOps', 'Design', 'Project Management']),
          business_unit: pick(['BFSI', 'Retail & CPG', 'Healthcare', 'Manufacturing', 'Technology', 'Internal']),
          reporting_manager: `${pick(FIRST)} ${pick(LAST)}`,
          du_head: `${pick(FIRST)} ${pick(LAST)}`,
          hr_business_partner: `${pick(FIRST)} ${pick(LAST)}`,
          cost_center: `CC-${int(1000, 9999)}`,
          employee_type: pick(['Full Time', 'Full Time', 'Full Time', 'Contract', 'Contract', 'Intern', 'Consultant']),
          employment_status: pick(['Active', 'Active', 'Active', 'Active', 'Notice Period', 'On Leave']),

          joining_date: iso(join),
          confirmation_date: iso(addDays(join, 180)),
          total_experience_years: String(int(1, 18)),
          relevant_experience_years: String(int(1, 14)),
          tenure_months: String(Math.max(1, Math.round((TODAY - join) / 2592000000))),

          work_location: pick(['Hyderabad', 'Bengaluru', 'Chennai', 'Pune', 'Noida', 'Mumbai', 'Kolkata', 'Coimbatore', 'Kochi', 'Remote']),
          work_mode: pick(['Offshore', 'Offshore', 'Offshore', 'Onsite', 'Hybrid', 'Remote']),
          country: pick(['India', 'India', 'India', 'India', 'United States', 'United Kingdom', 'Singapore']),
          city: pick(['Hyderabad', 'Bengaluru', 'Chennai', 'Pune', 'Noida', 'Mumbai']),
          shift: pick(['General', 'General', 'Morning', 'Evening', 'Night', 'Rotational']),
          seat_number: chance(0.6) ? `F${int(1, 12)}-${int(100, 999)}` : null,

          primary_skill: pick(['Java', 'Spring Boot', 'Microservices', 'Python', 'Data Engineering', 'Spark',
            'Airflow', 'React', 'Angular', 'Node.js', '.NET', 'Salesforce', 'SAP', 'Oracle', 'Terraform',
            'AWS', 'Azure', 'Kubernetes', 'Selenium', 'Performance Testing', 'Business Analysis']),
          secondary_skill: chance(0.5) ? pick(['SQL', 'Kafka', 'Docker', 'Jenkins', 'GraphQL', 'Tableau', 'Power BI']) : null,
          skill_category: pick(['Application Development', 'Data & Analytics', 'Cloud', 'Quality Engineering', 'ERP / CRM', 'DevOps', 'Functional']),
          certification: chance(0.4) ? pick(['AWS Solutions Architect', 'Azure Administrator', 'CKA', 'Scrum Master', 'ISTQB', 'Salesforce Admin']) : null,
          certification_status: pick(['Certified', 'In Progress', 'Not Started', 'Expired', 'Not Started']),
          training_status: pick(['Completed', 'Completed', 'In Progress', 'Not Started', 'Not Started', 'Waived']),
          qualification: pick(['B.Tech', 'B.E.', 'B.Sc', 'MCA', 'M.Tech', 'MBA', 'Diploma']),

          billing_status: profile.pct > 0
            ? pick(['Billable', 'Billable', 'Billable', 'T&M', 'Fixed Price', 'Shadow'])
            : 'Non-Billable',
          rate_card: profile.pct > 0 ? String(int(180, 950)) : null,
          currency: 'USD',
          po_number: chance(0.55) ? `PO-${int(2024, 2026)}-${int(1000, 9999)}` : null,
          invoice_status: profile.pct > 0 ? pick(['Invoiced', 'Invoiced', 'Pending', 'N/A']) : 'N/A',
          margin_percentage: String(int(12, 42)),
          effective_date: startDate ? iso(startDate) : iso(addDays(TODAY, -int(30, 200))),

          project_manager: `${pick(FIRST)} ${pick(LAST)}`,
          client_name: pick(CLIENTS),
          engagement_type: pick(['T&M', 'Fixed Price', 'Managed Services', 'Staff Augmentation']),
          sow_reference: `SOW-${int(100, 999)}`,
          work_package: pick(['WP1 Core', 'WP2 Integration', 'WP3 Migration', 'WP4 Testing', 'WP5 Support']),
          phase: pick(['Discovery', 'Design', 'Build', 'Build', 'Test', 'UAT', 'Hypercare', 'Steady State']),

          background_check: pick(['Cleared', 'Cleared', 'Cleared', 'Pending', 'Not Initiated']),
          nda_signed: chance(0.9) ? 'Yes' : 'No',
          asset_id: `AST-${int(100000, 999999)}`,
          access_approval: pick(['Approved', 'Approved', 'Pending', 'Revoked']),
          timesheet_compliance: pick(['Compliant', 'Compliant', 'Compliant', 'Missing', 'Waived']),
          leave_balance: String(int(0, 28)),
          performance_rating: pick(['5', '4', '4', '3', '3', '3', '2', '1']),
          skill_track: pick(['Java', 'Data Engineering', 'Cloud', 'QA', 'Business Analysis', 'DevOps']),
          completion_status: pick(['Pending', 'Partial', 'Completed', 'Completed']),
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
            e.emp_code, e.name, e.designation, e.email, e.phone, a.status, a.remarks, sup.name supplier
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
        case 'designation': line.push(r.designation); break;
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

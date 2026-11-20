'use strict';
/**
 * Demo dataset. Safe to re-run with --reset.
 *
 * Contents:
 *  - 1 administrator + 6 supervisors with different project grants
 *  - 4 projects, 9 subprojects, 22 categories
 *  - 12 suppliers, ~170 employees, ~210 assignments
 *  - per-category column layouts (Category A/B/C behave differently)
 *  - a protected (hand-edited) field and an open duplicate for review
 */
const fs = require('node:fs');
const path = require('node:path');
const { q, tx, DB_FILE } = require('./db');
const auth = require('./auth');
const schema = require('./schema');
const { record } = require('./audit');

const rnd = (seed) => {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
};
const R = rnd(42);
const pick = (arr) => arr[Math.floor(R() * arr.length)];
const int = (min, max) => Math.floor(min + R() * (max - min + 1));

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Arjun', 'Rohan', 'Karthik', 'Siddharth', 'Rahul', 'Vikram', 'Nikhil',
  'Ananya', 'Priya', 'Meera', 'Sneha', 'Divya', 'Kavya', 'Aishwarya', 'Nandini', 'Pooja', 'Ishita',
  'Ravi', 'Suresh', 'Manoj', 'Deepak', 'Prakash', 'Anil', 'Rakesh', 'Sanjay', 'Vinod', 'Ajay',
  'Fatima', 'Zara', 'Ayesha', 'Imran', 'Salman', 'Naveen', 'Tarun', 'Gautam', 'Harsha', 'Lakshmi'];
const LAST = ['Sharma', 'Reddy', 'Patel', 'Nair', 'Iyer', 'Rao', 'Kumar', 'Gupta', 'Menon', 'Verma',
  'Desai', 'Chowdhury', 'Bhat', 'Pillai', 'Joshi', 'Mehta', 'Shah', 'Kulkarni', 'Naidu', 'Prasad'];

const PROJECTS = [
  {
    code: 'NEXUS', name: 'Nexus Digital Transformation', client: 'Northwind Bank', status: 'active',
    start_date: '2025-02-03',
    description: 'Core banking modernisation programme with phased rollout across retail and corporate channels.',
    subprojects: [
      {
        code: 'NEX-CORE', name: 'Core Banking Migration',
        categories: [
          { code: 'NEX-CORE-TRN', name: 'Training Cohort' },
          { code: 'NEX-CORE-BIL', name: 'Billing & Allocation' },
          { code: 'NEX-CORE-DEL', name: 'Delivery Status' },
        ],
      },
      {
        code: 'NEX-API', name: 'API Gateway Rebuild',
        categories: [
          { code: 'NEX-API-TRN', name: 'Training Cohort' },
          { code: 'NEX-API-DEL', name: 'Delivery Status' },
        ],
      },
    ],
  },
  {
    code: 'ATLAS', name: 'Atlas Data Platform', client: 'Helios Retail', status: 'active',
    start_date: '2025-05-19',
    description: 'Enterprise lakehouse build covering supply chain, merchandising and store analytics.',
    subprojects: [
      {
        code: 'ATL-ING', name: 'Ingestion & Pipelines',
        categories: [
          { code: 'ATL-ING-DEL', name: 'Delivery Status' },
          { code: 'ATL-ING-TRN', name: 'Training Cohort' },
        ],
      },
      {
        code: 'ATL-BI', name: 'Analytics & Reporting',
        categories: [
          { code: 'ATL-BI-BIL', name: 'Billing & Allocation' },
          { code: 'ATL-BI-DEL', name: 'Delivery Status' },
        ],
      },
      {
        code: 'ATL-GOV', name: 'Data Governance',
        categories: [{ code: 'ATL-GOV-DEL', name: 'Delivery Status' }],
      },
    ],
  },
  {
    code: 'ORBIT', name: 'Orbit Cloud Migration', client: 'Meridian Insurance', status: 'active',
    start_date: '2026-01-12',
    description: 'Lift-and-shift plus re-platforming of 240 workloads into a regulated cloud landing zone.',
    subprojects: [
      {
        code: 'ORB-ASS', name: 'Assessment & Wave Planning',
        categories: [{ code: 'ORB-ASS-DEL', name: 'Delivery Status' }],
      },
      {
        code: 'ORB-MIG', name: 'Wave Execution',
        categories: [
          { code: 'ORB-MIG-BIL', name: 'Billing & Allocation' },
          { code: 'ORB-MIG-TRN', name: 'Training Cohort' },
        ],
      },
    ],
  },
  {
    code: 'VERTEX', name: 'Vertex Workforce Uplift', client: 'Internal', status: 'active',
    start_date: '2024-09-02',
    description: 'Bench management and reskilling programme for the delivery organisation.',
    subprojects: [
      {
        code: 'VTX-TRN', name: 'Reskilling Academy',
        categories: [{ code: 'VTX-TRN-TRN', name: 'Training Cohort' }],
      },
      {
        code: 'VTX-BEN', name: 'Bench & Allocation',
        categories: [{ code: 'VTX-BEN-BIL', name: 'Billing & Allocation' }],
      },
    ],
  },
];

const SUPPLIERS = [
  ['TECHCORE', 'TechCore Staffing', 'Ritu Malhotra', 'ritu@techcore.example', '+91 40 4000 1122'],
  ['BLUESKY', 'BlueSky Resourcing', 'Alan Fernandes', 'alan@bluesky.example', '+91 80 4123 8890'],
  ['ATLASPRT', 'Atlas Partner Network', 'Sadia Khan', 'sadia@atlasprt.example', '+91 22 6789 2210'],
  ['NOVAT', 'Nova Talent Solutions', 'Girish Rao', 'girish@novat.example', '+91 40 4455 7712'],
  ['QUANTM', 'Quantum Minds', 'Leena Das', 'leena@quantm.example', '+91 44 2233 4455'],
  ['STRATX', 'Strategix Consulting', 'Mohit Bansal', 'mohit@stratx.example', '+91 11 3344 5566'],
  ['EASTBR', 'EastBridge Partners', 'Priti Sen', 'priti@eastbr.example', '+91 33 5566 7788'],
  ['INNOVA', 'Innova Workforce', 'Kiran Shetty', 'kiran@innova.example', '+91 80 6677 8899'],
  ['PINNCL', 'Pinnacle IT Services', 'Ramesh Babu', 'ramesh@pinncl.example', '+91 40 7788 9900'],
  ['VECTRA', 'Vectra Global', 'Sneha Kulkarni', 'sneha@vectra.example', '+91 20 8899 0011'],
  ['HELIOS', 'Helios Managed Services', 'Arvind Menon', 'arvind@helios.example', '+91 484 9900 1122'],
  ['SUMMIT', 'Summit Consulting', 'Neha Kapoor', 'neha@summit.example', '+91 11 2000 3344'],
];

const USERS = [
  { email: 'admin@resourceplanning.io', name: 'Ananya Deshmukh', role: 'admin', title: 'Platform Administrator', password: 'Admin@12345', projects: '*' },
  { email: 'priya.nair@resourceplanning.io', name: 'Priya Nair', role: 'supervisor', title: 'Delivery Supervisor — Nexus', password: 'Super@12345', projects: ['NEXUS'] },
  { email: 'rohit.verma@resourceplanning.io', name: 'Rohit Verma', role: 'supervisor', title: 'Delivery Supervisor — Atlas', password: 'Super@12345', projects: ['ATLAS'] },
  { email: 'meera.iyer@resourceplanning.io', name: 'Meera Iyer', role: 'supervisor', title: 'Delivery Supervisor — Orbit + Vertex', password: 'Super@12345', projects: ['ORBIT', 'VERTEX'] },
  { email: 'sameer.khan@resourceplanning.io', name: 'Sameer Khan', role: 'supervisor', title: 'Programme Supervisor — Multi', password: 'Super@12345', projects: ['NEXUS', 'ATLAS', 'ORBIT'] },
  { email: 'kavita.rao@resourceplanning.io', name: 'Kavita Rao', role: 'supervisor', title: 'Read-only Reviewer', password: 'Super@12345', projects: ['NEXUS', 'ORBIT'], readonly: true },
  { email: 'arun.pillai@resourceplanning.io', name: 'Arun Pillai', role: 'supervisor', title: 'Delivery Supervisor — Vertex', password: 'Super@12345', projects: ['VERTEX'] },
];

const DESIGNATIONS = ['Software Engineer', 'Senior Software Engineer', 'Technical Lead', 'Data Engineer',
  'Senior Data Engineer', 'QA Analyst', 'Cloud Engineer', 'Business Analyst', 'Scrum Master', 'Solution Architect'];

const TRACKS = ['Java', 'Data Engineering', 'Cloud', 'QA', 'Business Analysis', 'DevOps'];
const STATUSES = ['Active', 'Active', 'Active', 'Active', 'On Leave', 'Training', 'Billing Hold', 'Released'];

/** Column layout per category archetype (requirement 19 example layouts). */
function layoutFor(name) {
  if (name === 'Training Cohort') {
    return {
      show: ['emp_code', 'name', 'supplier', 'training_status', 'joining_date', 'completion_status', 'skill_track', 'remarks'],
      readonly: ['emp_code', 'name'],
      required: ['training_status'],
    };
  }
  if (name === 'Billing & Allocation') {
    return {
      show: ['emp_code', 'name', 'supplier', 'billing_status', 'allocation_status', 'effective_date', 'status', 'remarks'],
      readonly: ['emp_code', 'name'],
      required: ['billing_status'],
    };
  }
  return {
    show: ['emp_code', 'name', 'supplier', 'status', 'designation', 'email', 'phone', 'remarks'],
    readonly: ['emp_code'],
    required: ['status'],
  };
}

function run({ reset = false, quiet = false } = {}) {
  if (reset) {
    for (const t of ['field_overrides', 'assignment_values', 'assignments', 'group_members', 'employee_groups',
      'category_fields', 'employees', 'categories', 'subprojects', 'projects', 'suppliers', 'fields',
      'duplicate_reviews', 'imports', 'audit_log', 'user_capabilities', 'user_subprojects', 'user_projects',
      'sessions', 'users']) {
      q.run(`DELETE FROM ${t}`);
    }
    q.run("DELETE FROM sqlite_sequence");
  }

  schema.seedFields();
  const fields = schema.listFields();
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));

  return tx(() => {
    // ---------- users ----------
    const userIds = new Map();
    for (const u of USERS) {
      const r = q.run(
        'INSERT INTO users (email, name, role, title, password_hash) VALUES (?, ?, ?, ?, ?)',
        u.email, u.name, u.role, u.title, auth.hashPassword(u.password)
      );
      userIds.set(u.email, Number(r.lastInsertRowid));
    }
    const admin = { id: userIds.get('admin@resourceplanning.io'), name: 'Ananya Deshmukh', isAdmin: true, role: 'admin' };

    // ---------- suppliers ----------
    const supplierIds = [];
    for (const [code, name, contact, email, phone] of SUPPLIERS) {
      const r = q.run(
        'INSERT INTO suppliers (code, name, contact_name, email, phone) VALUES (?, ?, ?, ?, ?)',
        code, name, contact, email, phone
      );
      supplierIds.push(Number(r.lastInsertRowid));
    }

    // ---------- hierarchy ----------
    const projectIds = new Map();
    const subprojectIds = new Map();
    const categoryIds = new Map();
    for (const p of PROJECTS) {
      const pr = q.run(
        'INSERT INTO projects (code, name, client, description, status, start_date) VALUES (?, ?, ?, ?, ?, ?)',
        p.code, p.name, p.client, p.description, p.status, p.start_date
      );
      const pid = Number(pr.lastInsertRowid);
      projectIds.set(p.code, pid);
      record({ entity: 'project', entityId: pid, ref: p.code, action: 'create', newValue: p.name, actor: admin });
      p.subprojects.forEach((s, si) => {
        const sr = q.run(
          'INSERT INTO subprojects (project_id, code, name, description, sort_order) VALUES (?, ?, ?, ?, ?)',
          pid, s.code, s.name, `${s.name} workstream for ${p.name}.`, si * 10
        );
        const sid = Number(sr.lastInsertRowid);
        subprojectIds.set(s.code, sid);
        s.categories.forEach((c, ci) => {
          const cr = q.run(
            'INSERT INTO categories (subproject_id, code, name, description, sort_order) VALUES (?, ?, ?, ?, ?)',
            sid, c.code, c.name, c.description || null, ci * 10
          );
          const cid = Number(cr.lastInsertRowid);
          categoryIds.set(c.code, cid);
          // per-category column configuration
          const layout = layoutFor(c.name);
          let order = 10;
          for (const f of fields) {
            const visible = layout.show.includes(f.key);
            q.run(
              `INSERT INTO category_fields (category_id, field_id, visible, editable, required, sort_order)
               VALUES (?, ?, ?, ?, ?, ?)`,
              cid, f.id, visible ? 1 : 0,
              layout.readonly.includes(f.key) ? 0 : 1,
              layout.required.includes(f.key) ? 1 : 0,
              layout.show.includes(f.key) ? order++ : 900 + f.id
            );
          }
        });
      });
    }

    // ---------- access grants ----------
    for (const u of USERS) {
      const uid = userIds.get(u.email);
      if (u.role === 'admin') continue;
      for (const code of u.projects) {
        q.run(
          'INSERT INTO user_projects (user_id, project_id, can_edit, can_export, can_crm) VALUES (?, ?, ?, ?, ?)',
          uid, projectIds.get(code), u.readonly ? 0 : 1, 1, u.readonly ? 0 : 1
        );
      }
      const caps = {
        'project.view': 1,
        'employee.edit': u.readonly ? 0 : 1,
        'employee.create': u.readonly ? 0 : 1,
        'crm.use': u.readonly ? 0 : 1,
        'export.data': 1,
        'import.data': 0,
        'schema.manage': 0,
        'users.manage': 0,
        'audit.view': 1,
        'project.manage': 0,
      };
      for (const [cap, allowed] of Object.entries(caps)) {
        q.run('INSERT INTO user_capabilities (user_id, capability, allowed) VALUES (?, ?, ?)', uid, cap, allowed);
      }
      // allow one supervisor to import daily datasets
      if (u.email === 'sameer.khan@resourceplanning.io') {
        q.run("UPDATE user_capabilities SET allowed = 1 WHERE user_id = ? AND capability = 'import.data'", uid);
      }
    }

    // ---------- employees & assignments ----------
    const usedNames = new Set();
    const employees = [];
    let empSeq = 1001;
    const totalTarget = 170;

    const supervisors = USERS.filter((u) => u.role === 'supervisor');

    for (let i = 0; i < totalTarget; i++) {
      let first; let last; let full;
      do {
        first = pick(FIRST); last = pick(LAST); full = `${first} ${last}`;
      } while (usedNames.has(full));
      usedNames.add(full);
      const code = `EMP-${String(empSeq++).padStart(5, '0')}`;
      const email = `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`;
      const phone = `+91 ${int(70, 99)}${int(10000000, 99999999)}`;
      const designation = pick(DESIGNATIONS);
      const createdAt = `2026-0${int(1, 9)}-${String(int(10, 28)).padStart(2, '0')}`;
      const r = q.run(
        `INSERT INTO employees (emp_code, name, email, phone, designation, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        code, full, email, phone, designation, createdAt, createdAt, admin.id
      );
      employees.push({ id: Number(r.lastInsertRowid), code, name: full, email, phone, designation });
    }

    // scatter employees across every category
    const placements = [];
    for (const p of PROJECTS) {
      for (const s of p.subprojects) {
        for (const c of s.categories) {
          placements.push({ project: p.code, subproject: s.code, category: c.code, catName: c.name });
        }
      }
    }

    let ai = 0;
    for (const e of employees) {
      // most employees have one placement, some have two (multi-project people)
      const count = R() < 0.18 ? 2 : 1;
      const used = new Set();
      for (let k = 0; k < count; k++) {
        let placement = placements[ai % placements.length];
        ai++;
        if (used.has(placement.category)) { placement = placements[ai++ % placements.length]; }
        used.add(placement.category);
        addAssignment(e, placement, admin);
      }
    }

    // a handful of extra people to bulk out the biggest categories
    for (let i = 0; i < 30; i++) {
      const placement = placements[int(0, placements.length - 1)];
      const e = employees[int(0, employees.length - 1)];
      addAssignment(e, placement, admin);
    }

    function addAssignment(e, placement, actor) {
      const pid = projectIds.get(placement.project);
      const sid = subprojectIds.get(placement.subproject);
      const cid = categoryIds.get(placement.category);
      const exists = q.get('SELECT id FROM assignments WHERE employee_id = ? AND subproject_id = ? AND category_id = ?', e.id, sid, cid);
      if (exists) return;
      const supplierId = supplierIds[int(0, supplierIds.length - 1)];
      const status = pick(STATUSES);
      const remarks = R() < 0.35
        ? pick([
          'Ramp-up completed ahead of schedule.',
          'Awaiting client confirmation on rate card.',
          'Shadowing senior lead for two weeks.',
          'Replacement requested by supplier.',
          'Certification pending — exam scheduled.',
          'Extended by one quarter per change request.',
          'Travel approval in progress.',
        ])
        : null;
      const r = q.run(
        `INSERT INTO assignments (employee_id, project_id, subproject_id, category_id, supplier_id, status, remarks, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        e.id, pid, sid, cid, supplierId, status, remarks,
        `2026-0${int(1, 9)}-${String(int(10, 28)).padStart(2, '0')}`,
        `2026-${String(int(9, 11)).padStart(2, '0')}-${String(int(1, 20)).padStart(2, '0')} 09:${String(int(0, 59)).padStart(2, '0')}:00`,
        admin.id
      );
      const aid = Number(r.lastInsertRowid);

      const setValue = (key, value) => {
        const f = fieldByKey.get(key);
        if (!f || value === null || value === undefined || value === '') return;
        q.run(
          `INSERT INTO assignment_values (assignment_id, field_id, value, source, updated_at, updated_by)
           VALUES (?, ?, ?, 'seed', datetime('now'), ?)`,
          aid, f.id, String(value), admin.id
        );
      };

      if (placement.catName === 'Training Cohort') {
        setValue('training_status', pick(['Not Started', 'In Progress', 'Completed', 'Completed', 'Failed']));
        setValue('joining_date', `2026-0${int(1, 9)}-${String(int(1, 28)).padStart(2, '0')}`);
        setValue('completion_status', pick(['Pending', 'Partial', 'Completed']));
        setValue('skill_track', pick(TRACKS));
      } else if (placement.catName === 'Billing & Allocation') {
        setValue('billing_status', pick(['Billable', 'Billable', 'Non-Billable', 'Shadow', 'T&M']));
        setValue('allocation_status', pick(['Allocated', 'Partially Allocated', 'Bench']));
        setValue('effective_date', `2026-${String(int(9, 12)).padStart(2, '0')}-01`);
      } else {
        setValue('skill_track', pick(TRACKS));
      }
    }

    // ---------- a protected manual edit + audit trail ----------
    const sample = q.get(
      `SELECT a.id, e.emp_code FROM assignments a JOIN employees e ON e.id = a.employee_id
        WHERE a.status = 'Active' ORDER BY a.id LIMIT 1`
    );
    if (sample) {
      const f = fieldByKey.get('training_status');
      const existing = q.get('SELECT value FROM assignment_values WHERE assignment_id = ? AND field_id = ?', sample.id, f.id);
      q.run(
        `INSERT INTO assignment_values (assignment_id, field_id, value, source, updated_at, updated_by)
         VALUES (?, ?, 'Completed', 'manual', datetime('now'), ?)
         ON CONFLICT(assignment_id, field_id) DO UPDATE SET value = 'Completed', source = 'manual', updated_at = datetime('now')`,
        sample.id, f.id, userIds.get('priya.nair@resourceplanning.io')
      );
      q.run(
        `INSERT INTO field_overrides (assignment_id, field_id, locked, reason, updated_at)
         VALUES (?, ?, 1, 'Verified by supervisor against supplier certificate', datetime('now'))
         ON CONFLICT(assignment_id, field_id) DO UPDATE SET locked = 1`,
        sample.id, f.id
      );
      record({
        entity: 'assignment', entityId: sample.id, ref: sample.emp_code, action: 'update',
        fieldKey: 'training_status', oldValue: existing?.value ?? null, newValue: 'Completed',
        actor: { id: userIds.get('priya.nair@resourceplanning.io'), name: 'Priya Nair' },
        meta: { reason: 'CRM edit' },
      });
    }

    // ---------- a pending duplicate review ----------
    const cand = employees[3];
    const pendingProject = PROJECTS[0];
    const pendingSub = pendingProject.subprojects[0];
    const pendingCat = pendingSub.categories[0];
    q.run(
      `INSERT INTO duplicate_reviews (emp_code, name, email, phone, candidate_employee_id, payload, status, note)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      'EMP-07777', cand.name, cand.email, cand.phone, cand.id,
      JSON.stringify({
        emp_code: 'EMP-07777', name: cand.name, email: cand.email, phone: cand.phone,
        project_id: projectIds.get(pendingProject.code),
        subproject_id: subprojectIds.get(pendingSub.code),
        category_id: categoryIds.get(pendingCat.code),
      }),
      'Daily upload row 41: matched email, different Employee ID'
    );

    // ---------- employee groups ----------
    const groupRes = q.run('INSERT INTO employee_groups (name, description) VALUES (?, ?)', 'Nexus Core Pod', 'Cross-functional core banking pod');
    const gid = Number(groupRes.lastInsertRowid);
    for (const e of employees.slice(0, 12)) {
      q.run('INSERT INTO group_members (group_id, employee_id) VALUES (?, ?)', gid, e.id);
    }
    const group2 = q.run('INSERT INTO employee_groups (name, description) VALUES (?, ?)', 'Data Engineering Guild', 'Atlas platform data engineers');
    for (const e of employees.slice(30, 48)) {
      q.run('INSERT INTO group_members (group_id, employee_id) VALUES (?, ?)', Number(group2.lastInsertRowid), e.id);
    }

    // ---------- historic audit entries for the activity feed ----------
    const actors = [
      { id: userIds.get('priya.nair@resourceplanning.io'), name: 'Priya Nair' },
      { id: userIds.get('rohit.verma@resourceplanning.io'), name: 'Rohit Verma' },
      { id: userIds.get('meera.iyer@resourceplanning.io'), name: 'Meera Iyer' },
      { id: userIds.get('sameer.khan@resourceplanning.io'), name: 'Sameer Khan' },
    ];
    const rows = q.all('SELECT a.id, e.emp_code FROM assignments a JOIN employees e ON e.id = a.employee_id ORDER BY a.id LIMIT 60');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const actor = actors[i % actors.length];
      const day = 19 - (i % 12);
      record({
        entity: 'assignment', entityId: r.id, ref: r.emp_code, action: 'update',
        fieldKey: pick(['status', 'remarks', 'training_status', 'billing_status']),
        oldValue: 'Active', newValue: pick(['Training', 'On Leave', 'Completed', 'Billable', 'Allocated']),
        actor,
      });
      q.run(`UPDATE audit_log SET at = ? WHERE id = last_insert_rowid()`, `2026-11-${String(day).padStart(2, '0')} ${String(int(8, 18)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}:00`);
    }

    const counts = {
      users: q.get('SELECT COUNT(*) c FROM users').c,
      projects: q.get('SELECT COUNT(*) c FROM projects').c,
      subprojects: q.get('SELECT COUNT(*) c FROM subprojects').c,
      categories: q.get('SELECT COUNT(*) c FROM categories').c,
      employees: q.get('SELECT COUNT(*) c FROM employees').c,
      assignments: q.get('SELECT COUNT(*) c FROM assignments').c,
      suppliers: q.get('SELECT COUNT(*) c FROM suppliers').c,
    };
    if (!quiet) console.log('Seed complete:', counts);
    return counts;
  });
}

if (require.main === module) {
  const reset = process.argv.includes('--reset');
  if (reset) {
    try { fs.unlinkSync(DB_FILE + '-wal'); fs.unlinkSync(DB_FILE + '-shm'); } catch { /* ignore */ }
  }
  run({ reset });
}

module.exports = { run };

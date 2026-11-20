'use strict';
/**
 * The field catalogue for a real HR resource-management workbook.
 *
 * ~75 columns, grouped the way an HR team actually maintains them. Groups drive
 * the "Show columns" picker so a supervisor is not scrolling a 75-item list.
 *
 * The 8 columns marked `filterable: true` are the facets the leadership team
 * slices by (bench category, allocation, skill, location…). Everything else is
 * available through the column picker but kept out of the way by default.
 */

const BENCH_CATEGORIES = [
  'Allocated',
  'PID Allocated',
  'Bench',
  'Available',
  'Not Available',
  'Shadow',
  'Partially Allocated',
  'Rolling Off',
  'Onboarding',
];

const ALLOCATION_STATUS = ['Allocated', 'Partially Allocated', 'Unallocated', 'Rolling Off', 'Reserved'];

const CORE = [
  { key: 'emp_code', label: 'Employee ID', type: 'text', core: true, system: true, group: 'Identity', help: 'Unique business key — used for imports and duplicate detection.' },
  { key: 'name', label: 'Employee Name', type: 'text', core: true, system: true, group: 'Identity' },
  { key: 'designation', label: 'Designation', type: 'text', core: true, group: 'Identity' },
  { key: 'email', label: 'Email Address', type: 'email', core: true, group: 'Contact' },
  { key: 'phone', label: 'Contact Number', type: 'tel', core: true, group: 'Contact' },
  { key: 'status', label: 'Current Status', type: 'select', group: 'Assignment',
    options: ['Active', 'On Leave', 'Training', 'Billing Hold', 'Released', 'Completed', 'Resigned'] },
  { key: 'supplier', label: 'Supplier', type: 'select', group: 'Supplier', options: 'SUPPLIERS' },
  { key: 'remarks', label: 'Remarks', type: 'textarea', group: 'Notes' },
];

/**
 * `filterable` → shown as a facet chip.
 * `submit`     → captured by the supervisor's "Update record" submit form.
 */
const IMPORTED = [
  // ---------------- Core allocation (the supervisor's working set) ----------
  { key: 'bench_category', label: 'Bench Category', type: 'select', group: 'Allocation',
    options: BENCH_CATEGORIES, filterable: true, submit: true,
    help: 'Allocated / PID Allocated / Bench / Available / Not Available and similar.' },
  { key: 'allocation_status', label: 'Allocation Status', type: 'select', group: 'Allocation',
    options: ALLOCATION_STATUS, filterable: true, submit: true },
  { key: 'allocation_percentage', label: 'Allocation %', type: 'number', group: 'Allocation', filterable: true, submit: true },
  { key: 'allocation_start_date', label: 'Allocation Start Date', type: 'date', group: 'Allocation', filterable: true, submit: true },
  { key: 'allocation_end_date', label: 'Allocation End Date', type: 'date', group: 'Allocation', filterable: true },

  // ---------------- Supervisor submit fields (their actual job) -------------
  { key: 'allocation_plan', label: 'Allocation Plan / Next Project', type: 'text', group: 'Supervisor Update',
    submit: true, help: 'If the person is not allocated, where are they going next?' },
  { key: 'pid', label: 'PID', type: 'text', group: 'Supervisor Update', filterable: true, submit: true },
  { key: 'opid', label: 'OPID', type: 'text', group: 'Supervisor Update', submit: true },
  { key: 'project_role', label: 'Role on Project', type: 'text', group: 'Supervisor Update', submit: true },
  { key: 'eta_available', label: 'ETA / Availability Date', type: 'date', group: 'Supervisor Update', submit: true },
  { key: 'follow_up_notes', label: 'Supervisor Notes', type: 'textarea', group: 'Supervisor Update', submit: true },
  { key: 'critical_flag', label: 'Critical Skill Flag', type: 'select', group: 'Supervisor Update',
    options: ['Yes', 'No'], submit: true },
  { key: 'risk_flag', label: 'Attrition Risk', type: 'select', group: 'Supervisor Update',
    options: ['High', 'Medium', 'Low', 'Not assessed'], filterable: true, submit: true },

  // ---------------- Grade & organisation --------------------------------
  { key: 'grade', label: 'Grade / Band', type: 'select', group: 'Organisation',
    options: ['L1', 'L2', 'L3', 'L4', 'L5', 'M1', 'M2', 'M3'], filterable: true },
  { key: 'department', label: 'Department', type: 'select', group: 'Organisation',
    options: ['Engineering', 'Data & Analytics', 'Quality Engineering', 'Cloud & Infrastructure',
      'Product', 'Business Analysis', 'DevOps', 'Design', 'Project Management'] },
  { key: 'sub_department', label: 'Sub Department', type: 'text', group: 'Organisation' },
  { key: 'business_unit', label: 'Business Unit', type: 'select', group: 'Organisation',
    options: ['BFSI', 'Retail & CPG', 'Healthcare', 'Manufacturing', 'Technology', 'Internal'] },
  { key: 'reporting_manager', label: 'Reporting Manager', type: 'text', group: 'Organisation' },
  { key: 'du_head', label: 'DU Head', type: 'text', group: 'Organisation' },
  { key: 'hr_business_partner', label: 'HR Business Partner', type: 'text', group: 'Organisation' },
  { key: 'cost_center', label: 'Cost Center', type: 'text', group: 'Organisation' },
  { key: 'employee_type', label: 'Employee Type', type: 'select', group: 'Employment',
    options: ['Full Time', 'Contract', 'Intern', 'Consultant', 'Subcontractor'] },
  { key: 'employment_status', label: 'Employment Status', type: 'select', group: 'Employment',
    options: ['Active', 'Notice Period', 'On Leave', 'Exited'] },

  // ---------------- Dates & tenure --------------------------------------
  { key: 'joining_date', label: 'Joining Date', type: 'date', group: 'Employment' },
  { key: 'confirmation_date', label: 'Confirmation Date', type: 'date', group: 'Employment' },
  { key: 'last_working_date', label: 'Last Working Date', type: 'date', group: 'Employment' },
  { key: 'total_experience_years', label: 'Total Experience (Years)', type: 'number', group: 'Employment' },
  { key: 'relevant_experience_years', label: 'Relevant Experience (Years)', type: 'number', group: 'Employment' },
  { key: 'tenure_months', label: 'Tenure (Months)', type: 'number', group: 'Employment' },

  // ---------------- Location -------------------------------------------
  { key: 'work_location', label: 'Work Location', type: 'select', group: 'Location',
    options: ['Hyderabad', 'Bengaluru', 'Chennai', 'Pune', 'Noida', 'Mumbai', 'Kolkata', 'Coimbatore', 'Kochi', 'Remote'],
    filterable: true },
  { key: 'work_mode', label: 'Work Mode', type: 'select', group: 'Location',
    options: ['Onsite', 'Offshore', 'Hybrid', 'Remote'] },
  { key: 'country', label: 'Country', type: 'select', group: 'Location',
    options: ['India', 'United States', 'United Kingdom', 'Singapore', 'UAE', 'Germany'] },
  { key: 'city', label: 'City', type: 'text', group: 'Location' },
  { key: 'visa_status', label: 'Visa Status', type: 'text', group: 'Location' },
  { key: 'seat_number', label: 'Seat / Desk', type: 'text', group: 'Location' },
  { key: 'shift', label: 'Shift', type: 'select', group: 'Location',
    options: ['General', 'Morning', 'Evening', 'Night', 'Rotational'] },

  // ---------------- Skills ---------------------------------------------
  { key: 'primary_skill', label: 'Primary Skill', type: 'select', group: 'Skills',
    options: ['Java', 'Spring Boot', 'Microservices', 'Python', 'Data Engineering', 'Spark', 'Airflow',
      'React', 'Angular', 'Node.js', '.NET', 'Salesforce', 'SAP', 'Oracle', 'Terraform', 'AWS', 'Azure',
      'Kubernetes', 'Selenium', 'Performance Testing', 'Business Analysis'],
    filterable: true },
  { key: 'secondary_skill', label: 'Secondary Skill', type: 'text', group: 'Skills' },
  { key: 'skill_category', label: 'Skill Category', type: 'select', group: 'Skills',
    options: ['Application Development', 'Data & Analytics', 'Cloud', 'Quality Engineering',
      'ERP / CRM', 'DevOps', 'Functional'] },
  { key: 'certification', label: 'Certification', type: 'text', group: 'Skills' },
  { key: 'certification_status', label: 'Certification Status', type: 'select', group: 'Skills',
    options: ['Certified', 'In Progress', 'Not Started', 'Expired'] },
  { key: 'training_status', label: 'Training Status', type: 'select', group: 'Skills',
    options: ['Not Started', 'In Progress', 'Completed', 'Failed', 'Waived'] },
  { key: 'university', label: 'University / Institute', type: 'text', group: 'Skills' },
  { key: 'qualification', label: 'Highest Qualification', type: 'select', group: 'Skills',
    options: ['B.Tech', 'B.E.', 'B.Sc', 'MCA', 'M.Tech', 'MBA', 'Diploma'] },

  // ---------------- Commercial -----------------------------------------
  { key: 'billing_status', label: 'Billing Status', type: 'select', group: 'Commercial',
    options: ['Billable', 'Non-Billable', 'Shadow', 'T&M', 'Fixed Price'], filterable: true },
  { key: 'rate_card', label: 'Rate Card (USD/day)', type: 'number', group: 'Commercial' },
  { key: 'currency', label: 'Currency', type: 'select', group: 'Commercial', options: ['USD', 'USD', 'USD', 'EUR'] },
  { key: 'billing_entity', label: 'Billing Entity', type: 'text', group: 'Commercial' },
  { key: 'po_number', label: 'PO Number', type: 'text', group: 'Commercial' },
  { key: 'invoice_status', label: 'Invoice Status', type: 'select', group: 'Commercial',
    options: ['Invoiced', 'Pending', 'N/A', 'Disputed'] },
  { key: 'margin_percentage', label: 'Margin %', type: 'number', group: 'Commercial' },
  { key: 'effective_date', label: 'Effective Date', type: 'date', group: 'Commercial' },

  // ---------------- Project context ------------------------------------
  { key: 'project_code_ext', label: 'Project Code (Ext.)', type: 'text', group: 'Project Context' },
  { key: 'project_manager', label: 'Project Manager', type: 'text', group: 'Project Context' },
  { key: 'client_name', label: 'Client Name', type: 'text', group: 'Project Context' },
  { key: 'engagement_type', label: 'Engagement Type', type: 'select', group: 'Project Context',
    options: ['T&M', 'Fixed Price', 'Managed Services', 'Staff Augmentation', 'Internal'] },
  { key: 'sow_reference', label: 'SOW Reference', type: 'text', group: 'Project Context' },
  { key: 'work_package', label: 'Work Package', type: 'text', group: 'Project Context' },
  { key: 'phase', label: 'Project Phase', type: 'select', group: 'Project Context',
    options: ['Discovery', 'Design', 'Build', 'Test', 'UAT', 'Hypercare', 'Steady State'] },

  // ---------------- Compliance -----------------------------------------
  { key: 'background_check', label: 'Background Verification', type: 'select', group: 'Compliance',
    options: ['Cleared', 'Pending', 'Not Initiated', 'Flagged'] },
  { key: 'nda_signed', label: 'NDA Signed', type: 'select', group: 'Compliance', options: ['Yes', 'No'] },
  { key: 'asset_id', label: 'Asset ID', type: 'text', group: 'Compliance' },
  { key: 'access_approval', label: 'Access Approval', type: 'select', group: 'Compliance',
    options: ['Approved', 'Pending', 'Revoked'] },
  { key: 'timesheet_compliance', label: 'Timesheet Compliance', type: 'select', group: 'Compliance',
    options: ['Compliant', 'Missing', 'Waived'] },
  { key: 'leave_balance', label: 'Leave Balance (Days)', type: 'number', group: 'Compliance' },
  { key: 'performance_rating', label: 'Performance Rating', type: 'select', group: 'Compliance',
    options: ['5', '4', '3', '2', '1'] },
  { key: 'last_updated_source', label: 'Last Updated Source', type: 'text', group: 'Notes' },
];

/** Seeded columns the application has always had; kept for compatibility. */
const LEGACY = [
  { key: 'completion_status', label: 'Completion Status', type: 'select', group: 'Skills',
    options: ['Pending', 'Partial', 'Completed', 'Dropped'] },
  { key: 'allocation_status_legacy', label: 'Allocation Status (Legacy)', type: 'select', group: 'Allocation',
    options: ['Allocated', 'Partially Allocated', 'Bench', 'Rolling Off'] },
  { key: 'skill_track', label: 'Skill Track', type: 'select', group: 'Skills',
    options: ['Java', 'Data Engineering', 'Cloud', 'QA', 'Business Analysis', 'DevOps'] },
];

const ALL = [...CORE, ...IMPORTED, ...LEGACY];

module.exports = { BENCH_CATEGORIES, ALLOCATION_STATUS, CORE, IMPORTED, LEGACY, ALL };

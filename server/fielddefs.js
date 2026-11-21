'use strict';
/**
 * The field catalogue - YOUR column headers.
 *
 * These are the 65 headers from the HR master workbook, in the order they appear
 * there, with the abbreviations expanded so they read properly on screen. The
 * importer matches on header text, so your real file will import without any
 * column mapping as long as the header names match the `label` values here.
 *
 *   filterable -> shown as a facet chip
 *   submit     -> captured by the supervisor's Update panel (and the assistant)
 *   editable:false -> read-only in the UI; true only for what supervisors own
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

/**
 * How a person is held for an account. "No Block" means fully free to move.
 * Hard block = cannot be moved without client sign-off; soft block = can move
 * with notice. Kept separate from bench_category so the two never contradict.
 */
const BLOCK_STATUS = ['No Block', 'Soft Block', 'Hard Block'];

/** Values seen in the HR workbook. Free text is allowed where the list is open. */
const BILLING_STATUS = ['Billed', 'Partially Billed', 'Unbilled', 'Not Available'];
const MANAGEMENT_LEVEL = ['1', '2', '3', '4A', '4B', '4C', '4D', '5A', '5B'];
const CAPABILITY = ['Data', 'Advisory', 'Tech', 'Support'];
const ROW_STATUS = ['Allocated', 'Leadership', 'Not Available', 'Unbilled'];
const SERVICE_STATUS = ['Located', 'Growth Training Development', 'Internal Project', 'Maternity',
  'Operation Challenge', 'Project Role', 'IT Deployment', 'RGFTE', 'Supervise', 'Support'];
const SOURCE = ['As per RAR', 'As per System'];

/**
 * Identity. These are the only columns stored on the employees table itself;
 * everything else lives per-assignment in the value table.
 *
 * First Name + Last Name are kept apart because that is how the workbook stores
 * them. The business key is Employee ID, never a name.
 */
const CORE = [
  { key: 'emp_code', label: 'Employee ID', type: 'text', core: true, system: true, group: 'Identity',
    help: 'The business key. Imports match on this, so names never create duplicates.' },
  { key: 'first_name', label: 'First Name', type: 'text', core: true, system: true, group: 'Identity' },
  { key: 'last_name', label: 'Last Name', type: 'text', core: true, system: true, group: 'Identity' },
  { key: 'email', label: 'Email Address', type: 'email', core: true, group: 'Contact' },
  { key: 'phone', label: 'Contact Number', type: 'tel', core: true, group: 'Contact' },
  { key: 'supplier', label: 'Supplier', type: 'select', group: 'Supplier', options: 'SUPPLIERS' },
  { key: 'remarks', label: 'Remarks', type: 'textarea', group: 'Notes' },
];

/**
 * Everything else, in workbook order. `mirror` means the value is also held on
 * the assignment row (project, status) so the list and its filters stay fast.
 */
const IMPORTED = [
  // ---------------- 1-12: who the person is ------------------------------
  { key: 'capability', label: 'Capability', type: 'select', group: 'Profile',
    options: CAPABILITY, filterable: true, help: 'Data / Advisory / Tech / Support.' },
  { key: 'revised_allocation', label: 'Revised Allocation', type: 'number', group: 'Allocation' },
  { key: 'build_status', label: 'Build Status', type: 'select', group: 'Billing',
    options: BILLING_STATUS, filterable: true },
  { key: 'job_profile_family', label: 'Job Profile Family', type: 'text', group: 'Profile' },
  { key: 'management_level', label: 'Management Level', type: 'select', group: 'Profile',
    options: MANAGEMENT_LEVEL, filterable: true },
  { key: 'doj', label: 'DOJ', type: 'date', group: 'Profile', help: 'Date of joining.' },
  { key: 'country', label: 'Country', type: 'select', group: 'Location',
    options: ['India', 'United States', 'United Kingdom', 'Singapore', 'UAE', 'Germany'] },
  { key: 'manager_id', label: 'Manager ID', type: 'text', group: 'Organisation' },
  { key: 'manager_name', label: 'Manager Name', type: 'text', group: 'Organisation' },
  { key: 'cost_center_id', label: 'Cost Center ID', type: 'text', group: 'Organisation' },
  { key: 'cost_center_name', label: 'Cost Center Name', type: 'text', group: 'Organisation' },

  // ---------------- 13-20: where the person is allocated -----------------
  { key: 'pmi_project_name', label: 'PMI Project Name', type: 'text', group: 'Allocation' },
  { key: 'project_id_ext', label: 'Project ID', type: 'text', group: 'Allocation', filterable: true },
  { key: 'allocation_start_date', label: 'Allocation Start Date', type: 'date', group: 'Allocation', filterable: true },
  { key: 'allocation_end_date', label: 'Allocation Ended Date', type: 'date', group: 'Allocation', filterable: true },
  { key: 'last_week_end_date', label: 'Last Week End Date', type: 'date', group: 'Allocation' },
  { key: 'allocation_percentage', label: 'Allocation Percentage', type: 'number', group: 'Allocation',
    filterable: true, submit: true, help: '0-100.' },

  // ---------------- 21-32: account, status, bench ------------------------
  { key: 'account', label: 'Account', type: 'text', group: 'Account', filterable: true },
  { key: 'vertical', label: 'Vertical', type: 'text', group: 'Account', filterable: true },
  { key: 'status', label: 'Status', type: 'select', group: 'Allocation', mirror: 'a.status',
    options: ROW_STATUS, filterable: true, submit: true,
    help: 'Allocated / Leadership / Not Available / Unbilled.' },
  { key: 'service_status', label: 'Service Status', type: 'select', group: 'Allocation',
    options: SERVICE_STATUS, submit: true },
  { key: 'source', label: 'Source', type: 'select', group: 'Account', options: SOURCE },
  { key: 'account_manual', label: 'Account Manual', type: 'text', group: 'Account' },
  { key: 'bench_aging', label: 'Bench Aging', type: 'number', group: 'Bench', help: 'Age on the bench, in days.' },
  { key: 'bench_aging_comment', label: 'Bench Aging Comment', type: 'textarea', group: 'Bench' },
  { key: 'bench_aging_category', label: 'Bench Aging Category', type: 'select', group: 'Bench',
    options: ['0-30 days', '31-60 days', '61-90 days', '90+ days'], filterable: true },
  { key: 'bl_status', label: 'BL Status', type: 'text', group: 'Bench', filterable: true },
  { key: 'bench_later_issue_date', label: 'Bench Later Issue Date', type: 'date', group: 'Bench' },
  { key: 'bench_later_end_date', label: 'Bench Later End Date', type: 'date', group: 'Bench' },

  // ---------------- 33-41: manual overlays -------------------------------
  { key: 'offsite_onsite', label: 'Offsite / Onsite', type: 'select', group: 'Location',
    options: ['Offsite', 'Onsite', 'Offsite-Onsite'], filterable: true },
  { key: 'vertical_manual', label: 'Vertical Manual', type: 'text', group: 'Account' },
  { key: 'unit_manual', label: 'Unit Manual', type: 'text', group: 'Account' },
  { key: 'ae', label: 'AE', type: 'text', group: 'Account' },
  { key: 'vp_mapping', label: 'VP Mapping', type: 'text', group: 'Account' },
  { key: 'billing_status', label: 'Billing Status', type: 'select', group: 'Billing',
    options: ['Billable', 'Non-Billable', 'Shadow', 'T&M', 'Fixed Price'], filterable: true, submit: true },
  { key: 'bench_category', label: 'Bench Category', type: 'select', group: 'Bench',
    options: BENCH_CATEGORIES, filterable: true, submit: true },
  { key: 'bench_subcategory', label: 'Bench Subcategory', type: 'text', group: 'Bench' },

  // ---------------- 44-53: leadership input, PID, opp --------------------
  { key: 'pid_aging_weeks', label: 'PID Aging in Weeks', type: 'number', group: 'PID' },
  { key: 'pid_segment', label: 'PID Segment', type: 'text', group: 'PID' },
  { key: 'leader_input_last_week', label: 'Leader Input Last Week', type: 'textarea', group: 'Leadership' },
  { key: 'leader_input_this_week', label: 'Leader Input This Week', type: 'textarea', group: 'Leadership' },
  { key: 'leader_input_pid_account', label: 'Leader Input PID Account Awaited Name', type: 'text', group: 'Leadership' },
  { key: 'billing_start_date', label: 'Billing Start Date', type: 'date', group: 'Billing', submit: true },
  { key: 'billing_end_date', label: 'Billing Ended Date', type: 'date', group: 'Billing' },
  { key: 'pid_awaited_account', label: 'PID Awaited Account', type: 'text', group: 'PID', submit: true,
    help: 'Along with the blocked date, per the workbook.' },
  { key: 'pid_awaited_blocked_date', label: 'PID Awaited Blocked Date', type: 'date', group: 'PID', submit: true },
  { key: 'opp_id', label: 'Opp ID', type: 'text', group: 'Demand', submit: true },

  // ---------------- 54-65: ownership, demand, close out ----------------
  { key: 'account_owner', label: 'Account Owner', type: 'text', group: 'Account' },
  { key: 'allocation_closure_eta', label: 'Allocation Closure ETA', type: 'date', group: 'Allocation', submit: true },
  { key: 'role_of_month', label: 'Role of Month', type: 'text', group: 'Demand', submit: true },
  { key: 'role_of_responses', label: 'Role of Responses', type: 'textarea', group: 'Demand', submit: true },
  { key: 'detail_comments', label: 'Detail Comments', type: 'textarea', group: 'Notes', submit: true },
  { key: 'block_status', label: 'Hard Block / Soft Block', type: 'select', group: 'Block',
    options: BLOCK_STATUS, filterable: true, submit: true,
    help: 'Hard Block = cannot move without client sign-off. Soft Block = can move with notice.' },
  { key: 'account_name', label: 'Account Name', type: 'text', group: 'Account', filterable: true },
  { key: 'interviewed_by', label: 'Interviewed By', type: 'text', group: 'Demand' },
  { key: 'demand_number', label: 'Demand Number', type: 'text', group: 'Demand', submit: true },
  { key: 'giga_project_name', label: 'Giga Project Name', type: 'text', group: 'Demand', filterable: true },
  { key: 'ard_date', label: 'ARD Date', type: 'date', group: 'Demand', submit: true },
];

/**
 * Two columns appear twice in the workbook (Account, Billing Status, Allocation
 * Percentage). Excel cannot hold two columns with the same header on import, so
 * the second occurrence from each pair is stored under its own key below and the
 * importer maps it explicitly.
 */
const LEGACY = [
  { key: 'account_secondary', label: 'Account (2nd column)', type: 'text', group: 'Account' },
  { key: 'billing_status_secondary', label: 'Billing Status (2nd column)', type: 'select', group: 'Billing',
    options: ['Billable', 'Non-Billable', 'Shadow', 'T&M', 'Fixed Price'] },
  { key: 'allocation_percentage_secondary', label: 'Allocation Percentage (2nd column)', type: 'number', group: 'Allocation' },
];

const ALL = [...CORE, ...IMPORTED, ...LEGACY];

module.exports = {
  BENCH_CATEGORIES, ALLOCATION_STATUS, BLOCK_STATUS,
  BILLING_STATUS, MANAGEMENT_LEVEL, CAPABILITY, ROW_STATUS, SERVICE_STATUS, SOURCE,
  CORE, IMPORTED, LEGACY, ALL,
};

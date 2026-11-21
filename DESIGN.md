# Resource Planning — design specification

Prepared before implementation, as required by section 17 of the brief. The
shipped application follows this document; where behaviour changed during build,
the document was updated to match reality.

---

## 1. Application navigation structure

A persistent left rail (collapsible on tablet) plus a top bar carrying
breadcrumbs, refresh and identity. Maximum two clicks from anywhere to a working
surface.

```
Resource Planning
├── Overview
│   └── Dashboard                     KPIs, project mix, status donut, attention queue, activity
├── Workforce
│   ├── Project Workspace             Drill-down: project → subproject → category → table + CRM
│   └── Employee Directory            Cross-project table + CRM, project filter
├── Operations
│   ├── Data Hub                      Excel generation, daily import, duplicate review
│   └── Audit Trail                   Who changed what, filterable by entity
└── Administration            (admin only)
    ├── Projects & hierarchy          Projects, subprojects, categories
    ├── Data model                    Field catalogue + per-category column matrix
    ├── Suppliers                     Partner network
    └── Employee groups               Reusable cohorts
Users & Access                (admin only)  Project grants + capability matrix
```

Rationale: supervisors live in **Project Workspace**; administrators live in
**Administration**. Nothing in the supervisor path requires understanding the
data model.

---

## 2. Screen-wise wireframes

### 2.1 Dashboard

```
┌ page head ─────────────────────────────────────────────────────────────┐
│ Good afternoon, Priya            [Employee directory] [Open workspace] │
│ Consolidated view of your authorised workforce                         │
├───────────────────────────────────┬───────────────────────────────────┤
│ People in scope                   │ Projects                          │
│ 66                                │ 1                                 │
├ Employees by project (bars) ─────────────┬ Workforce status (donut) ──┤
│ Nexus ████████████████████████ 81         │ ◕ 81 placements            │
├ Needs attention (list) ──────────────────┬ Recent activity (timeline) ┤
│ EMP-01126 Aditya Iyer   [On Leave]       │ Priya updated Training…    │
├ Supplier mix (bars) ─────────────────────┤ Quick actions              │
└──────────────────────────────────────────┴────────────────────────────┘
```

### 2.2 Project workspace (drill-down)

```
┌ page head: Project workspace            [Hide CRM] [Add person] ┐
├ rail (280px) ──────┬ main ──────────────────────────────────────┤
│ 1 authorised proj. │ ▸ NEXUS  Nexus Digital Transformation      │
│ [filter…]          │   [Export] [Layouts]                       │
│ ▾ Nexus            │ ┌ tabs: All subprojects │ Core Banking │ … │
│   • Core Banking(60)│ ┌ tabs: All categories │ Training │ Bil │
│   ▸ Training       │ ├ table toolbar: search │ status │ supplier│
│   ▸ Billing        │ │ EMP-01001 Worker 1  Completed  Add remark │
│ ▸ Atlas            │ │ EMP-01002 Worker 2  Completed  …          │
│ ▸ Orbit            │ └ pagination 1–25 of 81     ▸ ▸ ▸        │
└────────────────────┴────────────────────────────────────────────┘
```

The rail keeps every project visible at all times, so moving between projects
never requires returning to the dashboard. Project/subproject/category
selections are also encoded in the URL (`#/workspace?project=1&category=4`) for
deep links and sharing.

### 2.3 Employee listing (dynamic table)

```
┌ Employee records (81) ──────────────────────────────────────────┐
│ Click any editable cell to update it. Changes save automatically│
├ [search name, ID, supplier…] [status ▾] [supplier ▾] [Columns][Export] │
├ Emp ID ▲ │ Name ▲ │ Supplier │ Training Status ▲ │ Remarks │ Updated │
│ EMP-1001 │ Worker │ TechCore │ ● Completed       │ Add…    │ 1d ago  │
└ Showing 1–25 of 81                                    10 rows ▾   ┘
```

* Columns are driven entirely by the selected category.
* Editable cells are hover-highlighted and keyboard focusable.
* Select fields keep their badge styling and open a dropdown on click.
* Every save shows a toast; conflicts show a warning and reload the latest row.

### 2.4 Record editing (CRM form)

```
┌ Employee CRM ───────────────── [Saving…/Saved] [←] [×] ┐
│ (PR) Worker 1                    EMP-01001             │
│      [● Active] [Training Cohort]                      │
│ IDENTITY                                               │
│ [Employee ID (read-only)] [Employee Name]              │
│ [Designation]             [Email]                      │
│ [Contact Number]                                       │
│ PLACEMENT                                              │
│ Project · Subproject · Category  (switcher)            │
│ Supplier ▾                                             │
│ STATUS & NOTES                                         │
│ Current Status ▾   Training Status ▾                   │
│ Remarks & follow-up  [ textarea ]                      │
│ UPDATE HISTORY                                         │
│ ● Training Status: Not Started → Completed             │
├ Updated 2h ago                          [History][Save]│
```

### 2.5 Embedded CRM panel placement

```
┌───────────────────────────────────┬────────────────────────┐
│  employee table (flex)            │  CRM panel (400px)     │
│  …rows…                           │  search / detail / new │
└───────────────────────────────────┴────────────────────────┘
```

Below 1240 px the panel becomes a full-height overlay on the right so the table
keeps its width. The panel is toggled from the page header and can be closed
from its own title bar.

---

## 3. Dashboard design

* **Two summary tiles** — People in scope opens the Employee Directory; Projects
  opens the Project Workspace. The tiles span the row on desktop and stack on mobile.
* **Employees by project** — horizontal bars, click-through to that project's
  workspace.
* **Workforce status** — donut with legend, six largest statuses.
* **Needs attention** — records that are on leave / billing hold / released or
  have no supplier. Deliberately action-oriented, not decorative.
* **Recent activity** — audit-derived timeline, 8 most recent changes.
* **Quick actions** — three primary tasks for a supervisor.

Colour is semantic only: brand blue for volume, teal for suppliers, amber for
warnings, red for exceptions. No gradients or animation beyond 120–180 ms
transitions and a spinner.

---

## 4. Employee listing design

* Sticky header, sticky first columns on narrow screens.
* 12.5 px body type, tabular numerals for counts, monospace for identifiers.
* Row hover uses the brand tint; the selected row gets a 3 px inset accent.
* Empty states differ for "nothing here yet" versus "no search results" and
  offer the next action.
* Loading uses skeleton rows rather than a blocking spinner.
* Pagination is server-side with a page-size selector (10/25/50/100).

## 5. Record editing design

* Inline editing is single-field: click, edit, Enter or blur to commit, Escape to
  cancel. The cell is replaced by an input that matches the field type.
* The CRM form is multi-field with 900 ms debounced autosave and an explicit
  state chip: `Unsaved` → `Saving…` → `Saved`. Failures switch to `Not saved`
  with a retry banner; `Saved` is only ever shown after the server confirms.
* Every field shows a validation message inline, in red, above the value.

## 6. Embedded CRM panel design

* Header: title, save-state chip, back, close.
* Search mode: debounced directory search scoped to the user's projects, with a
  permanent "Add new person" action.
* Detail mode: identity, placement, status/notes, history — in that order,
  mirroring how a supervisor thinks about a person.
* Create mode: live duplicate warning while typing the employee ID or email.
* Footer: relative last-updated time plus History and Save shortcuts.

---

## 7. Design system tokens

| Token | Value | Use |
| --- | --- | --- |
| `--brand` | `#1f5fbf` | Primary actions, selection, focus |
| `--sidebar` | `#101c2e` | Navigation shell |
| `--bg` | `#f5f7fa` | Application background |
| `--surface` | `#ffffff` | Cards, tables, panels |
| `--line` | `#e2e8f0` | Dividers and borders |
| `--text` | `#16202e` | Primary text |
| `--text-2` | `#56647a` | Secondary text |
| `--success` / `--warn` / `--danger` | `#17845c` / `#a86300` / `#b42318` | Semantics |
| radius | 10 px cards, 7 px controls, 14 px modals | |

Typography: Inter, 13.5 px base, 1.5 line-height. Scale: 10.5 / 11.5 / 12.5 /
13.5 / 16 / 21 px. Spacing follows a 4 px grid with 8 px steps.

Responsive breakpoints: 1420 px (narrow CRM), 1240 px (stacked dashboard, CRM
overlay), 1024 px (rail becomes a drawer), 820 px (single-column forms).

Accessibility: visible focus rings on all interactive controls, ARIA labels on
icon-only buttons, `aria-live` on toasts, keyboard-accessible inline editors, and
`prefers-reduced-motion` support.

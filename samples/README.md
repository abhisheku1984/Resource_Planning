# Replace the guided-preview roster with 1,000 employees

[**workforce-1000.xlsx**](workforce-1000.xlsx) is ready to upload. The `Employees` sheet has one header row and **1,000 synthetic employees**, one placement per ID (`TEST-0001` through `TEST-1000`). Columns A–C give the placement; the other 65 columns match the app’s HR template, including the repeated headers and blank spacer. Don't delete a sample row or select a default placement.

**Already using the preloaded 1,000-employee preview?** Skip setup and upload: sign in as administrator and go straight to the checks in section 3. To replace the live roster on subsequent days, use the [daily export → replace → verify checklist](DAILY-ROSTER.md), not a new preview folder. Neither exporting nor uploading requires Excel or Microsoft 365.

## 1. Start with an empty roster, without losing the current one

A normal Data Hub upload **merges by Employee ID**. It does **not** delete people missing from the file. For a complete replacement on the **Windows guided preview at port 4110**, keep the old database as the rollback copy and activate an empty roster instead:

1. Stop the preview with **Ctrl+C**. If you have never run this copy of the app, run `START-PREVIEW.cmd` normally once to create the guided demo, then stop it.
2. In PowerShell, in the same app folder, update the guided-preview branch. If Git reports an error, stop rather than launching an older build:

   ```powershell
   cd E:\ResourcePlanning\Resource_Planning
   git switch arena/ac8f7ca1-resource-planning
   git pull --ff-only origin arena/ac8f7ca1-resource-planning
   .\START-PREVIEW.cmd --workbook
   ```

   For the updated standalone ZIP, skip Git and run the last command from the extracted folder after its first normal start.
3. The console should say **Active preview database** ending in `data\workbook-preview\guided-preview.db`. The launcher uses SQLite to copy the original setup, then removes the workforce **only from that copy**. Accounts, permissions, projects, categories, field layouts and audit/import history stay available. The copy starts with no placements, manual overrides, old review/proposal queues or signed-in sessions.
4. Open **<http://localhost:4110>**, refresh the page, and sign in as your **administrator** (fresh demo: `admin@resourceplanning.io` / `Admin@12345`). Check **Dashboard → People in scope = 0**. If it is not zero, **stop before uploading**. An existing workbook preview is reused, never automatically emptied.

**Keep `data\guided-preview.db` as your rollback copy.** The regular port-4000 database (`data\resource_planning.db`) is not involved. Do not delete a `.db`, `-wal` or `-shm` file, or run `npm run seed` / `npm run demo`. For a shared or differently configured installation, use a separate test copy rather than running this against live data.

## 2. Preview, then apply

In **Data Hub → Upload a daily dataset**, select `samples\workforce-1000.xlsx`. Leave **Where should new rows go?** blank. Wait for **Import preview**:

| Check | Expected first preview |
|---|---:|
| New employees | 1,000 |
| Updated placements | 1,000 |
| Protected values | 0 |
| Flagged for review | 0 |
| Row-level problems | None |

Both 1,000s refer to the **same people**: each new employee gets a placement with populated HR fields. They are not added together. If the numbers differ or **Rows needing attention** appears, click **Cancel**. If you renamed the built-in hierarchy, adjust columns A–C in a copy of the workbook to match your actual projects, subprojects and categories, then preview again. When the checks match, click **Apply import** once and wait for **Import complete**. Just choosing the file writes nothing.

## 3. Check that it worked

| Check as administrator | Expected result |
|---|---|
| Dashboard → People in scope | **1,000 people · 1,000 placements** |
| Employee Directory, **All my projects**, clear search and filters | **1,000** next to **Employee records**; the table is paginated |
| Search `TEST-0001` | One row: **Aarav Sen**, Nexus Digital Transformation → Core Banking Migration → Delivery Status |
| Clear search, filter **Bench Category = Bench** | **200** placements; clearing the filter returns to 1,000 |
| Preview the unchanged file again, before making any edits | **0 new, 0 updated**, no row issues. Click **Cancel**. |
| In Excel, **Save As** a copy. For `TEST-0001`, change only **detail comments** from `Sample note 0001` to `Import check passed`. Upload the copy. | **0 new, 1 updated**. Apply; in Directory search `TEST-0001`, click **Aarav Sen**, and read **Detail Comments** in the CRM panel. The total stays 1,000. |

Use the administrator for totals: a project-restricted supervisor may see fewer people. Each of the four sample hierarchy projects has **250** placements. Excel is not a live connection; edits to the workbook reach this database only after you import and apply them again.

## Keep it, or undo it

- **Keep:** close and reopen `START-PREVIEW.cmd` normally. It keeps using the uploaded roster; no second upload or setup command is needed.
- **Undo:** stop the preview with **Ctrl+C**. From the app folder, move the **whole workbook-preview folder** aside and restart. This restores the original roster without deleting the 1,000-record copy:

  ```powershell
  Rename-Item -LiteralPath .\data\workbook-preview -NewName ("workbook-preview-saved-" + (Get-Date -Format yyyyMMdd-HHmmss))
  .\START-PREVIEW.cmd
  ```

  Check that the active path now ends in `data\guided-preview.db`; refresh and sign in. To switch back later, stop the preview and rename the saved folder to `workbook-preview` again when that name is unused. Changes made in the two databases are independent. Keep database folders private; they contain accounts and history.

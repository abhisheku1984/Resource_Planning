# Daily roster: export yesterday’s dump, replace it with today’s

You need an **administrator account in Resource Planning** and the complete new `.xlsx` file. **You do not need Excel or Microsoft 365** to export or upload it. The app reads the file; you never need to open it. An Excel licence alone does not grant permission to delete a roster. Use your own administrator account, not a shared password.

**Preloaded Windows preview:** If you received `Resource-Planning-1000-Employees.zip`, extract it to a **new folder**, stop any running preview on port 4110, and double-click `START-PREVIEW.cmd`. Open <http://localhost:4110>. The bundled demo already has all 1,000 rows; no initial upload, delete or seed is needed. Your existing installation is separate.

## The daily checklist

1. **Export the old roster.** Sign in to the installation you intend to update. In **Data Hub → Replace entire roster → Export current roster**, download the complete, dated workbook. Check that it is in Downloads, then keep it in your team’s approved private archive. This step is unfiltered; do not substitute one project’s export.
2. **Choose the new dump.** Select the complete new `.xlsx`, not a workbook containing only changed rows. It needs Employee IDs and placements. If it lacks Project / Subproject / Category columns, use **Where should new rows go?** to choose one existing placement for those rows. Click **Preview replacement**.
3. **Check the numbers.** Compare **Current roster to delete** with **New roster from [filename]**. People are distinct employees; placements are rows. If the count is unexpectedly small, the file is incomplete, or any issue is reported, click **Cancel** or **Choose another file**. The old roster is still live.
4. **Delete and load together.** After confirming that the export is saved and the new counts are correct, type **`REPLACE`** and click **Delete old roster and import** once. The app deletes the previous workforce and imports the new roster in one transaction. There is no separate “delete everything” step and no period where a bad file leaves the live roster empty. Wait for **Roster replaced**.
5. **Verify.** In **Dashboard → People in scope**, check the new count. In **Employee Directory**, select **All my projects**, clear filters, check the placement total and look up a known new ID. If yesterday’s dump had an ID that is absent today, searching it should now give zero rows. The filename appears in **Data Hub → Recent uploads**; the operator and replacement appear in the **Audit Trail**.

**Example:** Yesterday had 1,000 people with one placement each; today’s complete file has 980. After replacement the Dashboard should show **980 people**, not 1,980. For the supplied `workforce-1000.xlsx`, expect **1,000 people / 1,000 placements**; search `TEST-0001` for Aarav Sen.

## What gets deleted?

- **Replaced:** all employee and placement rows (even IDs also in the new file), their old values, manual overrides, and group memberships. Only values supplied by the new dump carry forward. Pending duplicate reviews and approval proposals for the old roster are closed, not applied to new employees.
- **Kept:** application logins, permissions, project hierarchy, field layouts, suppliers, group definitions and historical import/audit entries. Supervisor visibility still follows their grants.
- **For changes only:** use **Upload a daily dataset → Apply import** instead. That is a **merge** by Employee ID: absent people remain and protected fields are kept. Do not use replacement for a one-person correction.

## If something goes wrong

- A validation error, an empty workbook, duplicate placements, or a failed database backup **blocks replacement**. No manual deletion is necessary. Use the template’s headers or those of the app’s full export.
- If another operator edits the roster, you restart the server, or more than 30 minutes pass after export, start again with a **new full export**. If the network disconnects after confirmation, check Dashboard and Recent uploads before retrying.
- Besides the dated Excel download, the server keeps **one full SQLite restore point**, `roster-backups/<active-database-filename>.before-last-replace.db`, next to the active database. This includes information not present in Excel, including access, locks, history and sessions. It is private, not a web download; a subsequent replacement refreshes it. Keep any additional backups under your normal retention and access policies.
- For an exact rollback, have the host administrator stop the server, preserve the current database **and its matching WAL/SHM files together** in a new private folder, then copy the verified restore point to the **exact active database path** before restarting. Never combine an old DB with another DB’s WAL. This restores the **whole database** to that point, including accounts and any settings changed since; take a backup first. For a data-only correction, prepare the correct complete workbook and repeat the five steps instead.

**Do not delete SQLite files, run `npm run seed`, or restart the app each day.** The daily operation is in the browser and affects only the installation you are signed in to. The Arena preview and a Windows `localhost` installation are separate databases.

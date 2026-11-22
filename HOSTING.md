# Connect the team login (one time, owner only)

**Daily use:** open [Resource Planning sign-in](https://abhisheku1984.github.io/Resource_Planning/) from the repository → enter your **app** ID and password on your team’s HTTPS server → the dashboard opens. This link always asks for credentials, even if the browser has used the app before. GitHub’s own sign-in page and home feed do not change. The project link is public: a GitHub login or repository membership is neither required nor sufficient for an app session. If membership itself must be enforced, use an approved identity gateway as well.

The GitHub Pages address is a signpost, not a server. **Until a team server is connected there is no online account to sign in to.** Don't type an app password into GitHub or send one in chat. No Codespace is needed.

## If you already have a team server

Use the HTTPS address of the server running **this Node app**, not a repository, a temporary preview, or a public sample. The server must keep its SQLite database on private persistent storage. Open `/login` on it and verify your ID works. Then connect the address below. No new hosting purchase is needed.

## If you don’t have a server: optional managed setup

[**Review deployment on Render**](https://dashboard.render.com/blueprint/new?repo=https%3A%2F%2Fgithub.com%2Fabhisheku1984%2FResource_Planning)

1. Sign in to **your own hosting account** and authorize access to this repository when prompted. Use `main` and `render.yaml`. The [blueprint](render.yaml) proposes **one paid web service and a 1 GB persistent disk**. Review the region, access policy and price shown by the host before approving; close the page if you don't want the charges. Opening the review or merging code does not purchase hosting.
2. In the hosting form, enter `RP_OWNER_NAME` (your display name), `RP_OWNER_EMAIL` (your chosen app login ID), and `RP_OWNER_PASSWORD` (a new unique password of 14–256 characters). Enter the password **only in the host's private setting**. Apply the deployment when ready. On the mounted disk a fresh app gets fictional starter records and exactly one administrator. No Windows data or accounts are uploaded.
3. When the service is live, open **its HTTPS service URL followed by `/login`**. Sign in. Under your profile → **Account & session** change the initial password, then remove `RP_OWNER_PASSWORD` from the host's environment settings. Restarting the same service with its disk keeps users, passwords and records. Editing the initial environment values cannot change an existing account. Use **Administration → Users & access → New user** to assign other logins; **Change login ID** changes an existing ID.

**Before using real staff data:** restrict inbound access through an approved company gateway/VPN or hosting access rules, arrange encrypted backups and test a restore. A public HTTPS URL with app authentication is not a private network. Do not delete the disk or use a free ephemeral filesystem for team accounts. Use SQLite-consistent backups; do not copy a running `.db` without its WAL. Never commit a database, backup, employee roster or secret.

## Connect the GitHub link

Give the repo maintainer **only the verified service origin** (HTTPS scheme and hostname, optional port; no password, path, query string or token). They can do this part for you:

- Put that origin in `teamOrigin` in [`deploy/site.json`](deploy/site.json). The address will be public; it must be a team-controlled, stable host. `null` leaves sign-in unconnected.
- Run `npm ci`, `npm run build:pages`, and `npm test`; publish the config and generated files together. The repository’s existing **Open Resource Planning sign-in** link will now open the server’s `/login` directly. Bookmark that link. The optional [fictional sample](https://abhisheku1984.github.io/Resource_Planning/sample.html) remains separate.

**Other hosts:** Node 22.5+; one process, one existing private mounted directory in `DATA_DIR` (no `DB_FILE` override), a TLS reverse proxy in front of the app, and the same owner secret settings. Install production dependencies with `npm ci --omit=dev --ignore-scripts`, then `npm run start:hosted` at runtime, not at build time. `/api/health` responds after the database and first owner are ready. The standard Windows launcher remains loopback-only by default and keeps its private interactive setup.

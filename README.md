# Digiteq Dashboard

Company dashboard for clients, tasks, team assignments and notes. Updates appear live on every device.
There is one codebase: the same app runs as a **website**, an installable **PC app** (Chrome/Edge) and a **phone app**.

## What it does

| # | Feature | Where |
|---|---------|-------|
| 1 | **Clients**: one card per client. Tap a card to see its tasks, **deadlines**, **materials & links** (files or URLs) and info | Clients |
| 2 | **Assignment is required.** A super admin cannot create *or update* a task until at least one employee is picked (one or more). Assigned employees get notified | New task / Edit task |
| 3 | **Finishing a task**: *Mark as done* opens a sheet where you can attach the finished work (files/links) and a note. The task is stamped with the date and time and who completed it | Task → Mark as done |
| 4 | **Super admin gets notified** when any task is done: in-app alert + sound, a bell badge, and a phone/PC push notification even when the app is closed (once notifications are turned on) | Bell / Notifications |
| 5 | **Employees add tasks to their own list only.** These tasks never go on the company dashboard as admin assignments. They are marked *Self-added*, can be linked to a client, and the admin is told about them | My tasks → Add task |
| 6 | **Notes**: a notes button at the bottom (round button bottom-right on PC, centre of the tab bar on phones) pops open a notes window. *Add to tasks* → **Confirm** turns a note into a task; the note then shows "In my tasks" | Notes button |
| – | **Hourly progress updates**: while a task is in progress, employees post short updates ("Figma file done", "Prototype complete") with an optional % done. The super admin is **not** pinged for each one: every hour they get **one notification with all updates together**, plus an *Updates* page grouped by hour. Employees with tasks in progress that have no update in the last hour get an hourly reminder | Task → Progress updates · Updates |
| – | **Client logos**: upload a logo when adding/editing a client, or tap the image icon on the client page. It's shown on client cards, tasks and the overview | Clients |
| – | **List or Board** view for tasks on PC. Drag cards between To do / In progress; dropping on Done opens the "Mark as done" sheet | Tasks |
| – | **Light / Dark / Auto** theme | Settings |
| – | **Live updates on every page**: changes show up within a few seconds with no refresh needed (green dot = live). It re-syncs when you reopen the app | everywhere |
| – | **No pull-to-refresh on phones**: swiping down never reloads the app | phone |

Roles: **Owner** is a super admin who also sees **Finance**. **Super admin** has full control of clients, tasks and team, but no money screens. **Employee** sees their own tasks, can view clients, and keeps their own notes and self-added tasks. The account created at first-run setup is the first owner. Only an owner can make another super admin an owner (Team → edit → *Owner*), and there is always at least one owner.

### Owner · Finance

Only owners can see these screens: the server refuses finance requests from anyone else, and clients' money details are hidden from other roles.

| Screen | What it's for |
|--------|---------------|
| **Overview** | Outstanding, overdue, collected this month, monthly recurring revenue and likely pipeline value. Also shows **client dues** (who owes what, and since when), invoices coming due, sales follow-ups and recent payments |
| **Receivables** | Invoices with tabs for Due / Overdue / Paid / Cancelled. Open an invoice to **record payments** (part payments allowed, with method and UTR/cheque reference). Status updates automatically (Due → Part paid → Paid, or Overdue after the due date) |
| **Commercials** | What each client pays: one-time projects or monthly / quarterly / yearly retainers, with dates, notes and the signed quote/contract file. **Generate** raises this month's retainer invoices in one click and never duplicates them |
| **Opportunities** | Sales pipeline: Lead → Contacted → Proposal sent → Negotiation, as a drag-and-drop board on PC. Each deal has a value, a "% likely" figure and a follow-up date. **Won** turns the deal into a client; **Lost** records the reason |

Each client page has a **Finance** tab for owners, showing that client's commercials, invoices and dues. Owners get a 💰 alert when another owner records a payment, plus a morning "money check" at the start of work hours listing overdue invoices and follow-ups due. Amounts are in `CURRENCY` (default `INR`) and are entered as totals (no separate tax lines).

## Run it

Requires **Node.js 22.13+** (Node 24 recommended) and npm. The app runs in Cloudflare's local Workers runtime, with local D1 and R2 emulators. No Cloudflare login or production bindings are needed for local development.

```bash
npm install
npm run dev
```

Open [http://localhost:8788](http://localhost:8788). The first screen creates the **super admin** account. After that, go to **Team → Add employee** to add your staff.

Wrangler stores local D1/R2 data in `.wrangler/state/`. It is separate from production and is ignored by Git. The schema is created automatically on the first API request. To start with an empty local workspace, stop the dev server and remove only `.wrangler/state/`.

For optional local settings, create an ignored `.dev.vars` file:

```dotenv
TIMEZONE=Asia/Kolkata
WORK_START=9
WORK_END=20
VAPID_SUBJECT=mailto:admin@digiteq.local
CRON_SECRET=replace-with-a-random-local-secret
CURRENCY=INR
```

`TIMEZONE` is an IANA time zone. Work hours are inclusive: defaults are 09:00 through 20:00 in India. The overview's **Done today**, hourly job slots, and next digest time all use this zone. Local requests to `/api/sync` also check the hourly job, at most once a minute per isolate.

To repeat the integration smoke test against a **disposable local workspace**, keep `npm run dev` running and use another terminal:

```bash
npm run test:flow
npm run test:runtime
npm run test:finance
```

The flow test creates a local super admin (`smokeadmin` / `local-smoke-password`) on an empty database, then exercises employees, client logos, assignments, raw uploads, progress, digest/completion alerts, private notes, sync, downloads and permissions. It retains test fixtures for browser checks. On an existing local test database, set `TEST_ADMIN_USERNAME` and `TEST_ADMIN_PASSWORD` to its admin credentials. Never use these test credentials for a deployed workspace.

Existing `data/` from the Node version is **not migrated**. Its SQLite database, files, scrypt password hashes and push keys are not read by this version. Keep a backup if you need those records; a fresh Cloudflare deployment starts with first-run setup.

## Put it online

### Cloudflare setup

Use the **Digiteq Cloudflare account**, where Pages project **`digiteqdash`** lives. The project is connected to GitHub repository `infodigiteq00-hue/Digiteq-Dashboard`, branch `main`. The CLI currently logged in under another account must not be used to create or deploy production resources there.

1. In the Digiteq account, create a **D1 database** named `digiteq` and an **R2 bucket** named `digiteq-files`. [R2 requires enabling an R2 subscription and billing details, including for the free tier](https://developers.cloudflare.com/r2/get-started/).
2. In the Pages project's build settings, leave the **build command empty**, set **build output directory** to `public`, and **root directory** to `/`. Static assets come from `public/`; Pages builds the API from `functions/` automatically.
3. Under **Settings → Bindings**, add a **D1 database** binding named **`DB`** pointing to `digiteq`, and an **R2 bucket** binding named **`FILES`** pointing to `digiteq-files`. Configure the production environment (and preview separately if you use previews). Missing bindings return JSON errors pointing back here.
4. Set environment variables: `TIMEZONE=Asia/Kolkata`, `WORK_START=9`, `WORK_END=20`, `CURRENCY=INR`, and a long random **`CRON_SECRET`**, stored as a secret. Optionally set `VAPID_SUBJECT` to a contact email such as `mailto:admin@yourcompany.com`. Use compatibility date `2025-01-01` or later. Redeploy after changing bindings or variables.
5. Deploy the small scheduled Worker **after authenticating Wrangler to the Digiteq account**:

   ```bash
   cd cron
   npx wrangler deploy
   npx wrangler secret put CRON_SECRET
   ```

   Enter the **same secret** configured on Pages. Its schedule runs every 15 minutes and POSTs to `https://digiteqdash.pages.dev/api/cron/hourly`; the API claims each local hourly slot only once, during work hours. Set `SITE_URL` in `cron/wrangler.toml` if the Pages hostname changes. The cron Worker keeps digests/reminders running even with no open app. The endpoint refuses requests when `CRON_SECRET` is unset or incorrect.
6. Open [https://digiteqdash.pages.dev](https://digiteqdash.pages.dev) and create your production super admin. HTTPS supports installation and push notifications. VAPID keys are generated once and saved in D1 automatically.

There is intentionally **no root `wrangler.toml`**: production Pages bindings belong to the Digiteq account and are configured in its dashboard. `cron/wrangler.toml` configures only the scheduled Worker.

The [free Workers plan permits 100,000 requests per day](https://developers.cloudflare.com/workers/platform/limits/#daily-request). API polling counts toward that quota. The app checks every 3 seconds while active, every 8 seconds after two idle minutes, and every 30 seconds while hidden; each open tab/device adds requests. Static asset requests are separate from Pages Functions usage. Review usage before rolling out to a large team.

**Backups:** export D1 and preserve R2 objects separately using Cloudflare's dashboard or account-scoped tooling. Keep VAPID metadata with the database so existing push subscriptions continue to work after a restore.

## Install the apps

### PC app (Chrome / Edge, on Windows, Mac or Linux)
Open the dashboard → click **Install app** in the left sidebar, or use the install icon in the address bar.
It opens in its own window, gets a desktop/start-menu icon and updates itself.

### Phone app
- **Android (Chrome):** open the dashboard → **Install app** banner, or menu ⋮ → *Install app / Add to Home screen*.
- **iPhone (Safari):** Share → **Add to Home Screen**. Notifications on iPhone work only after this step (iOS 16.4+).

The installed phone app runs full-screen with a bottom tab bar and no browser bars. Pull-to-refresh is turned off, and changes still show up live.

### Optional: Play Store / App Store build
`mobile/` holds a Capacitor wrapper that loads your hosted dashboard as a native app:

1. Set `server.url` in `mobile/capacitor.config.json` to your HTTPS dashboard address.
2. Run the commands below, then build the APK/AAB in Android Studio (or use Xcode for iOS).

```bash
cd mobile && npm install && npx cap add android && npx cap open android
```

## Project layout

```
functions/api/[[path]].js    Pages API entry point
server/api.js               async API, D1 schema, permissions, digest/reminder jobs
server/push.js              WebCrypto push encryption and VAPID
server/time.js              scheduling in the configured time zone
server/finance.js           owner-only finance API: commercials, invoices, payments, opportunities
cron/                       scheduled Worker (every 15 minutes)
public/index.html           app shell
public/app.js               front-end, adaptive sync polling and direct uploads
public/finance.js           owner Finance screens
public/styles.css           styles (light + dark mode, phone + desktop)
public/sw.js                service worker: install, offline shell, push notifications
public/manifest.webmanifest app name/icons for installing
mobile/                     optional Capacitor wrapper for app-store builds
tests/                      local API integration and Workers runtime checks
.wrangler/state/            local emulated database and files (not in git)
```

## Notes
- Each upload can be up to 25 MB. For bigger files, share a Drive/Dropbox link instead.
- Logging in on a new device keeps the other devices logged in. Changing a password signs out the other devices.

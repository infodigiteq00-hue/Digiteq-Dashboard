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
| – | **Live updates on every page**: changes show up right away with no refresh needed (green dot = live). It re-syncs when you reopen the app | everywhere |
| – | **No pull-to-refresh on phones**: swiping down never reloads the app | phone |

Roles: **Super admin** has full control (clients, tasks, team). **Employee** sees their tasks, can view clients, and keeps their own notes and self-added tasks.

## Run it

Requires **Node.js 22.13+**. Node 24 is recommended. There is no database server to install: data is kept in `data/dashboard.db` (SQLite built into Node).

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000. The first screen creates the **super admin** account. After that, go to **Team → Add employee** to add your staff.

Settings (environment variables): `PORT` (default 3000), `DATA_DIR` (default `./data`), `VAPID_SUBJECT` (contact for push, e.g. `mailto:you@company.com`), `WORK_START` / `WORK_END` (hours when hourly digests and reminders are sent, default 9 and 20), and `TZ` (your timezone, e.g. `Asia/Kolkata`, so those hours match your clock).

**Backup:** copy the `data/` folder. It holds the database, uploaded files and the push keys.

## Put it online (so phones and other PCs can use it)

Installing the app and getting push notifications both need **HTTPS**. Some options:

- A small VPS (DigitalOcean, Hetzner, AWS Lightsail…) running `npm start` behind **Caddy**, which adds HTTPS automatically:
  `dashboard.yourcompany.com { reverse_proxy localhost:3000 }`
- Any Node host with a persistent disk (Render, Railway, Fly.io). Mount a volume and point `DATA_DIR` at it.

Keep the process running with `pm2 start server.js --name digiteq` or a systemd service.

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
server.js            API, live updates (Server-Sent Events), push notifications, static files
public/index.html    app shell
public/app.js        the whole front-end (no build step)
public/styles.css    styles (light + dark mode, phone + desktop)
public/sw.js         service worker: install, offline shell, push notifications
public/manifest.webmanifest  app name/icons for installing
mobile/              optional Capacitor wrapper for app-store builds
data/                created on first run: database, uploads, push keys (not in git)
```

## Notes
- Each upload can be up to 25 MB. For bigger files, share a Drive/Dropbox link instead.
- Logging in on a new device keeps the other devices logged in. Changing a password signs out the other devices.

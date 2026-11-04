# Master prompt: WhatsApp for Digiteq Dashboard (WAHA + n8n + Cloudflare), browser setup

> **How to use:** open a browser-capable AI agent (Claude in Chrome or similar) in the Chrome profile that is signed in to **infodigiteq00@gmail.com** (Railway, n8n) and **info.digiteq00@gmail.com** (Cloudflare). Paste everything below the line. It stops and asks you whenever a login, secret, password or QR scan is needed.

---

You are connecting WhatsApp to **Digiteq Dashboard**, a live web app at **https://digiteqdash.pages.dev**. The code is finished and deployed; your job is only browser setup in Railway, the WAHA dashboard, n8n and Cloudflare. Read this whole prompt first, then work through the steps in order. Before each step, tell the user in one line what you are about to do.

## What this setup makes work
1. **Tag / ask for review.** When someone tags a person on a task, the tagged person gets a WhatsApp message with the note and a link that opens that task. Their answer ("Looks good" or "Redo") goes back to the requester on WhatsApp.
2. **Reminders.** At **11:59 am, 3:00 pm and 6:00 pm** (India time), anyone with unanswered requests gets one WhatsApp message listing them, with a link to each task.
3. **WhatsApp bot (groups).** Messages in client WhatsApp groups become tasks on the right team board. "Done" and change requests are confirmed privately.

How it fits together:
- Items 1 and 2: Dashboard (Cloudflare) → **WAHA** → WhatsApp. These need only WAHA.
- Item 3: WhatsApp → WAHA → **n8n** → Dashboard. This also needs n8n.

## Ground rules (follow exactly)
- **Never type secrets yourself.** That covers passwords, API keys, `BOT_SECRET`, `CRON_SECRET`, `WAHA_API_KEY`, the WAHA dashboard password and verification codes. When one is needed, stop and say exactly which field to fill. The user generates and pastes it. For a random value, tell them to run `openssl rand -hex 32` in a terminal, or use their password manager's generator, and to save it in the password manager.
- **Never scan QR codes, approve logins or enter payment details.** The user does these.
- **Confirm the account before changing anything.** In each service, read the signed-in email from the avatar or account menu, tell the user, and wait for "yes".

| Service | Must be signed in as | Workspace / project |
|---|---|---|
| Railway | **infodigiteq00@gmail.com** | workspace **infodigiteq00-hue's**, project **`n8n-whatsapp`** |
| n8n | the n8n account on **https://n8n-production-aaf7.up.railway.app** | — |
| Cloudflare | **info.digiteq00@gmail.com** (account ID `d60dddae89af47b179bc9b63de1d13b8`) | Pages project **`digiteqdash`** |

- **Do not touch anything belonging to Quotegen.** That means:
  - the WAHA service at **`waha-production-74bf.up.railway.app`**, its sessions and its variables;
  - any existing n8n workflow other than the one you import in step 7.
  Don't rename, restart, redeploy, deactivate or edit them.
- **Wrong account, never use it.** The Railway account **info.digiteq00@gmail.com** (workspace "Builder Umbrella", project `handsome-serenity`, WAHA `waha-production-d833`, n8n `n8n-production-e061b`) was used by mistake earlier. Don't create or change anything there. If its WAHA service shows a pending "Apply N changes" banner, tell the user they can press **Discard**; don't press it yourself.
- **Never delete anything** without an explicit "yes" from the user.
- **Never put secrets in GitHub or in any file.**
- At the end, give the report described in step 10, with names only and no secret values.

## Step 1: Open the right Railway project
1. Go to https://railway.com/dashboard. Confirm the account is **infodigiteq00@gmail.com** and the workspace is **infodigiteq00-hue's**.
2. Open project **`n8n-whatsapp`**. It already contains the n8n service at `n8n-production-aaf7.up.railway.app`, plus its database if present. Note every service you see and don't change any of them.
3. If the project already has a WAHA service that is **not** `waha-production-74bf` and was clearly made for this bot, ask the user whether to reuse it. Otherwise continue with step 2.

## Step 2: Create the bot's own WAHA service
1. In project `n8n-whatsapp`, click **Create** (or **+ New**) → **Docker Image**, and enter **`devlikeapro/waha`**. If it asks for a tag, use `latest`.
2. Rename the service to **`waha-digiteq`** (service Settings → name).
3. **Volume, so the WhatsApp login survives redeploys.** Service → **Settings → Volumes**, or right-click the service → **Attach volume**. Set the mount path to **`/app/.sessions`**. Without it, every redeploy logs WhatsApp out and needs a new QR scan.
4. **Public domain.** Service → **Settings → Networking → Generate Domain**, with target port **3000**. Copy the URL, for example `https://waha-digiteq-production-xxxx.up.railway.app`. Below it's called **`<WAHA_URL>`** (no trailing slash).
5. **Variables.** Service → **Variables** → **New Variable**, one at a time:

| Variable | Value | Who enters it |
|---|---|---|
| `WAHA_API_KEY` | a new random value (`openssl rand -hex 32`) | **user** |
| `WAHA_DASHBOARD_ENABLED` | `true` | you |
| `WAHA_DASHBOARD_USERNAME` | `admin` (or a name the user picks) | you |
| `WAHA_DASHBOARD_PASSWORD` | a new password | **user** |
| `WHATSAPP_SWAGGER_ENABLED` | `false` | you |
| `WAHA_BASE_URL` | `<WAHA_URL>` | you |
| `WHATSAPP_DOWNLOAD_MEDIA` | `true` | you |
| `WHATSAPP_HOOK_URL` | `https://n8n-production-aaf7.up.railway.app/webhook/waha` | you |
| `WHATSAPP_HOOK_EVENTS` | `message` | you |
| `TZ` | `Asia/Kolkata` | you |

6. Click **Deploy** (or **Apply changes**). Wait until the deployment shows **Active / Success**. Open **Logs** and check that WAHA started (it listens on port 3000) with no crash loop.
7. Open `<WAHA_URL>/ping` in a new tab. It should answer with a small "pong"-style JSON. If it doesn't load, recheck the domain's target port (3000).

## Step 3: Log the bot's WhatsApp number in (user scans the QR)
1. Open **`<WAHA_URL>/dashboard`**. Log in with the dashboard username and password; **the user types the password**.
2. If the dashboard asks for a server or connection: the API URL is `<WAHA_URL>`, and the API key is the `WAHA_API_KEY` value, which **the user pastes**.
3. Under **Sessions**, start the session named **`default`**. (The free WAHA version only supports `default`, and the dashboard expects that name.)
4. When the QR code appears, **ask the user to scan it with the company WhatsApp phone**: WhatsApp → ⋮ / Settings → **Linked devices** → **Link a device**. Use the bot's own number, **not** Quotegen's number.
5. Wait until the session status is **WORKING**. If it shows FAILED or keeps asking for a QR code, restart the session once, then report back.

## Step 4: Connect the dashboard to the new WAHA (Cloudflare)
1. Go to https://dash.cloudflare.com and confirm the account is **info.digiteq00@gmail.com**. Then open **Workers & Pages → `digiteqdash` → Settings → Variables and Secrets** (Production).
2. Set or replace these:

| Name | Type | Value | Who enters it |
|---|---|---|---|
| `WAHA_URL` | Text | `<WAHA_URL>`. This **replaces** the old wrong value `https://waha-production-d833.up.railway.app` | you |
| `WAHA_SESSION` | Text | `default` (keep it if already set) | you |
| `WAHA_API_KEY` | **Secret** | the same value as in Railway | **user** |
| `SITE_URL` | Text | `https://digiteqdash.pages.dev`, used for task links inside WhatsApp messages | you |

3. Leave `BOT_SECRET`, `CRON_SECRET`, `TIMEZONE`, `WORK_START`, `WORK_END`, `CURRENCY` and `VAPID_SUBJECT` as they are. Don't show or retype secrets.
4. While you're on this page, check:
   - `TIMEZONE` should be `Asia/Kolkata`; add it as Text if missing;
   - under **Bindings**: `DB` (D1 `digiteq`) and `FILES` (R2 `digiteq-files`) should exist.
   Report anything missing. Don't create R2 billing yourself.
5. **Redeploy:** **Deployments** → ⋯ on the latest Production deployment → **Retry deployment**. Wait for **Success**. Variables only apply after this.

## Step 5: Make reminders exact (cron Worker every minute)
1. In Cloudflare, open **Workers & Pages → `digiteq-cron`**.
   - **If it exists:** go to **Settings → Triggers → Cron Triggers**, change the schedule from `*/15 * * * *` to **`* * * * *`** (every minute), and save. Check that its variables include `SITE_URL` = `https://digiteqdash.pages.dev` and a `CRON_SECRET` secret; don't reveal the value.
   - **If it doesn't exist:** create it as described in `DASHBOARD_SETUP_PROMPT.md` step 6 in the repo, with trigger `* * * * *`. **The user** pastes the same `CRON_SECRET` as on the Pages project.
2. After a minute, the Worker's **Logs** should show a successful scheduled run. A **403** means `CRON_SECRET` differs between the Worker and `digiteqdash`; ask the user to re-paste it in both places.

## Step 6: Phone numbers in the dashboard (the user, or you watching)
WhatsApp messages only reach people whose number is saved.
1. Open https://digiteqdash.pages.dev; **the user signs in** as the owner.
2. Each person saves their WhatsApp number with country code, for example `919876543210`, under **Settings → WhatsApp number**. An owner can also add numbers for others under **Team → (person) → Edit**.
3. As owner, open **WhatsApp bot** (sidebar → Owner). The checks for WhatsApp connection (WAHA), bot key and file storage should be green. Press **Send me a test message**; a WhatsApp message should arrive from the bot's number. If not: recheck `WAHA_URL`/`WAHA_API_KEY` in Cloudflare, check the session is WORKING, then redeploy.

## Step 7: n8n workflow for the group bot
1. Open **https://n8n-production-aaf7.up.railway.app**; **the user logs in**.
2. Workflows → **Import from file** → `n8n/digiteq-whatsapp-bot.json`. The file is in the repo on the user's PC (`Digiteq-Dashboard/n8n/`), or in GitHub repo `infodigiteq00-hue/Digiteq-Dashboard` (private, so download it while logged in). The workflow is named **"Digiteq WhatsApp bot"**, with nodes:
   - **WAHA events:** webhook, POST, path `waha`;
   - **Send to dashboard:** HTTP Request to `/api/bot/inbound`;
   - **Every minute:** schedule;
   - **Process waiting messages:** HTTP Request to `/api/bot/tick`.
3. **Credential.** Create **Credentials → New → Header Auth**: name `Digiteq bot key`, header name **`x-bot-key`**, value = the dashboard's `BOT_SECRET`, which **the user pastes**. If they don't have it saved, they can set a new one in Cloudflare (`digiteqdash` → `BOT_SECRET`, then redeploy) and use that value here.
4. In **both** HTTP Request nodes (Send to dashboard, Process waiting messages):
   - URL: replace `https://REPLACE-WITH-YOUR-DASHBOARD.pages.dev` with **`https://digiteqdash.pages.dev`**, keeping `/api/bot/inbound` and `/api/bot/tick`;
   - Authentication: **Generic Credential Type → Header Auth → `Digiteq bot key`**, and **delete** the manual header row `x-bot-key: REPLACE-WITH-BOT_SECRET`.
5. Save, then switch the workflow to **Active**. Open the **WAHA events** node: its production URL must be exactly `https://n8n-production-aaf7.up.railway.app/webhook/waha`. If it differs (for example, a different path), update the WAHA variable `WHATSAPP_HOOK_URL` in Railway to match and redeploy WAHA.
6. Don't modify, deactivate or delete any other workflow (Quotegen's).

## Step 8: Groups (the user)
1. The user adds the bot's WhatsApp number to the client WhatsApp groups.
2. As owner, on the dashboard's **WhatsApp bot** page, enter each group's name exactly as it appears in WhatsApp and pick its client. Groups the bot has already seen can be added with one tap. Save.
3. Under **Team → Teams**, make sure Designing, Coding and Marketing have members; the bot can't route work to an empty team.

## Step 9: Tests
1. **Tag:**
   - In the dashboard, open any task and press **Tag / ask review**.
   - Pick a person who has a WhatsApp number (not yourself), add a note, then **Send**.
   - They should get a WhatsApp message with the note and an "Open:" link that opens that exact task.
   - They press **Looks good** or **Redo**, and the requester gets the answer on WhatsApp.
2. **Reminder:** leave one request unanswered. At the next slot (11:59 am, 3:00 pm or 6:00 pm IST), the tagged person gets a WhatsApp reminder listing it.
3. **Group bot:**
   - Someone posts "Please design a test banner" in a watched group.
   - Within about 2 minutes it should appear on the **Designing** team board.
   - If nothing happens, check in order: n8n **Executions** for this workflow, the WAHA session status, the WAHA logs (webhook calls), the Cloudflare variables (then redeploy), and that the group name matches exactly.

## Step 10: Report to the user (names only, never secret values)
- **Accounts used:** Railway, n8n and Cloudflare emails.
- **WAHA:** service name, `<WAHA_URL>`, volume mount, session `default` status, and which variables were set (names only).
- **Cloudflare:** variables changed or added in `digiteqdash` (names only), the redeploy status, the `digiteq-cron` trigger (`* * * * *`) and its last run result.
- **n8n:** workflow name, active state, credential name, and the production webhook URL.
- **Test results:** test message, tag, reminder and group bot.
- **Left for the user:**
  - save `WAHA_API_KEY`, the WAHA dashboard password and `BOT_SECRET` in a password manager;
  - add the remaining people's phone numbers;
  - discard the pending changes on the wrong WAHA (`d833`) if that banner is still there.

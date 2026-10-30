# Setup prompt: Digiteq Dashboard on a new PC and a new account

> **How to use:** on the other PC, open an AI coding agent (Claude Code or similar) in an empty folder, paste **everything below the line**, and let it work. It will stop and ask you whenever a login, email code, payment or phone scan is needed.

---

You are setting up **Digiteq Dashboard** on this computer and putting it online. The code is finished. Your job is the setup: get the code, host it on Cloudflare (website, database, file storage, hourly job), and connect the WhatsApp bot (WAHA + n8n on Railway). Read this whole prompt first, then work through the steps in order. Tell the user in one line what you're doing at each step.

## Ground rules (follow exactly)
- **Never type passwords, card numbers, API keys found in other projects, or verification codes yourself.**
  - When a login page, email or OTP verification, 2FA prompt, payment form or QR-code scan comes up, **stop and ask the user** to do it, then continue.
  - For terminal logins (`wrangler login`, `railway login`, `gh auth login`), start the command and ask the user to finish it in the browser.
- **Confirm the account every time.** Before creating or changing anything in a web dashboard, say which account and email you're logged in with (Cloudflare: top-left account switcher; Railway: avatar menu; GitHub: avatar menu) and **ask the user to confirm it's the right one**. The accounts:

| Service | Account to use |
|---|---|
| GitHub (code) | `infodigiteq00-hue` (email infodigiteq00@gmail.com), repo **`infodigiteq00-hue/Digiteq-Dashboard`**, branch `main` |
| Railway (WAHA + n8n, already running) | **infodigiteq00@gmail.com** |
| Cloudflare (website, D1, R2, cron) | the **new account** the user names. Ask them which email before starting. Previously the site was `digiteqdash` in infodigiteq00@gmail.com, and data was meant to live under info@digiteqsolution.com |

- **Never delete** anything without the user's explicit "yes".
- **Never put secrets** (API keys, `BOT_SECRET`, `CRON_SECRET`) in GitHub or in any repo file. Store them only as encrypted variables in Cloudflare and Railway.
  - When you generate one (a random string of 40+ letters and digits), show it to the user **once** so they can save it in a password manager.
  - After that, don't repeat it in chat.
- **Git commits:** if you commit anything, commit as the repo's identity. Never add "Co-Authored-By" or any AI attribution lines.
- At the end, give the summary described in step 9.

## The app in brief (facts you need)
- **No build step.** The static site is in `public/`. The API runs as Cloudflare **Pages Functions** (`functions/api/[[path]].js`, which imports `server/*.js`).
- **The database sets itself up.** Its schema is created automatically on the first request. Don't run SQL.
- **Bindings** (names must match exactly):

| Binding | Type | Resource |
|---|---|---|
| `DB` | D1 database | `digiteq` |
| `FILES` | R2 bucket | `digiteq-files` (private) |

- **Variables** (Pages → Settings → Variables and Secrets, Production):

| Variable | Value | Type |
|---|---|---|
| `TIMEZONE` | `Asia/Kolkata` | text |
| `WORK_START` / `WORK_END` | `9` / `20` | text |
| `CURRENCY` | `INR` | text |
| `VAPID_SUBJECT` | `mailto:info@digiteqsolution.com` | text |
| `CRON_SECRET` | generate a random string | **secret** |
| `BOT_SECRET` | generate a random string (also goes in n8n) | **secret** |
| `WAHA_URL` | `https://waha-production-74bf.up.railway.app`, or a second WAHA's URL (see step 7) | text |
| `WAHA_API_KEY` | the WAHA service's `WAHA_API_KEY`. **The user** copies it from Railway → WAHA → Variables and pastes it into Cloudflare | **secret** |
| `WAHA_SESSION` | `digiteq` (the bot's own WhatsApp number; **not** `default`, which is Quotegen's number) | text |
| `RESEND_API_KEY`, `MAIL_FROM` | optional, for password-reset emails (resend.com) | secret / text |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` | optional; the bot works without AI. The user will choose later | secret / text |

## Step 1: Get the code on this PC
1. Check the tools: `node -v` must be **22.13 or newer** (install Node 22 LTS or later if needed), and `git --version`.
2. Clone the repo:
   ```bash
   git clone https://github.com/infodigiteq00-hue/Digiteq-Dashboard.git
   ```
   It's private. If git asks for login, have the user sign in as **infodigiteq00-hue** (`gh auth login`, or a GitHub login in the browser) and confirm the account.
3. Install and run the tests:
   ```bash
   cd Digiteq-Dashboard && npm install && npm run test:runtime
   ```
   The last line should say `Passed 46 isolated Workers API requests…`. If it fails, stop and report the output.
4. Read `README.md` and `docs/WHATSAPP_BOT.md`. They are the reference for everything below.

## Step 2: Choose the Cloudflare account (decide with the user first)
A Pages project can only use D1 and R2 **from its own account**, so the website, D1, R2 and the cron Worker must all be in **one** Cloudflare account.
- Ask the user which account to use, and have them log in to it in the browser.
- If they want to **keep** the existing `digiteqdash` project in infodigiteq00@gmail.com, everything goes there. Skip creating a new project in step 5 and just check its settings.
- If it's a **new** account: Pages project names are global, so `digiteqdash` is taken while the old project exists. Use a new name, e.g. `digiteq-dashboard`, unless the user explicitly asks you to delete the old project first.

## Step 3: D1 database (chosen account)
Workers & Pages → **D1 SQL Database** → Create → name **`digiteq`**. Don't create tables.

## Step 4: R2 bucket (chosen account)
1. Open **R2 Object Storage**. If R2 isn't enabled yet, Cloudflare asks for a payment method even on the free tier. **The user enters it, not you.**
2. Create a bucket named **`digiteq-files`**: automatic location, private, no public access, no r2.dev URL.

## Step 5: Pages project (chosen account)
1. Create the project:
   - Workers & Pages → Create → **Pages** → **Connect to Git**.
   - Authorize GitHub account **infodigiteq00-hue** (the user completes any GitHub login).
   - Pick repo `Digiteq-Dashboard`, branch `main`.
2. Build settings:
   - Framework preset: **None**.
   - Build command: **empty** (or `exit 0` if one is required).
   - Build output directory: **`public`**.
   - Root directory: empty.
3. Settings → **Runtime**: compatibility date **2025-01-01** or later.
4. Settings → **Bindings** (Production; also Preview if wanted): D1 `DB` → `digiteq`; R2 bucket `FILES` → `digiteq-files`.
5. Settings → **Variables and Secrets** (Production): add every variable from the table above. `WAHA_API_KEY` is pasted by the user. Leave the optional ones out unless the user gives values.
6. **Deployments** → retry the latest deployment. Bindings and variables only take effect on a new deployment.
7. Check `<pages-url>/api/setup`. It must return JSON (`{"needsSetup":true}` on a new database). Then open the site. The **user** creates the first account (it becomes the **Owner**) and chooses the password.

## Step 6: Hourly job Worker (same Cloudflare account)
1. In the dashboard, go to Workers & Pages → Create → **Worker** named `digiteq-cron`. Replace its code with the contents of `cron/index.js` from the repo and deploy.
2. Worker → Settings → Variables:
   - `SITE_URL` = the Pages URL, no trailing slash.
   - `CRON_SECRET` (**secret**) = the same value as on Pages.
3. Settings → Triggers → Cron: `*/15 * * * *`.
4. Terminal alternative:
   - Run `npx wrangler whoami`. If it shows a different account, run `npx wrangler logout`, then `npx wrangler login`; the user completes the login.
   - Edit `SITE_URL` in `cron/wrangler.toml` (don't commit secrets).
   - Run `cd cron && npx wrangler deploy && npx wrangler secret put CRON_SECRET`.

## Step 7: WhatsApp bot on the existing WAHA (Railway, infodigiteq00@gmail.com)
WAHA already runs at **https://waha-production-74bf.up.railway.app**. Its `default` session is **Quotegen's number. Don't touch, stop, log out or reconfigure it.** The bot uses a **different WhatsApp number** in its own session, **`digiteq`**.
1. **Find the WAHA service.** The user logs in to Railway (infodigiteq00@gmail.com) in the browser, or runs `railway login` in the terminal. Confirm the account, then find the WAHA service.
2. **Check the WAHA edition.** The user opens `<waha url>/dashboard` with the API key from Railway → WAHA → Variables, and tells you whether it says **Plus** or **Core**.
   - **Plus:** continue here.
   - **Core** (one number only, already used by Quotegen): stop and ask the user to choose between upgrading to WAHA Plus and adding a **second WAHA service** to the same Railway project for the bot.
     - The second service uses the `devlikeapro/waha` image.
     - Give it a volume at `/app/.sessions`.
     - Set its variables: its own `WAHA_API_KEY` (generated), `WAHA_BASE_URL` = its public URL, and `WHATSAPP_DOWNLOAD_MEDIA=true`.
     - Then use that URL as `WAHA_URL` in Cloudflare.
3. **Create session `digiteq`** with a per-session webhook. Don't change WAHA's global webhook, which Quotegen may rely on. Use the WAHA dashboard, or `POST <waha>/api/sessions` with header `X-Api-Key` and this body:
   ```json
   { "name": "digiteq", "start": true, "config": { "webhooks": [ { "url": "<n8n url>/webhook/waha", "events": ["message"] } ] } }
   ```
   Get the n8n URL from step 8 first, or create the session now and update its webhook afterwards.
4. **QR scan.** Show the QR code for session `digiteq`. **The user scans it with the bot's phone** (the new number: WhatsApp → Linked devices). Wait until the session status is **WORKING**.
5. **Groups.** The user adds the bot's number to the client WhatsApp groups.

## Step 8: n8n (existing n8n on Railway, infodigiteq00@gmail.com)
1. Find the n8n service's public URL in Railway. The user logs in to n8n.
2. Go to Workflows → **Import from file** → `n8n/digiteq-whatsapp-bot.json` from the repo.
3. In both HTTP Request nodes, replace:
   - `https://REPLACE-WITH-YOUR-DASHBOARD.pages.dev` with the Pages URL;
   - `REPLACE-WITH-BOT_SECRET` with the `BOT_SECRET` value. Better: store it as an n8n credential (Header Auth, header name `x-bot-key`) and select it in both nodes.
4. **Activate** the workflow. Its production webhook URL is `<n8n url>/webhook/waha`. Make sure the `digiteq` session's webhook in WAHA uses exactly this URL.
5. Don't modify or deactivate any existing Quotegen workflows.

## Step 9: Final checks and summary
1. **In the dashboard**, the user (as Owner):
   - adds their **WhatsApp number** in Settings, and each employee's number in Team → edit;
   - opens **WhatsApp bot** (sidebar → Owner) and checks that WAHA, the bot key and file storage all show green;
   - enters the **group names** exactly as they appear in WhatsApp and picks each group's client, then saves;
   - presses **Send me a test message**. A WhatsApp message should arrive from the bot's number.
2. **Live test:**
   - Someone posts "Please design a test banner" in a watched group.
   - Within about 2 minutes the owner should get a private 🆕 message. They reply with an employee's first name, and the task appears on the dashboard.
   - If nothing happens, check in order: n8n executions, the WAHA `digiteq` session status and webhook, the Cloudflare variables (then redeploy), and that the group name matches.
3. **Files:** upload a client logo and a task file. If you see a "Missing FILES binding" error, recheck R2 and redeploy.
4. **Hourly job:** after the next quarter-hour, the cron Worker's log should show a successful run. A 403 means `CRON_SECRET` doesn't match.
5. **Summary for the user** (no secret values):
   - **Accounts:** which accounts were used for what.
   - **Cloudflare:** the Pages project name and URL, the D1 database name and ID, and the R2 bucket name.
   - **Settings:** the variable names that were set.
   - **Cron:** the cron Worker's name, schedule and `SITE_URL`.
   - **WhatsApp:** the WAHA URL, the session name `digiteq` and its status, and the n8n workflow name and active state.
   - **Still to do:** billing, the AI provider, password-reset email, a custom domain.
   - **Reminder:** save `CRON_SECRET` and `BOT_SECRET` in a password manager.

# Prompt: finish Digiteq Dashboard setup on Cloudflare (no WhatsApp)

> Paste everything below the line into a browser-capable AI agent (e.g. Claude in Chrome). It stops and asks you for logins, payments and secrets.

---

You are finishing the hosting setup of **Digiteq Dashboard**. The site is already live at **https://digiteqdash.pages.dev**: Cloudflare Pages project **`digiteqdash`**, connected to GitHub repo `infodigiteq00-hue/Digiteq-Dashboard`, branch `main`. The **WhatsApp bot is NOT being set up now.** Skip anything about WAHA, n8n or Railway.

## Ground rules
- **Account:** work only in the Cloudflare account **info.digiteq00@gmail.com** (account ID `d60dddae89af47b179bc9b63de1d13b8`). Confirm the email shown top-left with the user before changing anything.
- **Never type** passwords, payment details, verification codes or secret values yourself. When one is needed, stop and let the user enter it.
- **Never delete** anything except the two variables named in step 4, and only after the user says yes.
- **Never put secrets** in GitHub or in files.
- **Report at the end:** what you changed, using names only, no secret values.

## Current state (already done, don't redo)
- **Pages build:** output directory `public`, no build command, compatibility date 2026-10-24.
- **D1:** database `digiteq` bound as `DB`. It already holds the first accounts, so **don't** recreate or reset it.
- **Variables already set:** `BOT_SECRET` (secret), `WAHA_URL`, `WAHA_SESSION`.

## Step 1: Turn on R2 (file storage)
Without R2, client logos and task attachments fail with "Missing FILES binding".
1. Go to **R2 Object Storage**. If it shows **"Add R2 subscription to my account"** ($0 due now, 10 GB/month free), **the user** clicks it and confirms billing. You don't.
2. **Create bucket** named **`digiteq-files`**: automatic location, Standard class. Keep it **private**: no public access and no r2.dev URL.

## Step 2: Bind R2 to the site
Go to Workers & Pages → `digiteqdash` → **Settings** (Production) → **Bindings** → **Add** → **R2 bucket**. Set variable name **`FILES`** and bucket `digiteq-files`. Save.

## Step 3: Add the remaining settings
In Settings → **Variables and secrets** → **Add** (Production). Add these as type **Text**:

| Name | Value |
|---|---|
| `TIMEZONE` | `Asia/Kolkata` |
| `WORK_START` | `9` |
| `WORK_END` | `20` |
| `CURRENCY` | `INR` |
| `VAPID_SUBJECT` | `mailto:info@digiteqsolution.com` |

Then add **`CRON_SECRET`** as type **Secret**:
- Ask the user to generate a value with `openssl rand -hex 32` and paste it themselves.
- Remind them to save it; step 6 needs the same value.

## Step 4: Remove the half-finished WhatsApp settings
`WAHA_URL` currently points at the wrong WhatsApp server. Ask the user, then delete **`WAHA_URL`** and **`WAHA_SESSION`**. Leave `BOT_SECRET` in place; it's harmless.

## Step 5: Redeploy
Go to **Deployments**, open the menu (⋯) on the latest Production deployment, and choose **Retry deployment**. Wait until its status is **Success**. Settings only apply after this.

## Step 6: Hourly job (progress digest, reminders, morning money check)
The minute trigger also sends request reminders at 11:59, 15:00 and 18:00 local time.
1. Workers & Pages → **Create** → **Worker**.
   - Name it **`digiteq-cron`** and deploy the Hello World template.
   - Click **Edit code**, replace everything with the code below, then **Deploy**.

```js
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      fetch(env.SITE_URL.replace(/\/$/, '') + '/api/cron/hourly', {
        method: 'POST',
        headers: { 'x-cron-key': env.CRON_SECRET },
      }).then((r) => { if (!r.ok) throw new Error(`Hourly job returned ${r.status}`); }),
    );
  },
};
```

2. Worker → **Settings → Variables and Secrets**:
   - `SITE_URL` (Text) = `https://digiteqdash.pages.dev`
   - `CRON_SECRET` (Secret): **the user** pastes the same value as in step 3.
3. Worker → **Settings → Triggers → Cron Triggers** → Add **`* * * * *`**.

## Step 7: Check
1. Open `https://digiteqdash.pages.dev/api/setup`. It should show `{"needsSetup":false}`.
2. The user signs in to the site.
   - As owner: open a client and upload a **logo**, then attach a **file** to a task. Both should work without "Missing FILES binding".
   - In **Team → Teams**, add people to Designing, Coding and Marketing.
   - Everyone adds their WhatsApp number in Settings for later. It's optional now.
3. After the next minute, the cron Worker's **Logs** should show a successful scheduled run. A 403 means `CRON_SECRET` differs between the Worker and the site.
4. Optional: add a custom domain, e.g. `dashboard.digiteqsolution.com`, under `digiteqdash` → **Custom domains**. If you do, update the Worker's `SITE_URL`.

## Step 8: Report
List:
- the R2 bucket and the `FILES` binding
- the variables added and removed (names only)
- the redeploy status
- the cron Worker's name, schedule and `SITE_URL`
- results of the checks
- anything left for the user (billing, custom domain)

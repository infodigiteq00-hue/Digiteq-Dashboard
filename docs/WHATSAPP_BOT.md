# WhatsApp bot — setup and how it works

## What it does
- **New task in a group.** When anyone (client, owner or employee) posts work in a watched group, the bot waits until they stop typing. It joins all their messages, photos, videos, documents, voice notes and links into one request, then **privately** asks every owner who has a WhatsApp number:
  > 🆕 *New task #12* in *Sunrise Team* (from Neha) … Reply *Priya* to assign · *12 Priya, Aman tomorrow* · *12 skip*

  The owner replies with names, and optionally a deadline (today, tomorrow, friday, 25/11, in 3 days, next week). The task is created on the dashboard for the group's client with all attachments. The people assigned get notified in the app and on WhatsApp.
- **"Done" from an employee**, in the group or in a private chat with the bot. The bot privately asks that employee to confirm:
  > Should I mark *Diwali post* (Sunrise Bakery) as *done*? Reply YES or NO

  On **YES** the task is completed, with any files they sent saved as finished work, and the owner is notified. If several tasks could match, the employee picks a number. If it isn't on the dashboard at all, the bot offers to **add it to their tasks and mark it done**. If the employee replies to the original group message, the bot matches that exact task.
- **Changes** ("change the background to blue", "update this…"). The bot finds the task it belongs to, including tasks finished in the last 30 days, and privately asks the owners:
  - *yes*: add the change to the task, reopen it if it was done, and tell the people assigned;
  - *new <name>*: make it a separate task;
  - *no*: ignore it.
- **Messages it ignores:** chatter ("ok", "thanks", 👍), private messages from strangers, and groups that aren't watched.
- **Several open questions.** If an owner has more than one question waiting, the bot asks them to start the reply with the number.
- **Where it posts:** the bot never posts in groups. All questions go privately.

## The pieces
```
WhatsApp ──► WAHA (Railway) ──webhook──► n8n (Railway) ──► Dashboard API /api/bot/inbound  (understands + replies via WAHA)
                                           └─ every minute ──► /api/bot/tick  (processes messages once people stop typing)
```
The bot's logic runs inside the dashboard, so it uses the same permissions, notifications and file storage as the app. n8n only forwards messages and runs the one-minute timer, so you can add your AI or other automations there later.

## 1. WAHA on Railway
1. Deploy the `devlikeapro/waha` Docker image (or `devlikeapro/waha-plus` if you have Plus). **Attach a volume** at `/app/.sessions` so the WhatsApp login survives restarts.
2. Set these variables:

| Variable | Value |
|---|---|
| `WAHA_API_KEY` | a long random string; the dashboard needs the same value |
| `WAHA_BASE_URL` | WAHA's public URL, e.g. `https://waha-production.up.railway.app`. Media links use it, so the dashboard must be able to reach it over HTTPS |
| `WHATSAPP_HOOK_URL` | the n8n webhook URL from step 2, e.g. `https://n8n-production.up.railway.app/webhook/waha` |
| `WHATSAPP_HOOK_EVENTS` | `message` |
| `WHATSAPP_DOWNLOAD_MEDIA` | `true` |

3. Open WAHA's dashboard, start the `default` session, and scan the QR code with the **bot's phone** (WhatsApp → Linked devices).
4. Add the bot's number to the client WhatsApp groups.

> Receiving media (photos, voice notes and other files) depends on your WAHA edition and engine. If a file can't be downloaded, the bot still asks, says "not downloadable (open WhatsApp)", and saves any text and links.

## 2. n8n on Railway
1. In n8n, go to **Workflows → Import from file** and choose `n8n/digiteq-whatsapp-bot.json`.
2. In both HTTP Request nodes, replace:
   - `https://REPLACE-WITH-YOUR-DASHBOARD.pages.dev` with your dashboard address;
   - `REPLACE-WITH-BOT_SECRET` with the `BOT_SECRET` from step 3.
3. **Activate** the workflow. The *WAHA events* webhook's production URL is `<n8n url>/webhook/waha`; put it in WAHA's `WHATSAPP_HOOK_URL`.

## 3. Dashboard (Cloudflare Pages → Settings → Variables and Secrets)
| Variable | Value |
|---|---|
| `WAHA_URL` | WAHA's public URL, e.g. `https://waha-production.up.railway.app` |
| `WAHA_API_KEY` | same as WAHA (**secret**) |
| `WAHA_SESSION` | `default` (optional) |
| `BOT_SECRET` | a long random string, the same one used in n8n (**secret**) |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` | optional, see below |

Redeploy after changing variables. Also make sure the R2 `FILES` binding is connected, or attachments can't be saved.

## 4. In the dashboard
1. **Everyone** adds their WhatsApp number (with country code) in **Settings**, or an owner adds it in **Team → edit**. The bot recognises people by number.
2. An **owner** opens **WhatsApp bot** (sidebar → Owner, or Settings on a phone):
   - enter each group's name exactly as it appears in WhatsApp, and pick its client;
   - groups the bot has already seen can be added with one tap;
   - choose how long to wait for more messages (1 minute by default).
3. Press **Send me a test message**.

## AI (optional — the bot works without it)
Without AI, built-in rules understand English and Hinglish task, done and change messages. For better understanding, set:
- **OpenAI or any OpenAI-compatible API** (Groq, OpenRouter, Together, Gemini's OpenAI endpoint, Ollama, LM Studio…): `AI_PROVIDER=openai`, `AI_API_KEY=…`, `AI_MODEL=<model>`, plus `AI_BASE_URL=<…/v1>` for providers other than OpenAI.
- **Anthropic:** `AI_PROVIDER=anthropic`, `AI_API_KEY=…`, `AI_MODEL=claude-haiku-5-5` (or another Claude model).

If the AI fails or times out, the bot falls back to the rules, so it keeps working.

## Testing locally
With a **fresh** local database, start the server:

```bash
npx wrangler pages dev public --d1 DB --r2 FILES --compatibility-date=2025-01-01 --port 8790 --persist-to /tmp/bot-test --binding WAHA_URL=http://127.0.0.1:3990 --binding BOT_SECRET=test-bot-key --binding WAHA_API_KEY=test-waha-key
```

Then run the test in another terminal:

```bash
TEST_URL=http://localhost:8790 npm run test:bot
```

The test runs a fake WAHA and plays through 31 conversations: multi-message tasks with a photo and a link, assigning, skipping, ambiguous replies, done with reply-to and files, changes to finished tasks, work that isn't on the dashboard yet, voice notes, duplicate deliveries, strangers and unwatched groups.

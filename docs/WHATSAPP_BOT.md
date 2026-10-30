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

## 1. WAHA on Railway (reuse the existing one)
Digiteq already runs WAHA at **https://waha-production-74bf.up.railway.app**, in the Railway account of infodigiteq00@gmail.com. Quotegen uses its **`default`** session, which is Quotegen's number. The bot uses a **different WhatsApp number**, so it gets **its own session** on the same WAHA. Nothing changes for Quotegen: the bot ignores every event that isn't from its own session.

1. **Check your WAHA edition.** In the WAHA dashboard (`<waha url>/dashboard`, using the API key from Railway → WAHA service → Variables), see whether it says *Plus* or *Core*.
   - **WAHA Plus** can run several numbers. Continue with step 2.
   - **WAHA Core** allows **one session only** (the one Quotegen already uses). Either upgrade to Plus, or add a second WAHA service in the same Railway project for the bot. That second WAHA uses its own volume and has its own URL, which then goes in `WAHA_URL`.
2. **Create a session named `digiteq`** with its own webhook. Use the WAHA dashboard, or `POST /api/sessions` with the body below. A per-session webhook only sends the bot's messages to n8n, unlike the global `WHATSAPP_HOOK_URL`.

```json
{ "name": "digiteq", "start": true,
  "config": { "webhooks": [ { "url": "https://<your n8n>/webhook/waha", "events": ["message"] } ] } }
```

3. **Scan the QR code** for session `digiteq` with the **bot's phone**, the new number (WhatsApp → Linked devices).
4. **Add the bot's number** to the client WhatsApp groups.
5. **Photo and file links:** WAHA's media links point at `http://localhost:3000/...`. The bot rewrites them to `WAHA_URL` automatically. When a message has media but no link, it fetches the media with `downloadMedia=true`. You don't have to do anything.

If you ever set WAHA up from scratch, also attach a volume at `/app/.sessions` so logins survive restarts.

## 2. n8n on Railway (reuse your existing n8n)
1. In your existing n8n, go to **Workflows → Import from file** and choose `n8n/digiteq-whatsapp-bot.json`. Its webhook path is `waha`, which doesn't clash with Quotegen's paths.
2. In both HTTP Request nodes, replace:
   - `https://REPLACE-WITH-YOUR-DASHBOARD.pages.dev` with your dashboard address;
   - `REPLACE-WITH-BOT_SECRET` with the `BOT_SECRET` from step 3.
3. **Activate** the workflow. The *WAHA events* webhook's production URL is `<n8n url>/webhook/waha`; put it in WAHA's `WHATSAPP_HOOK_URL`.

## 3. Dashboard (Cloudflare Pages → Settings → Variables and Secrets)
| Variable | Value |
|---|---|
| `WAHA_URL` | `https://waha-production-74bf.up.railway.app`, or your second WAHA's URL if you use one |
| `WAHA_API_KEY` | WAHA's API key, from Railway → WAHA → Variables (**secret**) |
| `WAHA_SESSION` | **`digiteq`**, the bot's own session/number. Don't use `default`, which is Quotegen's number |
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

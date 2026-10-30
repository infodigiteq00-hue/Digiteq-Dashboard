// WhatsApp bot (via WAHA → n8n → this API).
//  • Watches the WhatsApp groups named in Settings. Messages from the same person are grouped (they often type a task in
//    several messages + photos/voice notes), then understood as: new task / "done" report / change request / chat.
//  • New task → the owners get a PRIVATE message: "who should do it?" → they reply with names (+ optional deadline) → task created.
//  • "Done" from an employee → the employee gets a PRIVATE message: "mark <task> as done?" → YES → completed
//    (if the task isn't on the dashboard yet, it is added to their tasks and marked done).
//  • Change request → owners are asked privately to add it to the existing task (assignees are notified).
//  • Links, images, videos, documents and voice notes are saved to the task.
import { createAI, rankTasks, shortTitle } from './ai.js';

export const BOT_SCHEMA = `;
CREATE TABLE IF NOT EXISTS bot_groups (
  id TEXT PRIMARY KEY, name TEXT, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS bot_buffer (
  id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, sender TEXT NOT NULL, sender_name TEXT,
  messages TEXT NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL, UNIQUE (chat_id, sender)
);
CREATE TABLE IF NOT EXISTS bot_items (
  id INTEGER PRIMARY KEY, batch TEXT, kind TEXT NOT NULL CHECK (kind IN ('task','done','change')),
  status TEXT NOT NULL DEFAULT 'pending', ask_to TEXT NOT NULL, ask_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT, group_name TEXT, client_id INTEGER, sender TEXT, sender_name TEXT, title TEXT, text TEXT,
  materials TEXT, message_ids TEXT, candidates TEXT, task_id INTEGER, result TEXT, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS bot_items_ask ON bot_items(ask_to, status);
CREATE TABLE IF NOT EXISTS bot_seen (id TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bot_task_messages (
  message_id TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
)`;

const YES_RX = /^(y|ya|yes|yeah|yep|yup|ha+n?|haa+|ji|ji haan|ok|okay|okk|sure|confirm|confirmed|correct|right|done|kar do|krdo|👍|✅|✔️)\b/i;
const NO_RX = /^(n|no|nope|nah|nahi|nahin|na|cancel|skip|ignore|leave it|rehne do|❌)\b/i;
const digits = (s) => String(s || '').replace(/@.*/, '').replace(/\D/g, '');
const samePhone = (a, b) => { const x = digits(a), y = digits(b); return x.length >= 8 && y.length >= 8 && x.slice(-10) === y.slice(-10); };
const linksIn = (text) => [...new Set(String(text || '').match(/https?:\/\/[^\s<>"')\]]+/g) || [])];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
// Join message lines: false/null/undefined are dropped, '' becomes one blank line (never doubled or at the ends).
const lines = (...parts) => parts.flat().filter((l) => l !== false && l !== null && l !== undefined)
  .filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '' && i < a.length - 1)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function registerBot(h) {
  const { route, all, get, run, DB, fail, files, str, now, env, isOwner, notify, internal, localParts, TIMEZONE } = h;
  const ai = createAI(env);
  const outbox = []; // messages sent during this request (returned to n8n for logging / tests)

  // ---------------------------------------------------------------- WAHA client
  const wahaBase = () => String(env.WAHA_URL || '').replace(/\/$/, '');
  // The bot's own WhatsApp number = its own WAHA session. Events from other sessions on the same WAHA
  // (e.g. another bot using "default") are ignored, and replies always go out from this session.
  const session = () => env.WAHA_SESSION || 'default';
  const wahaFetch = (path, opts = {}) => fetch(path.startsWith('http') ? path : `${wahaBase()}${path}`, {
    ...opts, headers: { 'Content-Type': 'application/json', ...(env.WAHA_API_KEY ? { 'X-Api-Key': env.WAHA_API_KEY } : {}), ...(opts.headers || {}) },
  });
  async function send(chatId, text) {
    outbox.push({ chatId, text });
    if (!wahaBase()) return;
    try {
      const res = await wahaFetch('/api/sendText', { method: 'POST', body: JSON.stringify({ session: session(), chatId, text }) });
      if (!res.ok) console.error('WAHA sendText failed', res.status, await res.text().catch(() => ''));
    } catch (err) { console.error('WAHA sendText error', err?.message); }
  }
  const dm = (phoneOrId) => (String(phoneOrId).includes('@') ? String(phoneOrId) : `${digits(phoneOrId)}@c.us`);
  async function groupName(id) {
    const cached = await get('SELECT name FROM bot_groups WHERE id = ?', id);
    if (cached?.name) { await run('UPDATE bot_groups SET last_seen = ? WHERE id = ?', now(), id); return cached.name; }
    let name = '';
    if (wahaBase()) {
      try {
        const res = await wahaFetch(`/api/${session()}/groups/${encodeURIComponent(id)}`);
        if (res.ok) { const g = await res.json(); name = g.subject || g.name || g.groupMetadata?.subject || g.metadata?.subject || ''; }
      } catch { /* name stays unknown */ }
    }
    await run('INSERT INTO bot_groups (id, name, last_seen) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name = COALESCE(NULLIF(excluded.name, \'\'), bot_groups.name), last_seen = excluded.last_seen', id, name, now());
    return name;
  }
  // Newer WhatsApp accounts appear as "...@lid" in groups; WAHA can map that to the phone number.
  async function phoneId(id) {
    if (!String(id).endsWith('@lid') || !wahaBase()) return id;
    try {
      const res = await wahaFetch(`/api/${session()}/lids/${encodeURIComponent(id)}`);
      if (res.ok) { const j = await res.json(); return j.pn || j.phoneNumber || id; }
    } catch { /* keep lid */ }
    return id;
  }

  // ---------------------------------------------------------------- settings
  async function config() {
    const row = await get("SELECT value FROM meta WHERE key = 'bot_config'");
    const c = row ? JSON.parse(row.value) : {};
    return { enabled: c.enabled !== false, buffer_seconds: Math.max(15, Math.min(600, Number(c.buffer_seconds) || 60)), groups: Array.isArray(c.groups) ? c.groups : [] };
  }
  async function watched(groupId, name) {
    const c = await config();
    if (!c.enabled) return null;
    const lower = String(name || '').trim().toLowerCase();
    return c.groups.find((g) => g.id === groupId || (lower && String(g.name || '').trim().toLowerCase() === lower)) || null;
  }
  async function people() {
    return all("SELECT id, name, username, role, is_owner, phone, must_change_password FROM users ORDER BY name");
  }
  const findPerson = (list, waId) => list.find((u) => u.phone && samePhone(u.phone, waId)) || null;
  const firstName = (n) => String(n || '').split(' ')[0];

  // ---------------------------------------------------------------- attachments → R2 materials
  // WAHA often reports media links as http://localhost:3000/... (its internal address): point them at the public WAHA_URL.
  const publicMediaUrl = (u) => {
    if (!u) return null;
    if (!/^https?:\/\//.test(u)) return `${wahaBase()}${u.startsWith('/') ? '' : '/'}${u}`;
    return wahaBase() ? u.replace(/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|waha)(:\d+)?/i, wahaBase()) : u;
  };
  // Media with no link in the webhook: ask WAHA for the message with downloadMedia=true.
  async function mediaLink(media) {
    if (media.url || !media.messageId || !wahaBase()) return media.url;
    try {
      const res = await wahaFetch(`/api/${session()}/chats/${encodeURIComponent(media.chatId)}/messages/${encodeURIComponent(media.messageId)}?downloadMedia=true`);
      if (res.ok) { const j = await res.json(); return j.media?.url || null; }
    } catch { /* not downloadable */ }
    return null;
  }
  async function saveMedia(media) {
    if (!media || !env.FILES) return null;
    try {
      const link = await mediaLink(media);
      if (!link) return null;
      const url = publicMediaUrl(link);
      const res = await fetch(url, { headers: env.WAHA_API_KEY ? { 'X-Api-Key': env.WAHA_API_KEY } : {} });
      if (!res.ok) return null;
      const key = `files/${crypto.randomUUID()}`;
      const type = media.mimetype || res.headers.get('content-type') || 'application/octet-stream';
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > 25 * 1024 * 1024) return null;
      await env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
      const ext = ({ 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'image/jpeg': 'jpg', 'video/mp4': 'mp4', 'application/pdf': 'pdf' })[type.split(';')[0]] || (type.split('/')[1] || 'bin').split(';')[0];
      const kind = type.startsWith('image/') ? 'Image' : type.startsWith('video/') ? 'Video' : type.startsWith('audio/') ? 'Voice note' : 'Document';
      const name = media.filename || `${kind} from WhatsApp.${ext}`;
      return { kind: 'file', key, name, type, title: media.filename || `${kind} from WhatsApp` };
    } catch (err) {
      console.error('media download failed', err?.message);
      return null;
    }
  }
  async function collect(msgs) {
    const text = msgs.map((m) => m.text).filter(Boolean).join('\n').trim();
    const materials = linksIn(text).map((url) => ({ kind: 'link', url, title: url }));
    const mediaTypes = [];
    let missing = 0;
    for (const m of msgs) {
      if (!m.media) continue;
      const type = m.media.mimetype || '';
      mediaTypes.push(type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'voice note' : 'document');
      const saved = await saveMedia(m.media);
      if (saved) materials.push(saved); else missing++;
    }
    return { text, materials, mediaTypes, missing };
  }
  const attachLine = (materials, missing = 0) => {
    const files = materials.filter((m) => m.kind === 'file').length, links = materials.filter((m) => m.kind === 'link').length;
    const parts = [files ? plural(files, 'file') : '', links ? plural(links, 'link') : '', missing ? `${missing} not downloadable (open WhatsApp)` : ''].filter(Boolean);
    return parts.length ? `📎 ${parts.join(' · ')}` : '';
  };

  // ---------------------------------------------------------------- deadline words in owner replies ("tomorrow", "friday", "25/11", "in 3 days")
  function localToIso(y, m, d, hour = 18) {
    const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
    const p = localParts(TIMEZONE, new Date(guess));
    const asLocal = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, 0);
    return new Date(guess - (asLocal - guess)).toISOString();
  }
  function parseDeadline(text) {
    const t = ` ${String(text || '').toLowerCase()} `;
    const p = localParts(TIMEZONE);
    const today = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
    const at = (date) => localToIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    const plus = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + n); return d; };
    let m;
    if (/\b(today|tonight|aaj)\b/.test(t)) return at(today);
    if (/\b(tomorrow|tmrw|tmr|kal)\b/.test(t)) return at(plus(1));
    if ((m = t.match(/\bin (\d{1,2}) days?\b/))) return at(plus(+m[1]));
    if (/\bnext week\b/.test(t)) return at(plus(7));
    if ((m = t.match(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/))) {
      let y = m[3] ? +m[3] : today.getUTCFullYear(); if (y < 100) y += 2000;
      const d = new Date(Date.UTC(y, +m[2] - 1, +m[1]));
      if (!m[3] && d < today) d.setUTCFullYear(y + 1);
      if (!Number.isNaN(d.getTime())) return at(d);
    }
    for (let i = 0; i < 7; i++) if (new RegExp(`\\b${WEEKDAYS[i]}\\b|\\b${WEEKDAYS[i].slice(0, 3)}\\b`).test(t)) {
      return at(plus(((i - today.getUTCDay() + 7) % 7) || 7));
    }
    return null;
  }
  const fmtDue = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: TIMEZONE, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
  function matchNames(text, team) {
    let t = ` ${String(text || '').toLowerCase().replace(/[,&+/]|\band\b|\baur\b/g, ' ')} `;
    const found = [];
    const variants = team.flatMap((u) => [u.name, u.username, firstName(u.name)].filter((v) => v && v.length >= 2).map((v) => ({ u, v: v.toLowerCase() })))
      .sort((a, b) => b.v.length - a.v.length);
    for (const { u, v } of variants) {
      const rx = new RegExp(`\\s${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`);
      if (rx.test(t)) { if (!found.includes(u)) found.push(u); t = t.replace(rx, ' '); }
    }
    // Ambiguous first names (two "Priya"s) → require the full name.
    const ambiguous = found.filter((u) => team.filter((x) => firstName(x.name).toLowerCase() === firstName(u.name).toLowerCase()).length > 1
      && !String(text).toLowerCase().includes(u.name.toLowerCase()));
    return { users: found.filter((u) => !ambiguous.includes(u)), ambiguous };
  }

  // ---------------------------------------------------------------- items (questions the bot is waiting on)
  async function newItem(fields) {
    const cols = Object.keys(fields);
    const r = await run(`INSERT INTO bot_items (${cols.join(',')}, created_at) VALUES (${cols.map(() => '?').join(',')}, ?)`, ...cols.map((k) => fields[k]), now());
    return r.meta.last_row_id;
  }
  const resolveItem = (id, status, result = '', taskId = null) => run('UPDATE bot_items SET status = ?, result = ?, task_id = COALESCE(?, task_id), resolved_at = ? WHERE id = ?', status, result, taskId, now(), id);
  const pendingFor = (waId) => all("SELECT * FROM bot_items WHERE status = 'pending' AND (ask_to = ? OR ask_to LIKE ?) ORDER BY id", waId, `%${digits(waId).slice(-10)}@%`);
  const parse = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };
  const linkMessages = async (ids, taskId) => { for (const m of ids || []) await run('INSERT OR IGNORE INTO bot_task_messages (message_id, task_id) VALUES (?,?)', m, taskId); };

  // Open tasks (or, with recentDone, also tasks finished in the last 30 days — change requests often come after delivery).
  async function openTasksFor({ clientId = null, userId = null, recentDone = false } = {}) {
    const where = [recentDone ? "(t.status != 'done' OR t.completed_at >= ?)" : "t.status != 'done'"], p = recentDone ? [new Date(Date.now() - 30 * 86400000).toISOString()] : [];
    if (clientId) { where.push('t.client_id = ?'); p.push(clientId); }
    if (userId) { where.push('t.id IN (SELECT task_id FROM task_assignees WHERE user_id = ?)'); p.push(userId); }
    const rows = await all(`SELECT t.id, t.title, t.status, t.client_id, c.name AS client_name FROM tasks t LEFT JOIN clients c ON c.id = t.client_id
      WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT 60`, ...p);
    const assignees = rows.length ? await all(`SELECT ta.task_id, u.id, u.name FROM task_assignees ta JOIN users u ON u.id = ta.user_id
      WHERE ta.task_id IN (SELECT value FROM json_each(?))`, JSON.stringify(rows.map((r) => r.id))) : [];
    return rows.map((r) => ({ ...r, assignees: assignees.filter((a) => a.task_id === r.id).map((a) => a.name) }));
  }

  // ---------------------------------------------------------------- flows
  async function askOwnersAboutTask({ group, sender, senderName, title, details, materials, missing, messageIds, clientId }) {
    const team = (await people()).filter((u) => !u.must_change_password);
    const owners = team.filter((u) => u.is_owner && u.phone);
    const assignable = team.filter((u) => u.role === 'employee' || u.role === 'superadmin');
    const fullText = details || title;
    if (!owners.length) {
      await notify((await people()).filter((u) => u.is_owner).map((u) => u.id), {
        type: 'bot', title: `WhatsApp task waiting in ${group.name || 'a group'}`,
        body: `${shortTitle(fullText)} — add your WhatsApp number in Settings so the bot can ask you who should do it.`, url: '/#/settings',
      });
      return;
    }
    const batch = crypto.randomUUID();
    for (const o of owners) {
      const id = await newItem({
        batch, kind: 'task', ask_to: dm(o.phone), ask_user_id: o.id, chat_id: group.id, group_name: group.name, client_id: clientId,
        sender, sender_name: senderName, title, text: fullText, materials: JSON.stringify(materials), message_ids: JSON.stringify(messageIds),
      });
      const pending = (await pendingFor(dm(o.phone))).length;
      const example = firstName(assignable.find((u) => u.role === 'employee')?.name || assignable[0]?.name || 'Priya');
      await send(dm(o.phone), lines(
        `🆕 *New task #${id}* in *${group.name || 'WhatsApp group'}*${senderName ? ` (from ${senderName})` : ''}`,
        '', `*${title}*`, details && details !== title ? (details.length > 600 ? `${details.slice(0, 600)}…` : details) : null,
        attachLine(materials, missing) || null,
        '', `👥 Team: ${assignable.map((u) => firstName(u.name)).join(', ') || '—'}`,
        `Reply *${pending > 1 ? `${id} ` : ''}${example}* to assign (or *${id} ${example}, tomorrow*) · *${id} skip* to ignore.`,
      ));
    }
  }

  async function askOwnersAboutChange({ group, sender, senderName, task, text, materials, missing, messageIds, clientId }) {
    const owners = (await people()).filter((u) => u.is_owner && u.phone && !u.must_change_password);
    if (!owners.length) return askOwnersAboutTask({ group, sender, senderName, title: shortTitle(text), details: text, materials, missing, messageIds, clientId });
    const batch = crypto.randomUUID();
    for (const o of owners) {
      const id = await newItem({
        batch, kind: 'change', ask_to: dm(o.phone), ask_user_id: o.id, chat_id: group.id, group_name: group.name, client_id: clientId,
        sender, sender_name: senderName, title: task.title, text, task_id: task.id, materials: JSON.stringify(materials), message_ids: JSON.stringify(messageIds),
      });
      await send(dm(o.phone), lines(
        `✏️ *Change request #${id}* in *${group.name || 'WhatsApp group'}*${senderName ? ` (from ${senderName})` : ''}`,
        `For task: *${task.title}*${task.assignees?.length ? ` → ${task.assignees.join(', ')}` : ''}${task.status === 'done' ? ' (already done — it will be reopened)' : ''}`,
        '', `“${text.length > 600 ? `${text.slice(0, 600)}…` : text}”`, attachLine(materials, missing) || null, '',
        `Reply *${id} yes* to add it to this task and tell the team · *${id} new <name>* to make it a separate task · *${id} no* to ignore.`,
      ));
    }
  }

  async function askEmployeeAboutDone({ person, waId, text, title, materials, missing, messageIds, clientId, replyTaskId, aiTaskId }) {
    const mine = await openTasksFor({ userId: person.id });
    let candidates;
    const exact = mine.find((t) => t.id === replyTaskId) || mine.find((t) => t.id === aiTaskId);
    if (exact) candidates = [exact];
    else {
      const ranked = rankTasks(text, mine).map((t) => ({ ...t, score: t.score + (clientId && t.client_id === clientId ? 1 : 0) }))
        .sort((a, b) => b.score - a.score);
      candidates = ranked.length && (ranked.length === 1 || ranked[0].score >= ranked[1].score * 2) ? [ranked[0]] : ranked.slice(0, 3);
      if (!candidates.length && clientId) {
        const sameClient = mine.filter((t) => t.client_id === clientId);
        if (sameClient.length === 1) candidates = sameClient;
      }
    }
    const id = await newItem({
      kind: 'done', ask_to: waId, ask_user_id: person.id, client_id: clientId, sender: waId, sender_name: person.name,
      title: title || shortTitle(text) || 'Work finished', text, materials: JSON.stringify(materials), message_ids: JSON.stringify(messageIds),
      candidates: JSON.stringify(candidates.map((t) => ({ id: t.id, title: t.title, client_name: t.client_name }))),
      task_id: candidates.length === 1 ? candidates[0].id : null,
    });
    const files = attachLine(materials, missing);
    const hi = `Hi ${firstName(person.name)} 👋`;
    if (candidates.length === 1) {
      const t = candidates[0];
      await send(waId, lines(hi, `Should I mark *${t.title}*${t.client_name ? ` (${t.client_name})` : ''} as *done*?`, files ? `${files} will be attached as your finished work.` : null,
        `Reply *YES* or *NO*.${(await pendingFor(waId)).length > 1 ? ` (or *${id} yes*)` : ''}`));
    } else if (candidates.length > 1) {
      await send(waId, lines(hi, 'Which task did you finish?', candidates.map((t, i) => `*${i + 1}.* ${t.title}${t.client_name ? ` (${t.client_name})` : ''}`),
        `*0.* None of these — add “${shortTitle(title || text, 60)}” as a new task and mark it done`, files || null, '', 'Reply with the number, or *NO* to cancel.'));
    } else {
      await send(waId, lines(hi, 'I couldn’t find this in your tasks on the dashboard:', `*${shortTitle(title || text)}*`, files || null,
        '', 'Reply *YES* to add it to your tasks and mark it done, or *NO* to cancel.'));
    }
  }

  // ---------------------------------------------------------------- replies to the bot's private questions
  async function handleReply(person, waId, text) {
    const pending = await pendingFor(waId);
    if (!pending.length) return false;
    const clean = String(text || '').trim();
    let item = null, rest = clean;
    const m = clean.match(/^#?(\d{1,6})\b[\s,:.-]*([\s\S]*)$/);
    if (m && pending.some((p) => p.id === Number(m[1]))) { item = pending.find((p) => p.id === Number(m[1])); rest = m[2].trim(); }
    else if (pending.length === 1) item = pending[0];
    else {
      // Several questions open: a plain YES/NO or name only works if it is clear which one is meant.
      const doneItems = pending.filter((p) => p.kind === 'done');
      if (doneItems.length === 1 && (YES_RX.test(clean) || NO_RX.test(clean) || /^\d$/.test(clean))) item = doneItems[0];
      else {
        await send(waId, lines('I have a few questions open — please start your reply with the number:',
          pending.slice(-6).map((p) => `*#${p.id}* ${p.kind === 'task' ? '🆕' : p.kind === 'change' ? '✏️' : '✅'} ${shortTitle(p.title || p.text, 60)}`),
          `Example: *${pending[pending.length - 1].id} ${pending[pending.length - 1].kind === 'task' ? '<name>' : 'yes'}*`));
        return true;
      }
    }
    if (item.kind === 'task') await replyTask(person, waId, item, rest);
    else if (item.kind === 'change') await replyChange(person, waId, item, rest);
    else await replyDone(person, waId, item, rest);
    return true;
  }

  async function ownerUser(person) {
    const u = await get('SELECT * FROM users WHERE id = ?', person.id);
    if (!u || !isOwner(u)) fail(403, 'not an owner');
    return u;
  }
  async function closeSiblings(item, byName, summary) {
    if (!item.batch) return;
    const others = await all("SELECT * FROM bot_items WHERE batch = ? AND id != ? AND status = 'pending'", item.batch, item.id);
    for (const o of others) {
      await resolveItem(o.id, 'handled', `by ${byName}`);
      await send(o.ask_to, `ℹ️ #${o.id} was handled by ${byName}: ${summary}`);
    }
  }
  async function createAssignedTask(owner, item, rest) {
    const team = (await people()).filter((u) => u.role === 'employee' || u.role === 'superadmin');
    const { users, ambiguous } = matchNames(rest, team);
    if (ambiguous.length) {
      await send(item.ask_to, `More than one person is called ${ambiguous.map((u) => firstName(u.name)).join(', ')}. Please use the full name, e.g. *${item.id} ${ambiguous[0].name}*.`);
      return null;
    }
    if (!users.length) {
      await send(item.ask_to, `Who should do *${item.title}*? Reply *${item.id} <name>* — team: ${team.map((u) => firstName(u.name)).join(', ')}. Or *${item.id} skip*.`);
      return null;
    }
    const deadline = parseDeadline(rest);
    const source = `\n\n— From WhatsApp group “${item.group_name || 'group'}”${item.sender_name ? `, sent by ${item.sender_name}` : ''}`;
    const task = await internal('POST', '/api/tasks', owner, {
      title: item.title || shortTitle(item.text), description: `${item.text || ''}${source}`.trim(), client_id: item.client_id,
      deadline, priority: /urgent|asap|jaldi|immediately/i.test(`${item.text} ${rest}`) ? 'urgent' : 'normal',
      assignees: users.map((u) => u.id), materials: parse(item.materials, []),
    });
    await linkMessages(parse(item.message_ids, []), task.id);
    // Tell the assignees on WhatsApp too (the dashboard already notifies them in the app).
    for (const u of users) {
      const full = await get('SELECT phone FROM users WHERE id = ?', u.id);
      if (full?.phone && u.id !== owner.id) {
        await send(dm(full.phone), lines(`📌 *New task for you* from ${firstName(owner.name)}`, `*${task.title}*${task.client_name ? ` (${task.client_name})` : ''}`,
          deadline ? `⏰ Due ${fmtDue(deadline)}` : null, attachLine(parse(item.materials, [])) || null, 'When it’s finished, just say “done” in the group or here.'));
      }
    }
    return { task, users, deadline };
  }
  async function replyTask(person, waId, item, rest) {
    const owner = await ownerUser(person);
    if (NO_RX.test(rest)) { await resolveItem(item.id, 'skipped'); await send(waId, `👍 Ignored #${item.id}.`); await closeSiblings(item, firstName(owner.name), 'ignored'); return; }
    const made = await createAssignedTask(owner, item, rest);
    if (!made) return;
    await resolveItem(item.id, 'done', 'created', made.task.id);
    const who = made.users.map((u) => firstName(u.name)).join(', ');
    await send(waId, `✅ Added *${made.task.title}* → ${who}${made.deadline ? `, due ${fmtDue(made.deadline)}` : ''}. They’ve been notified.`);
    await closeSiblings(item, firstName(owner.name), `assigned to ${who}`);
  }
  async function replyChange(person, waId, item, rest) {
    const owner = await ownerUser(person);
    if (NO_RX.test(rest)) { await resolveItem(item.id, 'skipped'); await send(waId, `👍 Ignored change #${item.id}.`); await closeSiblings(item, firstName(owner.name), 'ignored'); return; }
    if (/^new\b/i.test(rest)) {
      const made = await createAssignedTask(owner, { ...item, title: shortTitle(item.text) }, rest.replace(/^new\b/i, ''));
      if (!made) return;
      await resolveItem(item.id, 'done', 'new task', made.task.id);
      await send(waId, `✅ Made it a new task: *${made.task.title}* → ${made.users.map((u) => firstName(u.name)).join(', ')}.`);
      await closeSiblings(item, firstName(owner.name), 'made a new task');
      return;
    }
    if (!YES_RX.test(rest)) { await send(waId, `Reply *${item.id} yes* to add the change to *${item.title}*, *${item.id} new <name>* for a separate task, or *${item.id} no*.`); return; }
    let task;
    try { task = await internal('GET', `/api/tasks/${item.task_id}`, owner); } catch { task = null; }
    if (!task) { await resolveItem(item.id, 'skipped', 'task gone'); await send(waId, 'That task no longer exists.'); return; }
    const stamp = new Date().toLocaleString('en-IN', { timeZone: TIMEZONE, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const note = `\n\n🔁 Change (${stamp}${item.sender_name ? `, from ${item.sender_name}` : ''}):\n${item.text}`;
    const updated = await internal('PATCH', `/api/tasks/${task.id}`, owner, {
      description: `${task.description || ''}${note}`.trim(), assignees: task.assignees.map((a) => a.id), materials: parse(item.materials, []),
    });
    if (task.status === 'done') await internal('POST', `/api/tasks/${task.id}/status`, owner, { status: 'todo' }); // reopen for the change
    await linkMessages(parse(item.message_ids, []), task.id);
    for (const a of updated.assignees) {
      const full = await get('SELECT phone FROM users WHERE id = ?', a.id);
      if (full?.phone && a.id !== owner.id) await send(dm(full.phone), `🔁 *Change for your task* “${updated.title}”:\n${item.text}${task.status === 'done' ? '\n(The task was reopened.)' : ''}`);
    }
    await resolveItem(item.id, 'done', 'applied', task.id);
    await send(waId, `✅ Change added to *${updated.title}*${updated.assignees.length ? ` and ${updated.assignees.map((a) => firstName(a.name)).join(', ')} notified` : ''}.`);
    await closeSiblings(item, firstName(owner.name), 'change added');
  }
  async function replyDone(person, waId, item, rest) {
    const user = await get('SELECT * FROM users WHERE id = ?', person.id);
    const candidates = parse(item.candidates, []);
    if (NO_RX.test(rest)) { await resolveItem(item.id, 'skipped'); await send(waId, '👍 Okay, nothing changed.'); return; }
    let taskId = null, createNew = false;
    const num = rest.match(/^(\d)\b/);
    if (candidates.length > 1) {
      if (!num) { await send(waId, `Please reply with the number (1–${candidates.length}), *0* for a new task, or *NO*.`); return; }
      if (+num[1] === 0) createNew = true; else if (candidates[+num[1] - 1]) taskId = candidates[+num[1] - 1].id;
      else { await send(waId, `Please reply with a number from 1 to ${candidates.length}.`); return; }
    } else if (YES_RX.test(rest) || (num && +num[1] === 1)) {
      if (candidates.length === 1) taskId = candidates[0].id; else createNew = true;
    } else { await send(waId, 'Please reply *YES* or *NO*.'); return; }
    let task;
    if (createNew) {
      task = await internal('POST', '/api/tasks', user, { title: item.title || shortTitle(item.text), description: `${item.text}\n\n— Added from WhatsApp`, client_id: item.client_id });
      taskId = task.id;
    } else {
      task = await internal('GET', `/api/tasks/${taskId}`, user).catch(() => null);
      if (!task) { await resolveItem(item.id, 'skipped', 'task gone'); await send(waId, 'That task no longer exists.'); return; }
      if (task.status === 'done') { await resolveItem(item.id, 'done', 'already done', taskId); await send(waId, `*${task.title}* is already marked done ✅`); return; }
    }
    const done = await internal('POST', `/api/tasks/${taskId}/complete`, user, { note: `Marked done via WhatsApp: ${item.text}`.slice(0, 2000), materials: parse(item.materials, []) });
    await linkMessages(parse(item.message_ids, []), taskId);
    await resolveItem(item.id, 'done', createNew ? 'created+completed' : 'completed', taskId);
    await send(waId, `✅ *${done.title}* is marked done${createNew ? ' (added to your tasks)' : ''}. Your admin has been notified. Great work!`);
  }

  // ---------------------------------------------------------------- incoming messages
  function normalize(ev) {
    const e = ev?.body?.event ? ev.body : ev;
    if (!e || !['message', 'message.any'].includes(e.event)) return null;
    if (e.session && e.session !== session()) return null; // another number on the same WAHA
    const p = e.payload || {};
    if (p.fromMe) return null;
    const from = String(p.from || '');
    const isGroup = from.endsWith('@g.us');
    const id = String(p.id?._serialized || p.id || `${from}-${p.timestamp}`);
    const media = p.hasMedia || p.media ? {
      url: p.media?.url || null, mimetype: p.media?.mimetype || p._data?.mimetype || '', filename: p.media?.filename || null,
      messageId: id, chatId: from,
    } : null;
    return {
      id, isGroup, chatId: from,
      sender: isGroup ? String(p.participant || p.author || p._data?.author || '') : from,
      senderName: p._data?.notifyName || p._data?.pushName || p.notifyName || p.pushName || '',
      text: String(p.body || p.caption || '').trim(), media,
      replyTo: p.replyTo?.id || p._data?.quotedStanzaID || null,
    };
  }
  async function inbound(ev) {
    const msg = normalize(ev);
    if (!msg || !msg.sender) return;
    const seen = await run('INSERT OR IGNORE INTO bot_seen (id, at) VALUES (?,?)', msg.id, now());
    if (!seen.meta.changes) return; // duplicate delivery
    msg.sender = await phoneId(msg.sender);
    const team = await people();
    const person = findPerson(team, msg.sender);
    if (!msg.isGroup) {
      if (!person) return; // strangers' private messages are ignored
      if (await handleReply(person, msg.sender, msg.text)) return;
      if (person.role === 'employee' || person.role === 'superadmin') {
        const analysis = await ai.analyze({ text: msg.text, hasMedia: !!msg.media, sender: { name: person.name, isEmployee: true }, openTasks: [], myTasks: await openTasksFor({ userId: person.id }) });
        if (analysis.kind === 'done') {
          const { materials, missing } = await collect([msg]);
          await askEmployeeAboutDone({ person, waId: msg.sender, text: msg.text, title: analysis.title, materials, missing, messageIds: [msg.id], aiTaskId: analysis.task_id });
          return;
        }
      }
      if (person.is_owner) await send(msg.sender, '👋 I’m the Digiteq bot. I’ll message you here when a task comes in from your WhatsApp groups. Nothing is waiting for you right now.');
      return;
    }
    const name = await groupName(msg.chatId);
    const watch = await watched(msg.chatId, name);
    if (!watch) return;
    const entry = { id: msg.id, text: msg.text, media: msg.media, replyTo: msg.replyTo, at: now() };
    const upd = await run('UPDATE bot_buffer SET messages = json_insert(messages, \'$[#]\', json(?)), last_at = ?, sender_name = COALESCE(NULLIF(?, \'\'), sender_name) WHERE chat_id = ? AND sender = ?',
      JSON.stringify(entry), now(), msg.senderName, msg.chatId, msg.sender);
    if (!upd.meta.changes) {
      await run('INSERT OR IGNORE INTO bot_buffer (chat_id, sender, sender_name, messages, first_at, last_at) VALUES (?,?,?,?,?,?)',
        msg.chatId, msg.sender, msg.senderName || person?.name || '', JSON.stringify([entry]), now(), now());
    }
  }

  // Grouped messages are processed after the sender has been quiet for buffer_seconds (or after 5 minutes at most).
  async function flush(force = false) {
    const c = await config();
    const quiet = new Date(Date.now() - c.buffer_seconds * 1000).toISOString();
    const oldest = new Date(Date.now() - 5 * 60000).toISOString();
    const due = force ? await all('SELECT id FROM bot_buffer') : await all('SELECT id FROM bot_buffer WHERE last_at <= ? OR first_at <= ?', quiet, oldest);
    let processed = 0;
    for (const { id } of due) {
      const buf = (await DB.prepare('DELETE FROM bot_buffer WHERE id = ? RETURNING *').bind(id).all()).results[0];
      if (!buf) continue; // another request took it
      try { await processBuffer(buf); processed++; } catch (err) { console.error('bot buffer failed', err); }
    }
    await run("UPDATE bot_items SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND created_at < ?", now(), new Date(Date.now() - 7 * 86400000).toISOString());
    await run('DELETE FROM bot_seen WHERE at < ?', new Date(Date.now() - 3 * 86400000).toISOString());
    return processed;
  }
  async function processBuffer(buf) {
    const msgs = parse(buf.messages, []);
    const team = await people();
    const person = findPerson(team, buf.sender);
    const group = { id: buf.chat_id, name: (await get('SELECT name FROM bot_groups WHERE id = ?', buf.chat_id))?.name || '' };
    const c = await config();
    const watch = c.groups.find((g) => g.id === group.id || String(g.name || '').trim().toLowerCase() === String(group.name || '').trim().toLowerCase());
    const clientId = watch?.client_id ? Number(watch.client_id) : null;
    const clientName = clientId ? (await get('SELECT name FROM clients WHERE id = ?', clientId))?.name : '';
    const { text, materials, mediaTypes, missing } = await collect(msgs);
    const openTasks = await openTasksFor({ clientId });
    const recentTasks = await openTasksFor({ clientId, recentDone: true });
    const myTasks = person ? await openTasksFor({ userId: person.id }) : [];
    let replyTaskId = null;
    for (const m of msgs) if (m.replyTo) { const r = await get('SELECT task_id FROM bot_task_messages WHERE message_id = ?', m.replyTo); if (r) replyTaskId = r.task_id; }
    const analysis = await ai.analyze({
      text, hasMedia: mediaTypes.length > 0, mediaTypes, groupName: group.name, clientName, openTasks, recentTasks, myTasks,
      sender: { name: person?.name || buf.sender_name, isEmployee: !!person && !person.is_owner, isOwner: !!person?.is_owner },
    });
    const senderName = person?.name || buf.sender_name || `+${digits(buf.sender)}`;
    const messageIds = msgs.map((m) => m.id);
    if (analysis.kind === 'done' && person) {
      return askEmployeeAboutDone({ person, waId: dm(person.phone || buf.sender), text, title: analysis.title, materials, missing, messageIds, clientId, replyTaskId, aiTaskId: analysis.task_id });
    }
    if (analysis.kind === 'change' || (replyTaskId && analysis.kind === 'task')) {
      const task = recentTasks.find((t) => t.id === (replyTaskId || analysis.task_id))
        || (replyTaskId && (await openTasksFor({ recentDone: true })).find((t) => t.id === replyTaskId));
      if (task) return askOwnersAboutChange({ group, sender: buf.sender, senderName, task, text, materials, missing, messageIds, clientId });
    }
    if (analysis.kind === 'task' || analysis.kind === 'change') {
      return askOwnersAboutTask({ group, sender: buf.sender, senderName, title: analysis.title || shortTitle(text), details: analysis.details || text, materials, missing, messageIds, clientId, by: analysis.by });
    }
  }

  // ---------------------------------------------------------------- routes
  const checkKey = (request) => {
    const key = request?.headers.get('x-bot-key') || new URL(request.url).searchParams.get('key');
    if (!env.BOT_SECRET || key !== env.BOT_SECRET) fail(403, 'Invalid bot key');
  };
  route('POST', '/api/bot/inbound', async ({ request, body }) => {
    checkKey(request);
    const events = Array.isArray(body) ? body : Array.isArray(body.events) ? body.events : [body];
    for (const ev of events) await inbound(ev);
    const processed = await flush();
    return { ok: true, processed, sent: outbox };
  }, { auth: false });
  route('POST', '/api/bot/tick', async ({ request, body }) => {
    checkKey(request);
    const processed = await flush(!!body.force);
    return { ok: true, processed, sent: outbox };
  }, { auth: false });
  route('GET', '/api/bot/config', async ({ user }) => {
    if (!isOwner(user)) fail(403, 'Only owners can manage the WhatsApp bot');
    const c = await config();
    return {
      ...c,
      status: { waha: !!wahaBase(), secret: !!env.BOT_SECRET, ai: ai.provider, files: !!env.FILES },
      seen_groups: await all('SELECT id, name, last_seen FROM bot_groups ORDER BY last_seen DESC LIMIT 50'),
      phones: await all("SELECT id, name, role, is_owner, phone FROM users ORDER BY is_owner DESC, role DESC, name"),
      recent: await all(`SELECT i.id, i.kind, i.status, i.title, i.group_name, i.sender_name, i.result, i.task_id, i.created_at, u.name AS asked
        FROM bot_items i LEFT JOIN users u ON u.id = i.ask_user_id ORDER BY i.id DESC LIMIT 25`),
    };
  });
  route('POST', '/api/bot/config', async ({ user, body }) => {
    if (!isOwner(user)) fail(403, 'Only owners can manage the WhatsApp bot');
    const groups = (Array.isArray(body.groups) ? body.groups : []).map((g) => ({
      name: str(g.name, 120), id: str(g.id, 120) || undefined, client_id: g.client_id ? Number(g.client_id) : null,
    })).filter((g) => g.name || g.id).slice(0, 100);
    const value = { enabled: body.enabled !== false, buffer_seconds: Math.max(15, Math.min(600, Number(body.buffer_seconds) || 60)), groups };
    await run("INSERT INTO meta (key, value) VALUES ('bot_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(value));
    return value;
  });
  route('POST', '/api/bot/test', async ({ user }) => {
    if (!isOwner(user)) fail(403, 'Only owners can manage the WhatsApp bot');
    const me = await get('SELECT phone FROM users WHERE id = ?', user.id);
    if (!me?.phone) fail(400, 'Add your WhatsApp number in Settings first');
    if (!wahaBase()) fail(400, 'WAHA_URL is not set on the server yet');
    await send(dm(me.phone), '✅ Digiteq bot is connected. I’ll message you here when tasks come in from your WhatsApp groups.');
    return { ok: true };
  });

  return { flush };
}

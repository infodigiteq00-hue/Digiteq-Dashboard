// Cloudflare Pages API. Helpers and route state are scoped to each request.
import { generateVapid, sendPush } from './push.js';
import { localParts, startOfToday, nextHour } from './time.js';
import { FINANCE_SCHEMA, registerFinance } from './finance.js';
import { BOT_SCHEMA, registerBot } from './bot.js';

const SCHEMA = `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('superadmin','employee')),
  is_owner INTEGER NOT NULL DEFAULT 0, email TEXT, phone TEXT, must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact_person TEXT, email TEXT, phone TEXT,
  details TEXT, color TEXT, logo_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS client_deadlines (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT NOT NULL, due_at TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, deadline TEXT, priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
  source TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin','self')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  progress INTEGER, team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL, completed_at TEXT, completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL, completion_note TEXT
);
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);
-- one table for every link/file: client materials, task brief materials, task completion materials
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY, owner_type TEXT NOT NULL CHECK (owner_type IN ('client','task')),
  owner_id INTEGER NOT NULL, stage TEXT NOT NULL DEFAULT 'brief' CHECK (stage IN ('brief','completion')),
  kind TEXT NOT NULL CHECK (kind IN ('link','file')), title TEXT, url TEXT,
  file_key TEXT, file_name TEXT, mime TEXT, size INTEGER,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS materials_owner ON materials(owner_type, owner_id);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL, task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, task_id INTEGER, client_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_updates (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, text TEXT NOT NULL, progress INTEGER,
  digested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_updates_task ON task_updates(task_id, created_at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT, keywords TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);
-- forgot-password: kind 'email' = one-time link token (stored hashed), kind 'request' = ask an admin to reset
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('email','request')), token_hash TEXT, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, used_at TEXT, handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id, created_at);
`
  .concat(FINANCE_SCHEMA)
  .concat(BOT_SCHEMA)
  .split(';')
  .map((sql) => sql.trim())
  .filter(Boolean);
// Owners are super admins with finance access. Older databases get the column and their first super admin becomes owner.
const DEFAULT_TEAMS = [
  ['Designing', '#db2777', 'design, logo, banner, poster, creative, figma, thumbnail, flyer, brochure, mockup, illustration, graphic, reel, carousel, video edit, photoshop, canva, prototype'],
  ['Coding', '#2563eb', 'code, coding, website, web, app, bug, api, deploy, landing page, wordpress, shopify, html, css, database, server, domain, hosting, script, developer'],
  ['Marketing', '#d97706', 'marketing, ads, ad, campaign, seo, lead, newsletter, email, report, analytics, social media, promotion, hashtag, content calendar'],
];
async function migrate(DB) {
  const cols = (await DB.prepare('PRAGMA table_info(users)').all()).results.map((c) => c.name);
  const steps = [];
  if (!cols.includes('is_owner')) steps.push([
    'ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0',
    "UPDATE users SET is_owner = 1 WHERE id = (SELECT MIN(id) FROM users WHERE role = 'superadmin')",
  ]);
  if (!cols.includes('email')) steps.push(['ALTER TABLE users ADD COLUMN email TEXT']);
  if (!cols.includes('must_change_password')) steps.push(['ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0']);
  if (!cols.includes('phone')) steps.push(['ALTER TABLE users ADD COLUMN phone TEXT']);
  const taskCols = (await DB.prepare('PRAGMA table_info(tasks)').all()).results.map((c) => c.name);
  if (!taskCols.includes('team_id')) steps.push(['ALTER TABLE tasks ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL']);
  for (const sqls of steps) {
    try {
      await DB.batch(sqls.map((sql) => DB.prepare(sql)));
    } catch (err) {
      if (!/duplicate column/i.test(String(err?.message))) throw err; // another isolate migrated first
    }
  }
  // Starter teams, only once (so a team the owner deletes stays deleted).
  const seeded = await DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('teams_seeded', '1')").run();
  if (seeded.meta.changes) {
    await DB.batch(DEFAULT_TEAMS.map(([name, color, keywords]) => DB.prepare('INSERT OR IGNORE INTO teams (name, color, keywords, created_at) VALUES (?,?,?,?)').bind(name, color, keywords, new Date().toISOString())));
  }
}
let schemaPromise;
let lastHourlyCheck = 0;
let lastBotFlush = 0;
async function ensureSchema(DB) {
  if (!schemaPromise) {
    schemaPromise = DB.batch(SCHEMA.map((sql) => DB.prepare(sql))).then(() => migrate(DB)).catch((err) => {
      schemaPromise = undefined;
      throw err;
    });
  }
  await schemaPromise;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const now = () => new Date().toISOString();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
async function derivePassword(pw, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 50000 }, key, 256),
  );
}
export async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$50000$${hex(salt)}$${hex(await derivePassword(pw, salt))}`;
}
async function checkPassword(pw, stored) {
  const [scheme, iterations, saltHex, hashHex] = stored.split('$');
  if (
    scheme !== 'pbkdf2' ||
    iterations !== '50000' ||
    !/^[0-9a-f]{32}$/.test(saltHex) ||
    !/^[0-9a-f]{64}$/.test(hashHex)
  )
    return false;
  const salt = Uint8Array.from(saltHex.match(/../g), (h) => parseInt(h, 16));
  const expected = Uint8Array.from(hashHex.match(/../g), (h) => parseInt(h, 16));
  const actual = await derivePassword(pw, salt);
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

function createApi(context) {
  const { env } = context;
  const DB = env.DB;
  const TIMEZONE = env.TIMEZONE || 'Asia/Kolkata';
  const WORK_START = Number(env.WORK_START ?? 9);
  const WORK_END = Number(env.WORK_END ?? 20);
  const stmt = (sql, ...p) => DB.prepare(sql).bind(...p.map((v) => (v === undefined ? null : v)));
  const all = async (sql, ...p) => (await stmt(sql, ...p).all()).results;
  const get = (sql, ...p) => stmt(sql, ...p).first();
  const run = (sql, ...p) => stmt(sql, ...p).run();
  const batch = (statements) => (statements.length ? DB.batch(statements) : Promise.resolve([]));
  const files = () => env.FILES || fail(500, 'Missing FILES binding. See README → Cloudflare setup.');
  const background = (promise) =>
    context.waitUntil(promise.catch((err) => console.error('Background job failed', err)));
  async function vapidKeys() {
    const saved = await get("SELECT value FROM meta WHERE key = 'vapid'");
    if (saved) return JSON.parse(saved.value);
    const generated = await generateVapid();
    await run("INSERT OR IGNORE INTO meta (key, value) VALUES ('vapid', ?)", JSON.stringify(generated));
    return JSON.parse((await get("SELECT value FROM meta WHERE key = 'vapid'")).value);
  }
  async function pushTo(userId, payload) {
    const rows = await all('SELECT endpoint, subscription FROM push_subscriptions WHERE user_id = ?', userId);
    if (!rows.length) return;
    const vapid = await vapidKeys();
    await Promise.allSettled(
      rows.map(async (row) => {
        const status = await sendPush(
          JSON.parse(row.subscription),
          payload,
          vapid,
          env.VAPID_SUBJECT || 'mailto:admin@digiteq.local',
        );
        if (status === 404 || status === 410)
          await run('DELETE FROM push_subscriptions WHERE endpoint = ?', row.endpoint);
      }),
    );
  }
  async function broadcast() {
    await run(
      "INSERT INTO meta (key, value) VALUES ('version', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + 1",
    );
  }
  async function notify(userIds, { type, title, body = '', task_id = null, client_id = null, url = null }) {
    const created_at = now();
    for (const uid of new Set(userIds)) {
      const { meta } = await run(
        'INSERT INTO notifications (user_id, type, title, body, task_id, client_id, created_at) VALUES (?,?,?,?,?,?,?)',
        uid,
        type,
        title,
        body,
        task_id,
        client_id,
        created_at,
      );
      background(
        pushTo(uid, {
          title,
          body,
          url: url || (task_id ? `/#/task/${task_id}` : '/#/notifications'),
          tag: `n${meta.last_row_id}`,
        }),
      );
    }
    if (userIds.length) await broadcast();
  }
  const adminIds = async () => (await all("SELECT id FROM users WHERE role = 'superadmin'")).map((r) => r.id);
  async function newSession(userId) {
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    await run('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)', token, userId, now());
    return token;
  }
  const publicUser = (u) =>
    u && { id: u.id, name: u.name, username: u.username, role: u.role, is_owner: !!u.is_owner, email: u.email || '',
      phone: u.phone || '', must_change_password: !!u.must_change_password, created_at: u.created_at };

  const isAdmin = (u) => u.role === 'superadmin';
  // WhatsApp number: digits with country code, e.g. 919876543210 (the bot matches on the last 10 digits).
  async function cleanPhone(value, exceptId = 0) {
    const phone = String(value ?? '').replace(/\D/g, '');
    if (!phone) return null;
    if (phone.length < 10 || phone.length > 15) fail(400, 'WhatsApp number should include the country code, e.g. 91 98765 43210');
    const others = await all("SELECT id, phone FROM users WHERE phone IS NOT NULL AND phone != '' AND id != ?", exceptId);
    if (others.some((o) => o.phone.slice(-10) === phone.slice(-10))) fail(400, 'Another account already uses that WhatsApp number');
    return phone;
  }
  async function cleanEmail(value, exceptId = 0) {
    const email = str(value, 200).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'That email address doesn’t look right');
    if (email && (await get('SELECT 1 FROM users WHERE lower(email) = ? AND id != ?', email, exceptId))) fail(400, 'Another account already uses that email');
    return email || null;
  }
  const isOwner = (u) => u.role === 'superadmin' && !!u.is_owner;
  const ownerIds = async () => (await all("SELECT id FROM users WHERE role = 'superadmin' AND is_owner = 1")).map((r) => r.id);
  const requireAdmin = (u) => {
    if (!isAdmin(u)) fail(403, 'Only the super admin can do this');
  };
  const str = (v, max = 5000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const optDate = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) fail(400, 'Invalid date');
    return d.toISOString();
  };

  // ---------------------------------------------------------------- materials (links + files)
  async function materialStatement(ownerType, ownerId, stage, m, userId) {
    const created_at = now();
    if (m.kind === 'link') {
      let url = str(m.url, 2000);
      if (!url) fail(400, 'Link URL is required');
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
      if (!/^https?:/i.test(url)) fail(400, 'Only http(s) links are allowed');
      return stmt(
        `INSERT INTO materials (owner_type, owner_id, stage, kind, title, url, added_by, created_at)
         VALUES (?,${ownerId === null ? '(SELECT MAX(id) FROM tasks)' : '?'},?,?,?,?,?,?)`,
        ownerType,
        ...(ownerId === null ? [] : [ownerId]),
        stage,
        'link',
        str(m.title, 200) || url,
        url,
        userId,
        created_at,
      );
    } else if (m.kind === 'file') {
      const key = String(m.key || '');
      if (!/^files\/[0-9a-f-]{36}$/.test(key)) fail(400, 'Invalid file key');
      const object = await files().head(key);
      if (!object) fail(400, 'Uploaded file not found');
      const name = (str(m.name, 200) || 'file').split(/[\\/]/).pop();
      return stmt(
        `INSERT INTO materials (owner_type, owner_id, stage, kind, title, file_key, file_name, mime, size, added_by, created_at)
         VALUES (?,${ownerId === null ? '(SELECT MAX(id) FROM tasks)' : '?'},?,?,?,?,?,?,?,?,?)`,
        ownerType,
        ...(ownerId === null ? [] : [ownerId]),
        stage,
        'file',
        str(m.title, 200) || name,
        key,
        name,
        str(m.type, 100) || object.httpMetadata?.contentType || 'application/octet-stream',
        object.size,
        userId,
        created_at,
      );
    } else fail(400, 'Material must be a link or a file');
  }
  async function materialsFor(ownerType, ownerId) {
    return await all(
      `SELECT m.id, m.stage, m.kind, m.title, m.url, m.file_name, m.mime, m.size, m.created_at, m.added_by, u.name AS added_by_name
              FROM materials m LEFT JOIN users u ON u.id = m.added_by
              WHERE owner_type = ? AND owner_id = ? ORDER BY m.id`,
      ownerType,
      ownerId,
    );
  }
  async function materialStatements(ownerType, ownerId, stage, materials, userId) {
    const statements = [];
    for (const m of materials) statements.push(await materialStatement(ownerType, ownerId, stage, m, userId));
    return statements;
  }
  async function deleteMaterialsOf(ownerType, ownerIds) {
    for (const id of ownerIds) {
      const objects = await all(
        "SELECT file_key FROM materials WHERE owner_type = ? AND owner_id = ? AND kind = 'file'",
        ownerType,
        id,
      );
      for (const m of objects) await files().delete(m.file_key);
      await run('DELETE FROM materials WHERE owner_type = ? AND owner_id = ?', ownerType, id);
    }
  }

  // Client logo names stay public and unguessable; objects live in R2.
  const LOGO_KEY = /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;
  async function saveLogo(dataUrl) {
    files();
    const m = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(String(dataUrl));
    if (!m) fail(400, 'Logo must be a PNG, JPG, WebP or GIF image');
    let bytes;
    try {
      bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    } catch {
      fail(400, 'Invalid logo data');
    }
    if (bytes.length > 2 * 1024 * 1024) fail(400, 'Logo is too large (max 2 MB)');
    const key = `${crypto.randomUUID()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    await files().put(`logos/${key}`, bytes, { httpMetadata: { contentType: `image/${m[1]}` } });
    return key;
  }
  async function removeLogo(key) {
    if (key && LOGO_KEY.test(key)) await files().delete(`logos/${key}`);
  }

  // ---------------------------------------------------------------- tasks
  const TASK_SELECT = `
  SELECT t.*, c.name AS client_name, c.color AS client_color, c.logo_key AS client_logo, cb.name AS created_by_name, db.name AS completed_by_name,
    tm.name AS team_name, tm.color AS team_color
  FROM tasks t LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN teams tm ON tm.id = t.team_id
  LEFT JOIN users cb ON cb.id = t.created_by LEFT JOIN users db ON db.id = t.completed_by`;

  async function decorate(tasks) {
    if (!tasks.length) return tasks;
    // One JSON parameter avoids both D1's bind cap and extra queries for large lists.
    const ids = JSON.stringify(tasks.map((t) => t.id));
    const marks = 'SELECT value FROM json_each(?)';
    const assignees = await all(
      `SELECT ta.task_id, u.id, u.name FROM task_assignees ta JOIN users u ON u.id = ta.user_id
                         WHERE ta.task_id IN (${marks}) ORDER BY u.name`,
      ids,
    );
    const counts = await all(
      `SELECT owner_id, COUNT(*) AS n FROM materials WHERE owner_type = 'task' AND owner_id IN (${marks})
                      GROUP BY owner_id`,
      ids,
    );
    const cmap = Object.fromEntries(counts.map((c) => [c.owner_id, c.n]));
    const latest = await all(
      `SELECT u.task_id, u.text, u.created_at, us.name AS user_name FROM task_updates u LEFT JOIN users us ON us.id = u.user_id
                      WHERE u.id IN (SELECT MAX(id) FROM task_updates WHERE task_id IN (${marks}) GROUP BY task_id)`,
      ids,
    );
    const lmap = Object.fromEntries(latest.map((l) => [l.task_id, l]));
    for (const t of tasks) {
      const l = lmap[t.id];
      t.last_update = l ? { text: l.text, created_at: l.created_at, user_name: l.user_name } : null;
      t.assignees = assignees.filter((a) => a.task_id === t.id).map(({ id, name }) => ({ id, name }));
      t.material_count = cmap[t.id] || 0;
    }
    return tasks;
  }
  async function canView(user, task) {
    if (isAdmin(user) || task.client_id) return true;
    return !!(await get('SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ?', task.id, user.id));
  }
  const isAssignee = async (user, taskId) =>
    !!(await get('SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ?', taskId, user.id));
  async function loadTask(id) {
    const t = await get(`${TASK_SELECT} WHERE t.id = ?`, Number(id));
    if (!t) fail(404, 'Task not found');
    return t;
  }
  async function fullTask(id) {
    const t = (await decorate([await loadTask(id)]))[0];
    t.materials = await materialsFor('task', t.id);
    return t;
  }
  async function validAssignees(ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))];
    if (!list.length) fail(400, 'Assign this task to at least one employee');
    const found = await all(
      'SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?))',
      JSON.stringify(list),
    );
    if (found.length !== list.length) fail(400, 'One of the selected employees no longer exists');
    return list;
  }
  // A team task is assigned to every member of the team, so it shows up for all of them (kept in sync by the team routes).
  async function validTeam(id) {
    if (id === null || id === undefined || id === '') return null;
    if (!(await get('SELECT 1 FROM teams WHERE id = ?', Number(id)))) fail(400, 'Team not found');
    return Number(id);
  }
  async function withTeam(teamId, ids) {
    const members = teamId ? (await all('SELECT user_id FROM team_members WHERE team_id = ?', teamId)).map((r) => r.user_id) : [];
    const list = [...members, ...(Array.isArray(ids) ? ids : [])];
    if (teamId && !list.length) fail(400, 'That team has no members yet. Add people to it in Team, or pick someone.');
    return validAssignees(list);
  }
  async function validClient(id) {
    if (id === null || id === undefined || id === '') return null;
    if (!(await get('SELECT 1 FROM clients WHERE id = ?', Number(id)))) fail(400, 'Client not found');
    return Number(id);
  }
  const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

  // ---------------------------------------------------------------- router
  const routes = [];
  function route(method, pattern, handler, { auth = true } = {}) {
    const keys = [];
    const re = new RegExp(
      `^${pattern.replace(/:(\w+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      })}$`,
    );
    routes.push({ method, re, keys, handler, auth });
  }

  // --- setup + session
  route('GET', '/api/setup', async () => ({ needsSetup: !(await get('SELECT 1 FROM users LIMIT 1')) }), {
    auth: false,
  });
  route(
    'POST',
    '/api/setup',
    async ({ body }) => {
      if (await get('SELECT 1 FROM users LIMIT 1')) fail(400, 'Setup already done');
      const name = str(body.name, 100),
        username = str(body.username, 50),
        password = String(body.password || '');
      if (!name || !username || password.length < 6)
        fail(400, 'Name, username and a password of at least 6 characters are required');
      const {
        meta: { last_row_id, changes },
      } = await run(
        `INSERT INTO users (name, username, password_hash, role, is_owner, created_at)
    SELECT ?,?,?,?,1,? WHERE NOT EXISTS (SELECT 1 FROM users)`,
        name,
        username,
        await hashPassword(password),
        'superadmin',
        now(),
      );
      if (!changes) fail(400, 'Setup already done');
      const id = Number(last_row_id);
      return {
        token: await newSession(id),
        user: publicUser(await get('SELECT * FROM users WHERE id = ?', id)),
      };
    },
    { auth: false },
  );

  route(
    'POST',
    '/api/login',
    async ({ body }) => {
      // Accept the username or the recovery email (both case-insensitive).
      const who = str(body.username, 200);
      const u = await get("SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND email != '' AND lower(email) = lower(?)) ORDER BY username = ? DESC LIMIT 1", who, who, who);
      if (!u || !(await checkPassword(String(body.password || ''), u.password_hash)))
        fail(401, 'Wrong username or password');
      return { token: await newSession(u.id), user: publicUser(u) };
    },
    { auth: false },
  );
  route('POST', '/api/logout', async ({ token }) => {
    await run('DELETE FROM sessions WHERE token = ?', token);
    return { ok: true };
  });
  route('GET', '/api/me', async ({ user }) => ({
    user: publicUser(user),
    currency: env.CURRENCY || 'INR',
    email_reset: !!(env.RESEND_API_KEY && env.MAIL_FROM),
    unread: (await get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', user.id))
      .n,
  }));
  route('POST', '/api/me/password', async ({ user, body, token }) => {
    if (!(await checkPassword(String(body.current || ''), user.password_hash)))
      fail(400, 'Current password is wrong');
    if (String(body.password || '').length < 6) fail(400, 'New password must be at least 6 characters');
    if (String(body.password) === String(body.current)) fail(400, 'Choose a password different from the current one');
    await run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', await hashPassword(body.password), user.id);
    await run('DELETE FROM sessions WHERE user_id = ? AND token != ?', user.id, token); // sign out other devices
    return { ok: true };
  });

  // --- teams (shared boards)
  async function teamFields(body, existing = {}) {
    const name = 'name' in body ? str(body.name, 60) : existing.name;
    if (!name) fail(400, 'Give the team a name');
    const clash = await get('SELECT id FROM teams WHERE name = ? AND id != ?', name, existing.id || 0);
    if (clash) fail(400, 'A team with that name already exists');
    return { name, color: 'color' in body ? str(body.color, 20) : existing.color || '#4f46e5', keywords: 'keywords' in body ? str(body.keywords, 1000) : existing.keywords || '' };
  }
  // Members join/leave all of the team's open tasks.
  async function setMembers(teamId, ids) {
    const next = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))];
    if (next.length) await validAssignees(next);
    const old = (await all('SELECT user_id FROM team_members WHERE team_id = ?', teamId)).map((r) => r.user_id);
    const open = "SELECT id FROM tasks WHERE team_id = ? AND status != 'done'";
    await batch([
      ...old.filter((u) => !next.includes(u)).flatMap((u) => [
        stmt('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, u),
        stmt(`DELETE FROM task_assignees WHERE user_id = ? AND task_id IN (${open})`, u, teamId),
      ]),
      ...next.filter((u) => !old.includes(u)).flatMap((u) => [
        stmt('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?,?)', teamId, u),
        stmt(`INSERT OR IGNORE INTO task_assignees (task_id, user_id) SELECT id, ? FROM tasks WHERE team_id = ? AND status != 'done'`, u, teamId),
      ]),
    ]);
  }
  route('GET', '/api/teams', async () => {
    const teams = await all(`SELECT t.*, (SELECT COUNT(*) FROM tasks x WHERE x.team_id = t.id AND x.status != 'done') AS open_tasks FROM teams t ORDER BY t.name COLLATE NOCASE`);
    const members = await all('SELECT m.team_id, u.id, u.name FROM team_members m JOIN users u ON u.id = m.user_id ORDER BY u.name');
    return teams.map((t) => ({ ...t, members: members.filter((m) => m.team_id === t.id).map(({ id, name }) => ({ id, name })) }));
  });
  route('POST', '/api/teams', async ({ user, body }) => {
    requireAdmin(user);
    const f = await teamFields(body);
    const r = await run('INSERT INTO teams (name, color, keywords, created_at) VALUES (?,?,?,?)', f.name, f.color, f.keywords, now());
    await setMembers(r.meta.last_row_id, body.members);
    await broadcast();
    return { id: r.meta.last_row_id, ...f };
  });
  route('PATCH', '/api/teams/:id', async ({ user, body, params }) => {
    requireAdmin(user);
    const t = (await get('SELECT * FROM teams WHERE id = ?', Number(params.id))) || fail(404, 'Team not found');
    const f = await teamFields(body, t);
    await run('UPDATE teams SET name = ?, color = ?, keywords = ? WHERE id = ?', f.name, f.color, f.keywords, t.id);
    if ('members' in body) await setMembers(t.id, body.members);
    await broadcast();
    return { id: t.id, ...f };
  });
  route('DELETE', '/api/teams/:id', async ({ user, params }) => {
    requireAdmin(user);
    await run('DELETE FROM teams WHERE id = ?', Number(params.id)); // tasks keep their assignees, the team label goes
    await broadcast();
    return { ok: true };
  });

  // --- forgot password
  // 1. With RESEND_API_KEY + MAIL_FROM set and an email on the account: a one-time reset link (valid 1 hour).
  // 2. Otherwise: a reset request goes to the people allowed to reset that account (owners for owner accounts).
  const sha256 = async (text) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
  const emailEnabled = () => !!(env.RESEND_API_KEY && env.MAIL_FROM);
  // Readable temporary password, e.g. "kite-4821-moon".
  const WORDS = ['kite', 'moon', 'river', 'lamp', 'cloud', 'tiger', 'maple', 'stone', 'pearl', 'cedar', 'comet', 'delta', 'ember', 'falcon', 'grape', 'harbor'];
  const tempPassword = () => {
    const r = crypto.getRandomValues(new Uint32Array(3));
    return `${WORDS[r[0] % WORDS.length]}-${1000 + (r[1] % 9000)}-${WORDS[r[2] % WORDS.length]}`;
  };
  async function canResetFor(target) {
    return target.is_owner ? await ownerIds() : (await adminIds()).filter((id) => id !== target.id);
  }
  async function sendResetEmail(target, token, origin) {
    const link = `${origin}/#/reset/${token}`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM, to: [target.email], subject: 'Reset your Digiteq password',
        text: `Hi ${target.name},\n\nSomeone asked to reset the password for your Digiteq account (${target.username}).\nOpen this link within 1 hour to choose a new password:\n\n${link}\n\nIf it wasn't you, ignore this email. Your password stays the same.`,
      }),
    });
    if (!res.ok) throw new Error(`Email service returned ${res.status}`);
  }
  route('POST', '/api/password/forgot', async ({ body, url }) => {
    const who = str(body.username, 120);
    if (!who) fail(400, 'Enter your username or email');
    const target = await get("SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND email != '' AND lower(email) = lower(?))", who, who);
    // Same answer whether or not the account exists, so this can't be used to discover usernames.
    const answer = { ok: true, message: 'If that account exists, a reset link was emailed to it or your admin was asked to reset it.' };
    if (!target) return answer;
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const recent = (await get('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at >= ?', target.id, hourAgo)).n;
    if (recent >= 3) return answer; // rate limit: 3 per account per hour
    const t = now();
    if (emailEnabled() && target.email) {
      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      await run("INSERT INTO password_resets (user_id, kind, token_hash, created_at, expires_at) VALUES (?, 'email', ?, ?, ?)",
        target.id, await sha256(token), t, new Date(Date.now() + 3600000).toISOString());
      try { await sendResetEmail(target, token, url.origin); } catch (err) { console.error('reset email failed', err); }
      return answer;
    }
    await run("INSERT INTO password_resets (user_id, kind, created_at, expires_at) VALUES (?, 'request', ?, ?)",
      target.id, t, new Date(Date.now() + 7 * 86400000).toISOString());
    await notify(await canResetFor(target), {
      type: 'reset_request', title: `🔑 ${target.name} forgot their password`,
      body: `Open Team and set a temporary password for @${target.username}.`, url: '/#/team',
    });
    return answer;
  }, { auth: false });
  route('GET', '/api/password/reset/:token', async ({ params }) => {
    const row = await get(`SELECT r.id, u.name, u.username FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.kind = 'email' AND r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ?`, await sha256(params.token), now());
    if (!row) fail(400, 'This reset link has expired or was already used. Ask for a new one.');
    return { name: row.name, username: row.username };
  }, { auth: false });
  route('POST', '/api/password/reset', async ({ body }) => {
    const password = String(body.password || '');
    if (password.length < 6) fail(400, 'Password must be at least 6 characters');
    const row = await get("SELECT * FROM password_resets WHERE kind = 'email' AND token_hash = ? AND used_at IS NULL AND expires_at > ?",
      await sha256(String(body.token || '')), now());
    if (!row) fail(400, 'This reset link has expired or was already used. Ask for a new one.');
    const claimed = await run('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL', now(), row.id);
    if (!claimed.meta.changes) fail(400, 'This reset link was already used.');
    await DB.batch([
      stmt('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', await hashPassword(password), row.user_id),
      stmt('DELETE FROM sessions WHERE user_id = ?', row.user_id), // sign out every device
      stmt('UPDATE password_resets SET used_at = COALESCE(used_at, ?) WHERE user_id = ?', now(), row.user_id),
    ]);
    const u = await get('SELECT * FROM users WHERE id = ?', row.user_id);
    return { token: await newSession(u.id), user: publicUser(u) };
  }, { auth: false });
  route('GET', '/api/password/requests', async ({ user }) => {
    requireAdmin(user);
    const rows = await all(`SELECT r.id, r.created_at, u.id AS user_id, u.name, u.username, u.is_owner FROM password_resets r
      JOIN users u ON u.id = r.user_id WHERE r.kind = 'request' AND r.used_at IS NULL AND r.expires_at > ? ORDER BY r.id DESC`, now());
    const seen = new Set();
    // One row per person; super admins only see requests for accounts they are allowed to reset.
    return rows.filter((r) => (isOwner(user) || !r.is_owner) && r.user_id !== user.id && !seen.has(r.user_id) && seen.add(r.user_id));
  });
  route('POST', '/api/users/:id/temp-password', async ({ user, params }) => {
    requireAdmin(user);
    const target = (await get('SELECT * FROM users WHERE id = ?', Number(params.id))) || fail(404, 'User not found');
    if (target.id === user.id) fail(400, 'Use Settings → Change password for your own account');
    if (target.is_owner && !isOwner(user)) fail(403, 'Only an owner can reset an owner’s password');
    const password = tempPassword();
    await DB.batch([
      stmt('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', await hashPassword(password), target.id),
      stmt('DELETE FROM sessions WHERE user_id = ?', target.id),
      stmt('UPDATE password_resets SET used_at = ?, handled_by = ? WHERE user_id = ? AND used_at IS NULL', now(), user.id, target.id),
    ]);
    await broadcast();
    return { password, username: target.username };
  });
  route('POST', '/api/me/phone', async ({ user, body }) => {
    const phone = await cleanPhone(body.phone, user.id);
    await run('UPDATE users SET phone = ? WHERE id = ?', phone, user.id);
    return { ok: true, phone: phone || '' };
  });
  route('POST', '/api/me/email', async ({ user, body }) => {
    const email = await cleanEmail(body.email, user.id);
    await run('UPDATE users SET email = ? WHERE id = ?', email, user.id);
    return { ok: true, email: email || '' };
  });

  // --- users / team
  route('GET', '/api/users', async ({ user }) => {
    const rows = await all('SELECT id, name, username, role, is_owner, email, phone, created_at FROM users ORDER BY role DESC, is_owner DESC, name');
    if (!isAdmin(user)) return rows.map(({ id, name, role }) => ({ id, name, role }));
    for (const r of rows) r.is_owner = !!r.is_owner;
    const stats = await all(
      `SELECT ta.user_id, SUM(t.status != 'done') AS open, SUM(t.status = 'done') AS done,
                     SUM(t.status != 'done' AND t.deadline IS NOT NULL AND t.deadline < ?) AS overdue
                     FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id GROUP BY ta.user_id`,
      now(),
    );
    const smap = Object.fromEntries(stats.map((s) => [s.user_id, s]));
    return rows.map((r) => ({
      ...r,
      open: smap[r.id]?.open || 0,
      done: smap[r.id]?.done || 0,
      overdue: smap[r.id]?.overdue || 0,
    }));
  });
  route('POST', '/api/users', async ({ user, body }) => {
    requireAdmin(user);
    const name = str(body.name, 100),
      username = str(body.username, 50),
      password = String(body.password || '');
    const role = body.role === 'superadmin' ? 'superadmin' : 'employee';
    const owner = isOwner(user) && role === 'superadmin' && body.is_owner ? 1 : 0;
    if (!name || !username) fail(400, 'Name and username are required');
    if (password.length < 6) fail(400, 'Password must be at least 6 characters');
    if (await get('SELECT 1 FROM users WHERE username = ?', username))
      fail(400, 'That username is already taken');
    const {
      meta: { last_row_id },
    } = await run(
      'INSERT INTO users (name, username, password_hash, role, is_owner, email, phone, created_at) VALUES (?,?,?,?,?,?,?,?)',
      name,
      username,
      await hashPassword(password),
      role,
      owner,
      await cleanEmail(body.email),
      await cleanPhone(body.phone),
      now(),
    );
    await broadcast();
    return publicUser(await get('SELECT * FROM users WHERE id = ?', Number(last_row_id)));
  });
  route('PATCH', '/api/users/:id', async ({ user, body, params, token }) => {
    requireAdmin(user);
    const target =
      (await get('SELECT * FROM users WHERE id = ?', Number(params.id))) || fail(404, 'User not found');
    const name = str(body.name, 100) || target.name;
    const role = body.role ? (body.role === 'superadmin' ? 'superadmin' : 'employee') : target.role;
    if (target.is_owner && !isOwner(user)) fail(403, 'Only an owner can change an owner’s account');
    let owner = 'is_owner' in body && isOwner(user) ? (body.is_owner ? 1 : 0) : target.is_owner ? 1 : 0;
    if (role !== 'superadmin') owner = 0;
    if (target.is_owner && !owner && (await ownerIds()).length === 1) fail(400, 'You need at least one owner');
    if (target.role === 'superadmin' && role !== 'superadmin' && (await adminIds()).length === 1)
      fail(400, 'You need at least one super admin');
    if (body.password && String(body.password).length < 6)
      fail(400, 'Password must be at least 6 characters');
    const changed = await run(
      `UPDATE users SET name = ?, role = ?, is_owner = ? WHERE id = ?
    AND (role != 'superadmin' OR ? = 'superadmin' OR (SELECT COUNT(*) FROM users WHERE role = 'superadmin') > 1)
    AND (is_owner = 0 OR ? = 1 OR (SELECT COUNT(*) FROM users WHERE is_owner = 1) > 1)`,
      name,
      role,
      owner,
      target.id,
      role,
      owner,
    );
    if (!changed.meta.changes) fail(400, 'You need at least one super admin');
    if ('email' in body) await run('UPDATE users SET email = ? WHERE id = ?', await cleanEmail(body.email, target.id), target.id);
    if ('phone' in body) await run('UPDATE users SET phone = ? WHERE id = ?', await cleanPhone(body.phone, target.id), target.id);
    if (body.password) {
      if (String(body.password).length < 6) fail(400, 'Password must be at least 6 characters');
      await run(
        'UPDATE users SET password_hash = ? WHERE id = ?',
        await hashPassword(body.password),
        target.id,
      );
      await run('DELETE FROM sessions WHERE user_id = ? AND token != ?', target.id, token); // log out their other devices
    }
    await broadcast();
    return publicUser(await get('SELECT * FROM users WHERE id = ?', target.id));
  });
  route('DELETE', '/api/users/:id', async ({ user, params }) => {
    requireAdmin(user);
    const id = Number(params.id);
    if (id === user.id) fail(400, 'You cannot delete your own account');
    const target = (await get('SELECT * FROM users WHERE id = ?', id)) || fail(404, 'User not found');
    if (target.role === 'superadmin' && (await adminIds()).length === 1)
      fail(400, 'You need at least one super admin');
    if (target.is_owner && !isOwner(user)) fail(403, 'Only an owner can remove an owner');
    if (target.is_owner && (await ownerIds()).length === 1) fail(400, 'You need at least one owner');
    const deleted = await run(
      `DELETE FROM users WHERE id = ?
    AND (role != 'superadmin' OR (SELECT COUNT(*) FROM users WHERE role = 'superadmin') > 1)`,
      id,
    );
    if (!deleted.meta.changes) fail(400, 'You need at least one super admin');
    await broadcast();
    return { ok: true };
  });

  // --- clients
  route('GET', '/api/clients', async () => {
    return await all(
      `SELECT c.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status != 'done') AS open_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status = 'done') AS done_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status != 'done' AND t.deadline < ?) AS overdue_tasks,
      (SELECT MIN(due) FROM (
         SELECT deadline AS due FROM tasks t WHERE t.client_id = c.id AND t.status != 'done' AND t.deadline IS NOT NULL
         UNION ALL SELECT due_at FROM client_deadlines d WHERE d.client_id = c.id AND d.done = 0)) AS next_deadline,
      (SELECT COUNT(*) FROM materials m WHERE m.owner_type = 'client' AND m.owner_id = c.id) AS material_count
    FROM clients c ORDER BY c.name COLLATE NOCASE`,
      now(),
    );
  });
  function clientFields(body, existing = {}) {
    const name = str(body.name, 150) || existing.name;
    if (!name) fail(400, 'Client name is required');
    const pick = (k, max = 300) => (k in body ? str(body[k], max) : (existing[k] ?? ''));
    return {
      name,
      contact_person: pick('contact_person'),
      email: pick('email'),
      phone: pick('phone', 50),
      details: pick('details', 10000),
      color: pick('color', 20) || existing.color || '#4f46e5',
    };
  }
  route('POST', '/api/clients', async ({ user, body }) => {
    requireAdmin(user);
    const f = clientFields(body);
    const t = now();
    const logo = body.logo ? await saveLogo(body.logo) : null;
    const {
      meta: { last_row_id },
    } = await run(
      `INSERT INTO clients (name, contact_person, email, phone, details, color, logo_key, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,
      f.name,
      f.contact_person,
      f.email,
      f.phone,
      f.details,
      f.color,
      logo,
      t,
      t,
    );
    await broadcast();
    return await get('SELECT * FROM clients WHERE id = ?', Number(last_row_id));
  });
  route('GET', '/api/clients/:id', async ({ user, params }) => {
    const c =
      (await get('SELECT * FROM clients WHERE id = ?', Number(params.id))) || fail(404, 'Client not found');
    c.deadlines = await all('SELECT * FROM client_deadlines WHERE client_id = ? ORDER BY done, due_at', c.id);
    c.materials = await materialsFor('client', c.id);
    c.tasks = await decorate(
      await all(
        `${TASK_SELECT} WHERE t.client_id = ?
    ORDER BY t.status = 'done', t.deadline IS NULL, t.deadline, t.id DESC`,
        c.id,
      ),
    );
    c.can_edit = isAdmin(user);
    if (isOwner(user)) c.finance = await clientFinance(c.id);
    return c;
  });
  route('PATCH', '/api/clients/:id', async ({ user, body, params }) => {
    requireAdmin(user);
    const c =
      (await get('SELECT * FROM clients WHERE id = ?', Number(params.id))) || fail(404, 'Client not found');
    const f = clientFields(body, c);
    let logo = c.logo_key;
    if ('logo' in body) {
      // null removes the logo, a data URL replaces it
      logo = body.logo ? await saveLogo(body.logo) : null;
      await removeLogo(c.logo_key);
    }
    await run(
      `UPDATE clients SET name=?, contact_person=?, email=?, phone=?, details=?, color=?, logo_key=?, updated_at=? WHERE id=?`,
      f.name,
      f.contact_person,
      f.email,
      f.phone,
      f.details,
      f.color,
      logo,
      now(),
      c.id,
    );
    await broadcast();
    return await get('SELECT * FROM clients WHERE id = ?', c.id);
  });
  route('DELETE', '/api/clients/:id', async ({ user, params }) => {
    requireAdmin(user);
    const id = Number(params.id);
    const client = await get('SELECT logo_key FROM clients WHERE id = ?', id);
    const objects = await all(
      `SELECT file_key FROM materials WHERE kind = 'file' AND
    ((owner_type = 'client' AND owner_id = ?) OR (owner_type = 'task' AND owner_id IN (SELECT id FROM tasks WHERE client_id = ?)))`,
      id,
      id,
    );
    if (objects.length || client?.logo_key) files();
    await DB.batch([
      stmt(
        "DELETE FROM materials WHERE owner_type = 'task' AND owner_id IN (SELECT id FROM tasks WHERE client_id = ?)",
        id,
      ),
      stmt("DELETE FROM materials WHERE owner_type = 'client' AND owner_id = ?", id),
      stmt('DELETE FROM clients WHERE id = ?', id),
    ]);
    for (const m of objects) await files().delete(m.file_key);
    await removeLogo(client?.logo_key);
    await broadcast();
    return { ok: true };
  });
  route('POST', '/api/clients/:id/materials', async ({ user, body, params }) => {
    requireAdmin(user);
    const id = Number(params.id);
    if (!(await get('SELECT 1 FROM clients WHERE id = ?', id))) fail(404, 'Client not found');
    await batch(await materialStatements('client', id, 'brief', body.materials || [body], user.id));
    await broadcast();
    return await materialsFor('client', id);
  });
  route('POST', '/api/clients/:id/deadlines', async ({ user, body, params }) => {
    requireAdmin(user);
    const id = Number(params.id);
    if (!(await get('SELECT 1 FROM clients WHERE id = ?', id))) fail(404, 'Client not found');
    const title = str(body.title, 200);
    const due = optDate(body.due_at);
    if (!title || !due) fail(400, 'Deadline needs a title and a date');
    await run(
      'INSERT INTO client_deadlines (client_id, title, due_at, created_at) VALUES (?,?,?,?)',
      id,
      title,
      due,
      now(),
    );
    await broadcast();
    return { ok: true };
  });
  route('PATCH', '/api/deadlines/:id', async ({ user, body, params }) => {
    requireAdmin(user);
    await run('UPDATE client_deadlines SET done = ? WHERE id = ?', body.done ? 1 : 0, Number(params.id));
    await broadcast();
    return { ok: true };
  });
  route('DELETE', '/api/deadlines/:id', async ({ user, params }) => {
    requireAdmin(user);
    await run('DELETE FROM client_deadlines WHERE id = ?', Number(params.id));
    await broadcast();
    return { ok: true };
  });

  route(
    'GET',
    '/api/logos/:key',
    async ({ params }) => {
      const bucket = files();
      if (!LOGO_KEY.test(params.key)) fail(404, 'Logo not found');
      const object = await bucket.get(`logos/${params.key}`);
      if (!object) fail(404, 'Logo not found');
      const ext = params.key.split('.').pop();
      return new Response(object.body, {
        headers: {
          'Content-Type': ext === 'jpg' ? 'image/jpeg' : `image/${ext}`,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    },
    { auth: false },
  );

  // --- materials (shared delete + file download)
  route('DELETE', '/api/materials/:id', async ({ user, params }) => {
    const m =
      (await get('SELECT * FROM materials WHERE id = ?', Number(params.id))) || fail(404, 'Not found');
    const own = m.added_by === user.id;
    if (!isAdmin(user) && !own) fail(403, 'You can only remove items you added');
    if (m.file_key) await files().delete(m.file_key);
    await run('DELETE FROM materials WHERE id = ?', m.id);
    await broadcast();
    return { ok: true };
  });
  route('GET', '/api/files/:id', async ({ user, params, url }) => {
    const bucket = files();
    const m =
      (await get("SELECT * FROM materials WHERE id = ? AND kind = 'file'", Number(params.id))) ||
      fail(404, 'File not found');
    if (m.owner_type === 'task' && !(await canView(user, await loadTask(m.owner_id))))
      fail(403, 'Not allowed');
    const object = await bucket.get(m.file_key);
    if (!object) fail(404, 'File missing on server');
    const disposition = url.searchParams.get('download') ? 'attachment' : 'inline';
    return new Response(object.body, {
      headers: {
        'Content-Type': m.mime || 'application/octet-stream',
        'Content-Length': String(object.size),
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(m.file_name)}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
      },
    });
  });

  // --- tasks
  route('GET', '/api/tasks', async ({ user, url }) => {
    const sp = url.searchParams;
    const where = [],
      p = [];
    // "mine" = tasks assigned to me (incl. self-added). Admin default sees everything.
    if (sp.get('scope') === 'mine' || !isAdmin(user)) {
      where.push('t.id IN (SELECT task_id FROM task_assignees WHERE user_id = ?)');
      p.push(user.id);
    }
    if (sp.get('assignee') && isAdmin(user)) {
      where.push('t.id IN (SELECT task_id FROM task_assignees WHERE user_id = ?)');
      p.push(Number(sp.get('assignee')));
    }
    if (sp.get('client')) {
      where.push('t.client_id = ?');
      p.push(Number(sp.get('client')));
    }
    if (sp.get('status')) {
      where.push('t.status = ?');
      p.push(sp.get('status'));
    }
    if (sp.get('source')) {
      where.push('t.source = ?');
      p.push(sp.get('source'));
    }
    const limit = Math.min(Number(sp.get('limit')) || 500, 1000);
    const sql = `${TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.status = 'done', CASE WHEN t.status = 'done' THEN t.completed_at END DESC,
    t.deadline IS NULL, t.deadline, t.id DESC LIMIT ${limit}`;
    return await decorate(await all(sql, ...p));
  });
  route('GET', '/api/tasks/:id', async ({ user, params }) => {
    const t = await fullTask(params.id);
    if (!(await canView(user, t))) fail(403, 'Not allowed');
    t.can_edit = isAdmin(user) || (t.source === 'self' && t.created_by === user.id);
    t.can_work = isAdmin(user) || t.assignees.some((a) => a.id === user.id);
    t.updates = await all(
      `SELECT u.id, u.text, u.progress, u.created_at, u.user_id, us.name AS user_name FROM task_updates u
    LEFT JOIN users us ON us.id = u.user_id WHERE u.task_id = ? ORDER BY u.id DESC LIMIT 200`,
      t.id,
    );
    return t;
  });

  // --- hourly progress updates (collected silently, sent to the super admin as one digest per hour)
  async function addUpdate(taskId, userId, text, progress = null, digested = 0) {
    await run(
      'INSERT INTO task_updates (task_id, user_id, text, progress, digested, created_at) VALUES (?,?,?,?,?,?)',
      taskId,
      userId,
      text,
      progress,
      digested,
      now(),
    );
    if (progress !== null)
      await run('UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?', progress, now(), taskId);
  }
  route('POST', '/api/tasks/:id/updates', async ({ user, body, params }) => {
    const task = await loadTask(params.id);
    if (!isAdmin(user) && !(await isAssignee(user, task.id))) fail(403, 'This task is not assigned to you');
    if (task.status === 'done') fail(400, 'This task is already done');
    const text = str(body.text, 2000);
    if (!text) fail(400, 'Write what you finished or what you are working on');
    const progress =
      body.progress === null || body.progress === undefined || body.progress === ''
        ? null
        : Math.max(0, Math.min(100, Math.round(Number(body.progress)) || 0));
    // Starting to report progress also moves the task to "In progress".
    if (task.status === 'todo')
      await run("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?", now(), task.id);
    await addUpdate(task.id, user.id, text, progress, isAdmin(user) ? 1 : 0);
    await broadcast();
    return { ok: true };
  });
  route('GET', '/api/updates', async ({ user, url }) => {
    const days = Math.min(Number(url.searchParams.get('days')) || 7, 60);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    return await all(
      `SELECT u.id, u.text, u.progress, u.created_at, u.task_id, us.name AS user_name, u.user_id,
      t.title AS task_title, t.status AS task_status, t.client_id, c.name AS client_name, c.color AS client_color, c.logo_key AS client_logo
    FROM task_updates u JOIN tasks t ON t.id = u.task_id LEFT JOIN users us ON us.id = u.user_id LEFT JOIN clients c ON c.id = t.client_id
    WHERE u.created_at >= ? ${isAdmin(user) ? '' : 'AND u.user_id = ?'} ORDER BY u.id DESC LIMIT 500`,
      since,
      ...(isAdmin(user) ? [] : [user.id]),
    );
  });
  route('POST', '/api/updates/digest', async ({ user }) => {
    requireAdmin(user);
    return { sent: await sendDigest() };
  });
  route('GET', '/api/updates/schedule', async () => ({
    start: WORK_START,
    end: WORK_END,
    next: nextHour(TIMEZONE).toISOString(),
  }));
  route('POST', '/api/tasks', async ({ user, body }) => {
    const title = str(body.title, 300);
    if (!title) fail(400, 'Task title is required');
    const admin = isAdmin(user);
    // Super admin MUST pick at least one employee. Employees can only add tasks to their own list.
    const teamId = admin ? await validTeam(body.team_id) : null;
    const assignees = admin ? await withTeam(teamId, body.assignees) : [user.id];
    const priority = PRIORITIES.includes(body.priority) ? body.priority : 'normal';
    const t = now();
    const clientId = await validClient(body.client_id);
    const materials = await materialStatements('task', null, 'brief', body.materials || [], user.id);
    // D1 batches are atomic. MAX(id) refers to this batch's task insert, with no interleaving writes.
    const statements = [
      stmt(
        `INSERT INTO tasks (team_id, client_id, title, description, deadline, priority, source, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
        teamId,
        clientId,
        title,
        str(body.description, 20000),
        optDate(body.deadline),
        priority,
        admin ? 'admin' : 'self',
        user.id,
        t,
        t,
      ),
      ...assignees.map((uid) =>
        stmt('INSERT INTO task_assignees (task_id, user_id) SELECT MAX(id), ? FROM tasks', uid),
      ),
      ...materials,
    ];
    if (body.note_id)
      statements.push(
        stmt(
          'UPDATE notes SET task_id = (SELECT MAX(id) FROM tasks), updated_at = ? WHERE id = ? AND user_id = ?',
          t,
          Number(body.note_id),
          user.id,
        ),
      );
    const result = await DB.batch(statements);
    const id = Number(result[0].meta.last_row_id);
    const task = await fullTask(id);
    const where = task.client_name ? ` · ${task.client_name}` : '';
    if (admin) {
      await notify(
        assignees.filter((u) => u !== user.id),
        {
          type: 'assigned',
          title: `New task: ${title}`,
          body: `Assigned by ${user.name}${where}`,
          task_id: id,
          client_id: task.client_id,
        },
      );
    } else {
      await notify(await adminIds(), {
        type: 'self_added',
        title: `${user.name} added a task`,
        body: `${title}${where}`,
        task_id: id,
        client_id: task.client_id,
      });
    }
    await broadcast();
    return task;
  });
  route('PATCH', '/api/tasks/:id', async ({ user, body, params }) => {
    const task = await loadTask(params.id);
    const admin = isAdmin(user);
    if (!admin && !(task.source === 'self' && task.created_by === user.id))
      fail(403, 'Only the super admin can edit this task');
    const before = (await decorate([task]))[0].assignees.map((a) => a.id);
    // Updating a task as super admin always requires (re)confirming its assignees.
    const teamId = admin && 'team_id' in body ? await validTeam(body.team_id) : task.team_id;
    const assignees = admin ? await withTeam(teamId, body.assignees ?? before) : before;
    const title = 'title' in body ? str(body.title, 300) : task.title;
    if (!title) fail(400, 'Task title is required');
    const materials = await materialStatements('task', task.id, 'brief', body.materials || [], user.id);
    const statements = [
      stmt(
        `UPDATE tasks SET team_id=?, title=?, description=?, deadline=?, priority=?, client_id=?, updated_at=? WHERE id=?`,
        teamId,
        title,
        'description' in body ? str(body.description, 20000) : task.description,
        'deadline' in body ? optDate(body.deadline) : task.deadline,
        PRIORITIES.includes(body.priority) ? body.priority : task.priority,
        'client_id' in body ? await validClient(body.client_id) : task.client_id,
        now(),
        task.id,
      ),
    ];
    if (admin) {
      statements.push(stmt('DELETE FROM task_assignees WHERE task_id = ?', task.id));
      for (const uid of assignees)
        statements.push(stmt('INSERT INTO task_assignees (task_id, user_id) VALUES (?,?)', task.id, uid));
    }
    await DB.batch([...statements, ...materials]);
    const updated = await fullTask(task.id);
    const added = assignees.filter((u) => !before.includes(u) && u !== user.id);
    if (added.length)
      await notify(added, {
        type: 'assigned',
        title: `New task: ${updated.title}`,
        body: `Assigned by ${user.name}${updated.client_name ? ` · ${updated.client_name}` : ''}`,
        task_id: task.id,
        client_id: updated.client_id,
      });
    const others = assignees.filter((u) => before.includes(u) && u !== user.id);
    if (admin && others.length)
      await notify(others, {
        type: 'updated',
        title: `Task updated: ${updated.title}`,
        body: `Updated by ${user.name}`,
        task_id: task.id,
        client_id: updated.client_id,
      });
    await broadcast();
    return updated;
  });
  route('DELETE', '/api/tasks/:id', async ({ user, params }) => {
    const task = await loadTask(params.id);
    if (!isAdmin(user) && !(task.source === 'self' && task.created_by === user.id))
      fail(403, 'Only the super admin can delete this task');
    await deleteMaterialsOf('task', [task.id]);
    await run('DELETE FROM tasks WHERE id = ?', task.id);
    await broadcast();
    return { ok: true };
  });
  route('POST', '/api/tasks/:id/status', async ({ user, body, params }) => {
    const task = await loadTask(params.id);
    if (!isAdmin(user) && !(await isAssignee(user, task.id))) fail(403, 'This task is not assigned to you');
    const status = body.status;
    if (!['todo', 'in_progress'].includes(status))
      fail(400, 'Use the "Mark as done" button to finish a task');
    // Moving a done task back re-opens it and clears the completion stamp (completion materials are kept as history).
    await run(
      `UPDATE tasks SET status = ?, completed_at = NULL, completed_by = NULL, completion_note = NULL, updated_at = ? WHERE id = ?`,
      status,
      now(),
      task.id,
    );
    if (status === 'in_progress' && task.status !== 'in_progress')
      await addUpdate(task.id, user.id, 'Started working on this', null, isAdmin(user) ? 1 : 0);
    if (task.status === 'done' && isAdmin(user)) {
      const ids = (await decorate([task]))[0].assignees.map((a) => a.id).filter((u) => u !== user.id);
      await notify(ids, {
        type: 'reopened',
        title: `Task reopened: ${task.title}`,
        body: `Reopened by ${user.name}`,
        task_id: task.id,
        client_id: task.client_id,
      });
    }
    await broadcast();
    return await fullTask(task.id);
  });
  route('POST', '/api/tasks/:id/complete', async ({ user, body, params }) => {
    const task = await loadTask(params.id);
    if (!isAdmin(user) && !(await isAssignee(user, task.id))) fail(403, 'This task is not assigned to you');
    if (task.status === 'done') fail(400, 'This task is already done');
    const at = now();
    await DB.batch([
      ...(await materialStatements('task', task.id, 'completion', body.materials || [], user.id)),
      stmt(
        `UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ?, completion_note = ?, updated_at = ? WHERE id = ?`,
        at,
        user.id,
        str(body.note, 10000),
        at,
        task.id,
      ),
    ]);
    const done = await fullTask(task.id);
    const files = done.materials.filter((m) => m.stage === 'completion').length;
    await notify(
      (await adminIds()).filter((u) => u !== user.id),
      {
        type: 'completed',
        title: `✅ ${user.name} completed a task`,
        body: `${task.title}${done.client_name ? ` · ${done.client_name}` : ''}${files ? ` · ${files} attachment${files > 1 ? 's' : ''}` : ''}`,
        task_id: task.id,
        client_id: task.client_id,
      },
    );
    await broadcast();
    return done;
  });
  route('POST', '/api/tasks/:id/materials', async ({ user, body, params }) => {
    const task = await loadTask(params.id);
    if (!isAdmin(user) && !(await isAssignee(user, task.id))) fail(403, 'This task is not assigned to you');
    const stage = body.stage === 'completion' ? 'completion' : 'brief';
    await batch(await materialStatements('task', task.id, stage, body.materials || [body], user.id));
    await broadcast();
    return await fullTask(task.id);
  });

  // --- notes (private to each user)
  route(
    'GET',
    '/api/notes',
    async ({ user }) =>
      await all(
        `SELECT n.*, t.title AS task_title, t.status AS task_status FROM notes n
  LEFT JOIN tasks t ON t.id = n.task_id WHERE n.user_id = ? ORDER BY n.updated_at DESC`,
        user.id,
      ),
  );
  route('POST', '/api/notes', async ({ user, body }) => {
    const content = str(body.content, 20000);
    if (!content) fail(400, 'Note is empty');
    const t = now();
    const {
      meta: { last_row_id },
    } = await run(
      'INSERT INTO notes (user_id, content, created_at, updated_at) VALUES (?,?,?,?)',
      user.id,
      content,
      t,
      t,
    );
    await broadcast();
    return await get('SELECT * FROM notes WHERE id = ?', Number(last_row_id));
  });
  route('PATCH', '/api/notes/:id', async ({ user, body, params }) => {
    const content = str(body.content, 20000);
    if (!content) fail(400, 'Note is empty');
    const r = await run(
      'UPDATE notes SET content = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      content,
      now(),
      Number(params.id),
      user.id,
    );
    if (!r.meta.changes) fail(404, 'Note not found');
    await broadcast();
    return { ok: true };
  });
  route('DELETE', '/api/notes/:id', async ({ user, params }) => {
    await run('DELETE FROM notes WHERE id = ? AND user_id = ?', Number(params.id), user.id);
    await broadcast();
    return { ok: true };
  });

  // --- notifications + push
  route(
    'GET',
    '/api/notifications',
    async ({ user }) =>
      await all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100', user.id),
  );
  route('POST', '/api/notifications/read', async ({ user, body }) => {
    if (body.id)
      await run(
        'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
        Number(body.id),
        user.id,
      );
    else await run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', user.id);
    await broadcast();
    return { ok: true };
  });
  route('GET', '/api/push/key', async () => ({ key: (await vapidKeys()).publicKey }));
  route('POST', '/api/push/subscribe', async ({ user, body }) => {
    const sub = body.subscription;
    if (!sub?.endpoint) fail(400, 'Invalid subscription');
    await run(
      'INSERT OR REPLACE INTO push_subscriptions (endpoint, user_id, subscription, created_at) VALUES (?,?,?,?)',
      sub.endpoint,
      user.id,
      JSON.stringify(sub),
      now(),
    );
    return { ok: true };
  });

  route('POST', '/api/push/unsubscribe', async ({ user, body }) => {
    await run(
      'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
      String(body.endpoint || ''),
      user.id,
    );
    return { ok: true };
  });

  // --- overview for the super admin home screen
  route('GET', '/api/overview', async ({ user }) => {
    requireAdmin(user);
    const t = now();
    const startOfDay = startOfToday(TIMEZONE);
    const in3days = new Date(Date.now() + 3 * 86400000).toISOString();
    return {
      counts: await get(
        `SELECT SUM(status = 'todo') AS todo, SUM(status = 'in_progress') AS in_progress,
      SUM(status != 'done' AND deadline < ?) AS overdue, SUM(status = 'done' AND completed_at >= ?) AS done_today,
      (SELECT COUNT(*) FROM clients) AS clients FROM tasks`,
        t,
        startOfDay.toISOString(),
      ),
      finance: isOwner(user) ? await financeSummary() : null,
      recent_done: await decorate(
        await all(`${TASK_SELECT} WHERE t.status = 'done' ORDER BY t.completed_at DESC LIMIT 8`),
      ),
      due_soon: await decorate(
        await all(
          `${TASK_SELECT} WHERE t.status != 'done' AND t.deadline IS NOT NULL AND t.deadline <= ?
      ORDER BY t.deadline LIMIT 10`,
          in3days,
        ),
      ),
      latest_updates:
        await all(`SELECT u.id, u.text, u.progress, u.created_at, u.task_id, us.name AS user_name, u.user_id, t.title AS task_title,
      c.name AS client_name, c.color AS client_color, c.logo_key AS client_logo FROM task_updates u JOIN tasks t ON t.id = u.task_id
      LEFT JOIN users us ON us.id = u.user_id LEFT JOIN clients c ON c.id = t.client_id ORDER BY u.id DESC LIMIT 6`),
      team: await all(
        `SELECT u.id, u.name,
      (SELECT COUNT(*) FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE ta.user_id = u.id AND t.status != 'done') AS open,
      (SELECT COUNT(*) FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE ta.user_id = u.id AND t.status != 'done' AND t.deadline < ?) AS overdue,
      (SELECT COUNT(*) FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE ta.user_id = u.id AND t.status = 'done' AND t.completed_at >= ?) AS done_week
      FROM users u WHERE u.role = 'employee' ORDER BY open DESC, u.name`,
        t,
        new Date(Date.now() - 7 * 86400000).toISOString(),
      ),
      client_deadlines: await all(
        `SELECT d.*, c.name AS client_name, c.color AS client_color, c.logo_key AS client_logo FROM client_deadlines d
      JOIN clients c ON c.id = d.client_id WHERE d.done = 0 AND d.due_at <= ? ORDER BY d.due_at LIMIT 10`,
        in3days,
      ),
    };
  });

  async function sendDigest() {
    // Claim the current updates atomically so simultaneous manual/cron digests
    // cannot notify admins twice for the same updates.
    const claimed = await DB.batch([
      stmt(`SELECT u.id, u.text, u.progress, us.name AS user_name, t.id AS task_id, t.title, c.name AS client_name
      FROM task_updates u JOIN tasks t ON t.id = u.task_id LEFT JOIN users us ON us.id = u.user_id LEFT JOIN clients c ON c.id = t.client_id
      WHERE u.digested = 0 ORDER BY u.id`),
      stmt('UPDATE task_updates SET digested = 1 WHERE digested = 0'),
    ]);
    const rows = claimed[0].results;
    if (!rows.length) return 0;
    const tasks = new Map();
    for (const r of rows) tasks.set(r.task_id, r); // keep the latest update per task for the summary
    const lines = [...tasks.values()].map(
      (r) =>
        `${r.user_name || 'Someone'} · ${r.title}${r.client_name ? ` (${r.client_name})` : ''}: ${r.text}${r.progress !== null ? ` [${r.progress}%]` : ''}`,
    );
    const body = lines.slice(0, 4).join('\n') + (lines.length > 4 ? `\n+ ${lines.length - 4} more` : '');
    await notify(await adminIds(), {
      type: 'digest',
      title: `Hourly update · ${rows.length} update${rows.length > 1 ? 's' : ''} on ${tasks.size} task${tasks.size > 1 ? 's' : ''}`,
      body,
      url: '/#/updates',
    });
    await broadcast();
    return rows.length;
  }
  async function sendReminders() {
    const cutoff = new Date(Date.now() - 55 * 60000).toISOString();
    const due = await all(
      `SELECT ta.user_id, t.id, t.title FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id JOIN users u ON u.id = ta.user_id
    WHERE t.status = 'in_progress' AND u.role = 'employee'
      AND NOT EXISTS (SELECT 1 FROM task_updates x WHERE x.task_id = t.id AND x.created_at >= ?)`,
      cutoff,
    );
    const byUser = new Map();
    for (const r of due) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id).push(r);
    }
    for (const [uid, list] of byUser) {
      await notify([uid], {
        type: 'reminder',
        title: `Hourly update: ${list.length} task${list.length > 1 ? 's need' : ' needs'} an update`,
        body:
          list
            .slice(0, 3)
            .map((t) => t.title)
            .join(' · ') + (list.length > 3 ? ` +${list.length - 3} more` : ''),
        task_id: list.length === 1 ? list[0].id : null,
        url: list.length === 1 ? `/#/task/${list[0].id}` : '/#/tasks',
      });
    }
  }

  const { clientFinance, financeSummary, sendFinanceAlert } = registerFinance({
    route, all, get, run, stmt, batch, DB, fail, files, str, now, isOwner, ownerIds, notify, broadcast, TIMEZONE, localParts,
    currency: env.CURRENCY || 'INR',
  });

  // Lets the WhatsApp bot act as a real user through the normal routes (same permissions, notifications, validation).
  async function internal(method, path, actor, body = {}) {
    const url = new URL(`https://internal${path}`);
    const r = routes.find((x) => x.method === method && x.re.test(url.pathname));
    if (!r) fail(404, `No route ${method} ${path}`);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(r.re)[i + 1])]));
    return r.handler({ request: null, url, params, body, user: actor, token: null });
  }
  const bot = registerBot({ route, all, get, run, DB, fail, files, str, now, env, isOwner, notify, internal, localParts, TIMEZONE });

  route('POST', '/api/upload', async ({ request }) => {
    const bucket = files();
    const max = 25 * 1024 * 1024;
    const length = request.headers.get('Content-Length');
    if (length === null || !/^\d+$/.test(length)) fail(411, 'Content-Length is required');
    const size = Number(length);
    if (size > max) fail(413, 'File is too large (max 25 MB)');
    if (!size || !request.body) fail(400, 'Empty file');
    let name;
    try {
      name = decodeURIComponent(request.headers.get('X-File-Name') || 'file');
    } catch {
      fail(400, 'Invalid file name');
    }
    name = (str(name, 200) || 'file').split(/[\\/]/).pop();
    const type = str(request.headers.get('Content-Type'), 100) || 'application/octet-stream';
    const key = `files/${crypto.randomUUID()}`;
    await bucket.put(key, request.body, { httpMetadata: { contentType: type } });
    return { key, name, type, size };
  });

  async function runHourly() {
    const local = localParts(TIMEZONE);
    const hour = Number(local.hour);
    if (hour < WORK_START || hour > WORK_END) return;
    const slot = `${local.year}-${local.month}-${local.day} ${hour}`;
    const result = await run(
      `INSERT INTO meta (key, value) VALUES ('last_hourly', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value != excluded.value`,
      slot,
    );
    if (result.meta.changes !== 1) return;
    await sendDigest();
    await sendReminders();
    if (hour === WORK_START) await sendFinanceAlert();
  }
  route(
    'POST',
    '/api/cron/hourly',
    async ({ request }) => {
      if (!env.CRON_SECRET || request.headers.get('x-cron-key') !== env.CRON_SECRET)
        fail(403, 'Invalid cron secret');
      await runHourly();
      await bot.flush();
      return { ok: true };
    },
    { auth: false },
  );
  route('GET', '/api/sync', async ({ user, url }) => {
    if (Date.now() - lastHourlyCheck >= 60000) {
      lastHourlyCheck = Date.now();
      background(runHourly());
    }
    if (Date.now() - lastBotFlush >= 30000) {
      lastBotFlush = Date.now();
      background(bot.flush()); // backup for the n8n tick: grouped WhatsApp messages are processed while the app is open too
    }
    const n = url.searchParams.get('n');
    const results = await DB.batch([
      stmt("SELECT value FROM meta WHERE key = 'version'"),
      stmt('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', user.id),
      stmt('SELECT COALESCE(MAX(id), 0) AS id FROM notifications WHERE user_id = ?', user.id),
      stmt(
        'SELECT * FROM notifications WHERE user_id = ? AND id > ? ORDER BY id LIMIT 20',
        user.id,
        n ? Number(n) || 0 : Number.MAX_SAFE_INTEGER,
      ),
    ]);
    return {
      version: Number(results[0].results[0]?.value || 0),
      unread: results[1].results[0].n,
      last_id: results[2].results[0].id,
      notifications: results[3].results,
    };
  });

  return async function dispatch(request) {
    const url = new URL(request.url);
    const r = routes.find((x) => x.method === request.method && x.re.test(url.pathname));
    if (!r) fail(404, 'Not found');
    const params = Object.fromEntries(
      r.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(r.re)[i + 1])]),
    );
    let user = null,
      token = null;
    if (r.auth) {
      token =
        (request.headers.get('Authorization') || '').replace(/^Bearer /, '') ||
        url.searchParams.get('token') ||
        '';
      user =
        token &&
        (await get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', token));
      if (!user) fail(401, 'Please log in again');
    }
    let body = {};
    if (['POST', 'PATCH', 'PUT'].includes(request.method) && url.pathname !== '/api/upload') {
      const text = await request.text();
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        fail(400, 'Invalid JSON');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'JSON body must be an object');
    }
    const out = await r.handler({ request, url, params, body, user, token });
    return out instanceof Response ? out : Response.json(out, { headers: { 'Cache-Control': 'no-store' } });
  };
}

export async function handle(context) {
  try {
    if (!context.env.DB) fail(500, 'Missing DB binding. See README → Cloudflare setup.');
    await ensureSchema(context.env.DB);
    return await createApi(context)(context.request);
  } catch (err) {
    if (!err.status) console.error(err);
    return Response.json(
      { error: err.status ? err.message : 'Something went wrong on the server' },
      { status: err.status || 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

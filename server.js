// Digiteq Dashboard server: JSON API + live updates (SSE) + web push + static PWA.
// Zero build step. Storage is a single SQLite file in ./data (Node's built-in node:sqlite).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import webpush from 'web-push';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const LOGOS = path.join(UPLOADS, 'logos');
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 60 * 1024 * 1024; // 60 MB request (files are sent base64 inside JSON)
fs.mkdirSync(LOGOS, { recursive: true });

// ---------------------------------------------------------------- database
const db = new DatabaseSync(path.join(DATA, 'dashboard.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('superadmin','employee')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact_person TEXT, email TEXT, phone TEXT,
  details TEXT, color TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
  completed_at TEXT, completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL, completion_note TEXT
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
`);

if (!db.prepare('PRAGMA table_info(clients)').all().some((c) => c.name === 'logo_key')) db.exec('ALTER TABLE clients ADD COLUMN logo_key TEXT');
if (!db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'progress')) db.exec('ALTER TABLE tasks ADD COLUMN progress INTEGER');
db.exec(`
CREATE TABLE IF NOT EXISTS task_updates (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, text TEXT NOT NULL, progress INTEGER,
  digested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_updates_task ON task_updates(task_id, created_at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

const q = (sql) => db.prepare(sql);
const all = (sql, ...p) => q(sql).all(...p);
const get = (sql, ...p) => q(sql).get(...p);
const run = (sql, ...p) => q(sql).run(...p);
const now = () => new Date().toISOString();
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------------------------------------------------------------- web push (keys generated on first run)
const vapidFile = path.join(DATA, 'vapid.json');
if (!fs.existsSync(vapidFile)) fs.writeFileSync(vapidFile, JSON.stringify(webpush.generateVAPIDKeys()));
const vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@digiteq.local', vapid.publicKey, vapid.privateKey);

function pushTo(userId, payload) {
  for (const row of all('SELECT endpoint, subscription FROM push_subscriptions WHERE user_id = ?', userId)) {
    webpush.sendNotification(JSON.parse(row.subscription), JSON.stringify(payload)).catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) run('DELETE FROM push_subscriptions WHERE endpoint = ?', row.endpoint);
    });
  }
}

// ---------------------------------------------------------------- live updates (Server-Sent Events)
const streams = new Map(); // userId -> Set<res>
function emit(userId, event, data) {
  for (const res of streams.get(userId) || []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(topics, onlyUserIds) {
  for (const uid of onlyUserIds || streams.keys()) emit(uid, 'refresh', { topics });
}
setInterval(() => { for (const set of streams.values()) for (const res of set) res.write(': ping\n\n'); }, 25000);

function notify(userIds, { type, title, body = '', task_id = null, client_id = null, url = null }) {
  const created_at = now();
  for (const uid of new Set(userIds)) {
    const { lastInsertRowid } = run(
      'INSERT INTO notifications (user_id, type, title, body, task_id, client_id, created_at) VALUES (?,?,?,?,?,?,?)',
      uid, type, title, body, task_id, client_id, created_at);
    const n = { id: Number(lastInsertRowid), type, title, body, task_id, client_id, is_read: 0, created_at };
    emit(uid, 'notify', n);
    pushTo(uid, { title, body, url: url || (task_id ? `/#/task/${task_id}` : '/#/notifications'), tag: `n${n.id}` });
  }
}
const adminIds = () => all("SELECT id FROM users WHERE role = 'superadmin'").map((r) => r.id);

// ---------------------------------------------------------------- auth helpers
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)', token, userId, now());
  return token;
}
const publicUser = (u) => u && { id: u.id, name: u.name, username: u.username, role: u.role, created_at: u.created_at };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const isAdmin = (u) => u.role === 'superadmin';
const requireAdmin = (u) => { if (!isAdmin(u)) fail(403, 'Only the super admin can do this'); };
const str = (v, max = 5000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const optDate = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) fail(400, 'Invalid date');
  return d.toISOString();
};

// ---------------------------------------------------------------- materials (links + files)
function addMaterial(ownerType, ownerId, stage, m, userId) {
  const created_at = now();
  if (m.kind === 'link') {
    let url = str(m.url, 2000);
    if (!url) fail(400, 'Link URL is required');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    if (!/^https?:/i.test(url)) fail(400, 'Only http(s) links are allowed');
    run(`INSERT INTO materials (owner_type, owner_id, stage, kind, title, url, added_by, created_at)
         VALUES (?,?,?,?,?,?,?,?)`, ownerType, ownerId, stage, 'link', str(m.title, 200) || url, url, userId, created_at);
  } else if (m.kind === 'file') {
    const raw = String(m.data || '').replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(raw, 'base64');
    if (!buf.length) fail(400, 'Empty file');
    const name = path.basename(str(m.name, 200) || 'file');
    const key = crypto.randomUUID();
    fs.writeFileSync(path.join(UPLOADS, key), buf);
    run(`INSERT INTO materials (owner_type, owner_id, stage, kind, title, file_key, file_name, mime, size, added_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ownerType, ownerId, stage, 'file', str(m.title, 200) || name, key, name,
    str(m.type, 100) || 'application/octet-stream', buf.length, userId, created_at);
  } else fail(400, 'Material must be a link or a file');
}
function materialsFor(ownerType, ownerId) {
  return all(`SELECT m.id, m.stage, m.kind, m.title, m.url, m.file_name, m.mime, m.size, m.created_at, m.added_by, u.name AS added_by_name
              FROM materials m LEFT JOIN users u ON u.id = m.added_by
              WHERE owner_type = ? AND owner_id = ? ORDER BY m.id`, ownerType, ownerId);
}
function deleteMaterialsOf(ownerType, ownerIds) {
  for (const id of ownerIds) {
    for (const m of all("SELECT file_key FROM materials WHERE owner_type = ? AND owner_id = ? AND kind = 'file'", ownerType, id)) {
      fs.rm(path.join(UPLOADS, m.file_key), () => {});
    }
    run('DELETE FROM materials WHERE owner_type = ? AND owner_id = ?', ownerType, id);
  }
}

// ---------------------------------------------------------------- client logos (public, unguessable file names)
const LOGO_KEY = /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;
function saveLogo(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(String(dataUrl));
  if (!m) fail(400, 'Logo must be a PNG, JPG, WebP or GIF image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) fail(400, 'Logo is too large (max 2 MB)');
  const key = `${crypto.randomUUID()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(LOGOS, key), buf);
  return key;
}
const removeLogo = (key) => { if (key && LOGO_KEY.test(key)) fs.rm(path.join(LOGOS, key), () => {}); };

// ---------------------------------------------------------------- tasks
const TASK_SELECT = `
  SELECT t.*, c.name AS client_name, c.color AS client_color, c.logo_key AS client_logo, cb.name AS created_by_name, db.name AS completed_by_name
  FROM tasks t LEFT JOIN clients c ON c.id = t.client_id
  LEFT JOIN users cb ON cb.id = t.created_by LEFT JOIN users db ON db.id = t.completed_by`;

function decorate(tasks) {
  if (!tasks.length) return tasks;
  const ids = tasks.map((t) => t.id);
  const marks = ids.map(() => '?').join(',');
  const assignees = all(`SELECT ta.task_id, u.id, u.name FROM task_assignees ta JOIN users u ON u.id = ta.user_id
                         WHERE ta.task_id IN (${marks}) ORDER BY u.name`, ...ids);
  const counts = all(`SELECT owner_id, COUNT(*) AS n FROM materials WHERE owner_type = 'task' AND owner_id IN (${marks})
                      GROUP BY owner_id`, ...ids);
  const cmap = Object.fromEntries(counts.map((c) => [c.owner_id, c.n]));
  const latest = all(`SELECT u.task_id, u.text, u.created_at, us.name AS user_name FROM task_updates u LEFT JOIN users us ON us.id = u.user_id
                      WHERE u.id IN (SELECT MAX(id) FROM task_updates WHERE task_id IN (${marks}) GROUP BY task_id)`, ...ids);
  const lmap = Object.fromEntries(latest.map((l) => [l.task_id, l]));
  for (const t of tasks) {
    const l = lmap[t.id];
    t.last_update = l ? { text: l.text, created_at: l.created_at, user_name: l.user_name } : null;
    t.assignees = assignees.filter((a) => a.task_id === t.id).map(({ id, name }) => ({ id, name }));
    t.material_count = cmap[t.id] || 0;
  }
  return tasks;
}
function canView(user, task) {
  if (isAdmin(user) || task.client_id) return true;
  return !!get('SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ?', task.id, user.id);
}
const isAssignee = (user, taskId) => !!get('SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ?', taskId, user.id);
function loadTask(id) {
  const t = get(`${TASK_SELECT} WHERE t.id = ?`, Number(id));
  if (!t) fail(404, 'Task not found');
  return t;
}
function fullTask(id) {
  const t = decorate([loadTask(id)])[0];
  t.materials = materialsFor('task', t.id);
  return t;
}
function validAssignees(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))];
  if (!list.length) fail(400, 'Assign this task to at least one employee');
  const found = all(`SELECT id FROM users WHERE id IN (${list.map(() => '?').join(',')})`, ...list);
  if (found.length !== list.length) fail(400, 'One of the selected employees no longer exists');
  return list;
}
function validClient(id) {
  if (id === null || id === undefined || id === '') return null;
  if (!get('SELECT 1 FROM clients WHERE id = ?', Number(id))) fail(400, 'Client not found');
  return Number(id);
}
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

// ---------------------------------------------------------------- router
const routes = [];
function route(method, pattern, handler, { auth = true } = {}) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler, auth });
}

// --- setup + session
route('GET', '/api/setup', () => ({ needsSetup: !get('SELECT 1 FROM users LIMIT 1') }), { auth: false });
route('POST', '/api/setup', ({ body }) => {
  if (get('SELECT 1 FROM users LIMIT 1')) fail(400, 'Setup already done');
  const name = str(body.name, 100), username = str(body.username, 50), password = String(body.password || '');
  if (!name || !username || password.length < 6) fail(400, 'Name, username and a password of at least 6 characters are required');
  const { lastInsertRowid } = run('INSERT INTO users (name, username, password_hash, role, created_at) VALUES (?,?,?,?,?)',
    name, username, hashPassword(password), 'superadmin', now());
  const id = Number(lastInsertRowid);
  return { token: newSession(id), user: publicUser(get('SELECT * FROM users WHERE id = ?', id)) };
}, { auth: false });

route('POST', '/api/login', ({ body }) => {
  const u = get('SELECT * FROM users WHERE username = ?', str(body.username, 50));
  if (!u || !checkPassword(String(body.password || ''), u.password_hash)) fail(401, 'Wrong username or password');
  return { token: newSession(u.id), user: publicUser(u) };
}, { auth: false });
route('POST', '/api/logout', ({ token }) => { run('DELETE FROM sessions WHERE token = ?', token); return { ok: true }; });
route('GET', '/api/me', ({ user }) => ({ user: publicUser(user), unread: get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', user.id).n }));
route('POST', '/api/me/password', ({ user, body, token }) => {
  if (!checkPassword(String(body.current || ''), user.password_hash)) fail(400, 'Current password is wrong');
  if (String(body.password || '').length < 6) fail(400, 'New password must be at least 6 characters');
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(body.password), user.id);
  run('DELETE FROM sessions WHERE user_id = ? AND token != ?', user.id, token); // sign out other devices
  return { ok: true };
});

// --- users / team
route('GET', '/api/users', ({ user }) => {
  const rows = all("SELECT id, name, username, role, created_at FROM users ORDER BY role DESC, name");
  if (!isAdmin(user)) return rows.map(({ id, name, role }) => ({ id, name, role }));
  const stats = all(`SELECT ta.user_id, SUM(t.status != 'done') AS open, SUM(t.status = 'done') AS done,
                     SUM(t.status != 'done' AND t.deadline IS NOT NULL AND t.deadline < ?) AS overdue
                     FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id GROUP BY ta.user_id`, now());
  const smap = Object.fromEntries(stats.map((s) => [s.user_id, s]));
  return rows.map((r) => ({ ...r, open: smap[r.id]?.open || 0, done: smap[r.id]?.done || 0, overdue: smap[r.id]?.overdue || 0 }));
});
route('POST', '/api/users', ({ user, body }) => {
  requireAdmin(user);
  const name = str(body.name, 100), username = str(body.username, 50), password = String(body.password || '');
  const role = body.role === 'superadmin' ? 'superadmin' : 'employee';
  if (!name || !username) fail(400, 'Name and username are required');
  if (password.length < 6) fail(400, 'Password must be at least 6 characters');
  if (get('SELECT 1 FROM users WHERE username = ?', username)) fail(400, 'That username is already taken');
  const { lastInsertRowid } = run('INSERT INTO users (name, username, password_hash, role, created_at) VALUES (?,?,?,?,?)',
    name, username, hashPassword(password), role, now());
  broadcast(['users']);
  return publicUser(get('SELECT * FROM users WHERE id = ?', Number(lastInsertRowid)));
});
route('PATCH', '/api/users/:id', ({ user, body, params, token }) => {
  requireAdmin(user);
  const target = get('SELECT * FROM users WHERE id = ?', Number(params.id)) || fail(404, 'User not found');
  const name = str(body.name, 100) || target.name;
  const role = body.role ? (body.role === 'superadmin' ? 'superadmin' : 'employee') : target.role;
  if (target.role === 'superadmin' && role !== 'superadmin' && adminIds().length === 1) fail(400, 'You need at least one super admin');
  run('UPDATE users SET name = ?, role = ? WHERE id = ?', name, role, target.id);
  if (body.password) {
    if (String(body.password).length < 6) fail(400, 'Password must be at least 6 characters');
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(body.password), target.id);
    run('DELETE FROM sessions WHERE user_id = ? AND token != ?', target.id, token); // log out their other devices
  }
  broadcast(['users', 'tasks']);
  return publicUser(get('SELECT * FROM users WHERE id = ?', target.id));
});
route('DELETE', '/api/users/:id', ({ user, params }) => {
  requireAdmin(user);
  const id = Number(params.id);
  if (id === user.id) fail(400, 'You cannot delete your own account');
  const target = get('SELECT * FROM users WHERE id = ?', id) || fail(404, 'User not found');
  if (target.role === 'superadmin' && adminIds().length === 1) fail(400, 'You need at least one super admin');
  run('DELETE FROM users WHERE id = ?', id);
  broadcast(['users', 'tasks']);
  return { ok: true };
});

// --- clients
route('GET', '/api/clients', () => {
  return all(`SELECT c.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status != 'done') AS open_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status = 'done') AS done_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status != 'done' AND t.deadline < ?) AS overdue_tasks,
      (SELECT MIN(due) FROM (
         SELECT deadline AS due FROM tasks t WHERE t.client_id = c.id AND t.status != 'done' AND t.deadline IS NOT NULL
         UNION ALL SELECT due_at FROM client_deadlines d WHERE d.client_id = c.id AND d.done = 0)) AS next_deadline,
      (SELECT COUNT(*) FROM materials m WHERE m.owner_type = 'client' AND m.owner_id = c.id) AS material_count
    FROM clients c ORDER BY c.name COLLATE NOCASE`, now());
});
function clientFields(body, existing = {}) {
  const name = str(body.name, 150) || existing.name;
  if (!name) fail(400, 'Client name is required');
  const pick = (k, max = 300) => (k in body ? str(body[k], max) : existing[k] ?? '');
  return { name, contact_person: pick('contact_person'), email: pick('email'), phone: pick('phone', 50),
    details: pick('details', 10000), color: pick('color', 20) || existing.color || '#4f46e5' };
}
route('POST', '/api/clients', ({ user, body }) => {
  requireAdmin(user);
  const f = clientFields(body);
  const t = now();
  const logo = body.logo ? saveLogo(body.logo) : null;
  const { lastInsertRowid } = run(`INSERT INTO clients (name, contact_person, email, phone, details, color, logo_key, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, f.name, f.contact_person, f.email, f.phone, f.details, f.color, logo, t, t);
  broadcast(['clients']);
  return get('SELECT * FROM clients WHERE id = ?', Number(lastInsertRowid));
});
route('GET', '/api/clients/:id', ({ user, params }) => {
  const c = get('SELECT * FROM clients WHERE id = ?', Number(params.id)) || fail(404, 'Client not found');
  c.deadlines = all('SELECT * FROM client_deadlines WHERE client_id = ? ORDER BY done, due_at', c.id);
  c.materials = materialsFor('client', c.id);
  c.tasks = decorate(all(`${TASK_SELECT} WHERE t.client_id = ?
    ORDER BY t.status = 'done', t.deadline IS NULL, t.deadline, t.id DESC`, c.id));
  c.can_edit = isAdmin(user);
  return c;
});
route('PATCH', '/api/clients/:id', ({ user, body, params }) => {
  requireAdmin(user);
  const c = get('SELECT * FROM clients WHERE id = ?', Number(params.id)) || fail(404, 'Client not found');
  const f = clientFields(body, c);
  let logo = c.logo_key;
  if ('logo' in body) { // null removes the logo, a data URL replaces it
    logo = body.logo ? saveLogo(body.logo) : null;
    removeLogo(c.logo_key);
  }
  run(`UPDATE clients SET name=?, contact_person=?, email=?, phone=?, details=?, color=?, logo_key=?, updated_at=? WHERE id=?`,
    f.name, f.contact_person, f.email, f.phone, f.details, f.color, logo, now(), c.id);
  broadcast(['clients', 'tasks']);
  return get('SELECT * FROM clients WHERE id = ?', c.id);
});
route('DELETE', '/api/clients/:id', ({ user, params }) => {
  requireAdmin(user);
  const id = Number(params.id);
  removeLogo(get('SELECT logo_key FROM clients WHERE id = ?', id)?.logo_key);
  tx(() => {
    deleteMaterialsOf('task', all('SELECT id FROM tasks WHERE client_id = ?', id).map((r) => r.id));
    deleteMaterialsOf('client', [id]);
    run('DELETE FROM clients WHERE id = ?', id);
  });
  broadcast(['clients', 'tasks']);
  return { ok: true };
});
route('POST', '/api/clients/:id/materials', ({ user, body, params }) => {
  requireAdmin(user);
  const id = Number(params.id);
  if (!get('SELECT 1 FROM clients WHERE id = ?', id)) fail(404, 'Client not found');
  tx(() => { for (const m of body.materials || [body]) addMaterial('client', id, 'brief', m, user.id); });
  broadcast(['clients']);
  return materialsFor('client', id);
});
route('POST', '/api/clients/:id/deadlines', ({ user, body, params }) => {
  requireAdmin(user);
  const id = Number(params.id);
  if (!get('SELECT 1 FROM clients WHERE id = ?', id)) fail(404, 'Client not found');
  const title = str(body.title, 200);
  const due = optDate(body.due_at);
  if (!title || !due) fail(400, 'Deadline needs a title and a date');
  run('INSERT INTO client_deadlines (client_id, title, due_at, created_at) VALUES (?,?,?,?)', id, title, due, now());
  broadcast(['clients']);
  return { ok: true };
});
route('PATCH', '/api/deadlines/:id', ({ user, body, params }) => {
  requireAdmin(user);
  run('UPDATE client_deadlines SET done = ? WHERE id = ?', body.done ? 1 : 0, Number(params.id));
  broadcast(['clients']);
  return { ok: true };
});
route('DELETE', '/api/deadlines/:id', ({ user, params }) => {
  requireAdmin(user);
  run('DELETE FROM client_deadlines WHERE id = ?', Number(params.id));
  broadcast(['clients']);
  return { ok: true };
});

route('GET', '/api/logos/:key', ({ params, res }) => {
  if (!LOGO_KEY.test(params.key) || !fs.existsSync(path.join(LOGOS, params.key))) fail(404, 'Logo not found');
  const ext = params.key.split('.').pop();
  res.writeHead(200, { 'Content-Type': ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(path.join(LOGOS, params.key)).pipe(res);
  return undefined;
}, { auth: false });

// --- materials (shared delete + file download)
route('DELETE', '/api/materials/:id', ({ user, params }) => {
  const m = get('SELECT * FROM materials WHERE id = ?', Number(params.id)) || fail(404, 'Not found');
  const own = m.added_by === user.id;
  if (!isAdmin(user) && !own) fail(403, 'You can only remove items you added');
  if (m.file_key) fs.rm(path.join(UPLOADS, m.file_key), () => {});
  run('DELETE FROM materials WHERE id = ?', m.id);
  broadcast(['clients', 'tasks']);
  return { ok: true };
});
route('GET', '/api/files/:id', ({ user, params, res, url }) => {
  const m = get("SELECT * FROM materials WHERE id = ? AND kind = 'file'", Number(params.id)) || fail(404, 'File not found');
  if (m.owner_type === 'task' && !canView(user, loadTask(m.owner_id))) fail(403, 'Not allowed');
  const file = path.join(UPLOADS, m.file_key);
  if (!fs.existsSync(file)) fail(404, 'File missing on server');
  const disposition = url.searchParams.get('download') ? 'attachment' : 'inline';
  res.writeHead(200, {
    'Content-Type': m.mime || 'application/octet-stream', 'Content-Length': m.size,
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(m.file_name)}`,
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
  });
  fs.createReadStream(file).pipe(res);
  return undefined;
});

// --- tasks
route('GET', '/api/tasks', ({ user, url }) => {
  const sp = url.searchParams;
  const where = [], p = [];
  // "mine" = tasks assigned to me (incl. self-added). Admin default sees everything.
  if (sp.get('scope') === 'mine' || !isAdmin(user)) {
    where.push('t.id IN (SELECT task_id FROM task_assignees WHERE user_id = ?)'); p.push(user.id);
  }
  if (sp.get('assignee') && isAdmin(user)) {
    where.push('t.id IN (SELECT task_id FROM task_assignees WHERE user_id = ?)'); p.push(Number(sp.get('assignee')));
  }
  if (sp.get('client')) { where.push('t.client_id = ?'); p.push(Number(sp.get('client'))); }
  if (sp.get('status')) { where.push('t.status = ?'); p.push(sp.get('status')); }
  if (sp.get('source')) { where.push('t.source = ?'); p.push(sp.get('source')); }
  const limit = Math.min(Number(sp.get('limit')) || 500, 1000);
  const sql = `${TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.status = 'done', CASE WHEN t.status = 'done' THEN t.completed_at END DESC,
    t.deadline IS NULL, t.deadline, t.id DESC LIMIT ${limit}`;
  return decorate(all(sql, ...p));
});
route('GET', '/api/tasks/:id', ({ user, params }) => {
  const t = fullTask(params.id);
  if (!canView(user, t)) fail(403, 'Not allowed');
  t.can_edit = isAdmin(user) || (t.source === 'self' && t.created_by === user.id);
  t.can_work = isAdmin(user) || t.assignees.some((a) => a.id === user.id);
  t.updates = all(`SELECT u.id, u.text, u.progress, u.created_at, u.user_id, us.name AS user_name FROM task_updates u
    LEFT JOIN users us ON us.id = u.user_id WHERE u.task_id = ? ORDER BY u.id DESC LIMIT 200`, t.id);
  return t;
});

// --- hourly progress updates (collected silently, sent to the super admin as one digest per hour)
function addUpdate(taskId, userId, text, progress = null, digested = 0) {
  run('INSERT INTO task_updates (task_id, user_id, text, progress, digested, created_at) VALUES (?,?,?,?,?,?)', taskId, userId, text, progress, digested, now());
  if (progress !== null) run('UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?', progress, now(), taskId);
}
route('POST', '/api/tasks/:id/updates', ({ user, body, params }) => {
  const task = loadTask(params.id);
  if (!isAdmin(user) && !isAssignee(user, task.id)) fail(403, 'This task is not assigned to you');
  if (task.status === 'done') fail(400, 'This task is already done');
  const text = str(body.text, 2000);
  if (!text) fail(400, 'Write what you finished or what you are working on');
  const progress = body.progress === null || body.progress === undefined || body.progress === '' ? null
    : Math.max(0, Math.min(100, Math.round(Number(body.progress)) || 0));
  // Starting to report progress also moves the task to "In progress".
  if (task.status === 'todo') run("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?", now(), task.id);
  addUpdate(task.id, user.id, text, progress, isAdmin(user) ? 1 : 0);
  broadcast(['tasks', 'clients', 'updates']);
  return { ok: true };
});
route('GET', '/api/updates', ({ user, url }) => {
  const days = Math.min(Number(url.searchParams.get('days')) || 7, 60);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return all(`SELECT u.id, u.text, u.progress, u.created_at, u.task_id, us.name AS user_name, u.user_id,
      t.title AS task_title, t.status AS task_status, t.client_id, c.name AS client_name, c.color AS client_color, c.logo_key AS client_logo
    FROM task_updates u JOIN tasks t ON t.id = u.task_id LEFT JOIN users us ON us.id = u.user_id LEFT JOIN clients c ON c.id = t.client_id
    WHERE u.created_at >= ? ${isAdmin(user) ? '' : 'AND u.user_id = ?'} ORDER BY u.id DESC LIMIT 500`, since, ...(isAdmin(user) ? [] : [user.id]));
});
route('POST', '/api/updates/digest', ({ user }) => {
  requireAdmin(user);
  return { sent: sendDigest() };
});
route('GET', '/api/updates/schedule', () => ({ start: WORK_START, end: WORK_END, next: nextHour().toISOString() }));
route('POST', '/api/tasks', ({ user, body }) => {
  const title = str(body.title, 300);
  if (!title) fail(400, 'Task title is required');
  const admin = isAdmin(user);
  // Super admin MUST pick at least one employee. Employees can only add tasks to their own list.
  const assignees = admin ? validAssignees(body.assignees) : [user.id];
  const priority = PRIORITIES.includes(body.priority) ? body.priority : 'normal';
  const t = now();
  const id = tx(() => {
    const { lastInsertRowid } = run(`INSERT INTO tasks (client_id, title, description, deadline, priority, source, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, validClient(body.client_id), title, str(body.description, 20000), optDate(body.deadline),
    priority, admin ? 'admin' : 'self', user.id, t, t);
    const taskId = Number(lastInsertRowid);
    for (const uid of assignees) run('INSERT INTO task_assignees (task_id, user_id) VALUES (?,?)', taskId, uid);
    for (const m of body.materials || []) addMaterial('task', taskId, 'brief', m, user.id);
    if (body.note_id) run('UPDATE notes SET task_id = ?, updated_at = ? WHERE id = ? AND user_id = ?', taskId, t, Number(body.note_id), user.id);
    return taskId;
  });
  const task = fullTask(id);
  const where = task.client_name ? ` · ${task.client_name}` : '';
  if (admin) {
    notify(assignees.filter((u) => u !== user.id), { type: 'assigned', title: `New task: ${title}`, body: `Assigned by ${user.name}${where}`, task_id: id, client_id: task.client_id });
  } else {
    notify(adminIds(), { type: 'self_added', title: `${user.name} added a task`, body: `${title}${where}`, task_id: id, client_id: task.client_id });
  }
  broadcast(['tasks', 'clients', 'notes']);
  return task;
});
route('PATCH', '/api/tasks/:id', ({ user, body, params }) => {
  const task = loadTask(params.id);
  const admin = isAdmin(user);
  if (!admin && !(task.source === 'self' && task.created_by === user.id)) fail(403, 'Only the super admin can edit this task');
  const before = decorate([task])[0].assignees.map((a) => a.id);
  // Updating a task as super admin always requires (re)confirming its assignees.
  const assignees = admin ? validAssignees(body.assignees ?? before) : before;
  const title = 'title' in body ? str(body.title, 300) : task.title;
  if (!title) fail(400, 'Task title is required');
  tx(() => {
    run(`UPDATE tasks SET title=?, description=?, deadline=?, priority=?, client_id=?, updated_at=? WHERE id=?`,
      title, 'description' in body ? str(body.description, 20000) : task.description,
      'deadline' in body ? optDate(body.deadline) : task.deadline,
      PRIORITIES.includes(body.priority) ? body.priority : task.priority,
      'client_id' in body ? validClient(body.client_id) : task.client_id, now(), task.id);
    if (admin) {
      run('DELETE FROM task_assignees WHERE task_id = ?', task.id);
      for (const uid of assignees) run('INSERT INTO task_assignees (task_id, user_id) VALUES (?,?)', task.id, uid);
    }
    for (const m of body.materials || []) addMaterial('task', task.id, 'brief', m, user.id);
  });
  const updated = fullTask(task.id);
  const added = assignees.filter((u) => !before.includes(u) && u !== user.id);
  if (added.length) notify(added, { type: 'assigned', title: `New task: ${updated.title}`, body: `Assigned by ${user.name}${updated.client_name ? ` · ${updated.client_name}` : ''}`, task_id: task.id, client_id: updated.client_id });
  const others = assignees.filter((u) => before.includes(u) && u !== user.id);
  if (admin && others.length) notify(others, { type: 'updated', title: `Task updated: ${updated.title}`, body: `Updated by ${user.name}`, task_id: task.id, client_id: updated.client_id });
  broadcast(['tasks', 'clients']);
  return updated;
});
route('DELETE', '/api/tasks/:id', ({ user, params }) => {
  const task = loadTask(params.id);
  if (!isAdmin(user) && !(task.source === 'self' && task.created_by === user.id)) fail(403, 'Only the super admin can delete this task');
  tx(() => { deleteMaterialsOf('task', [task.id]); run('DELETE FROM tasks WHERE id = ?', task.id); });
  broadcast(['tasks', 'clients', 'notes']);
  return { ok: true };
});
route('POST', '/api/tasks/:id/status', ({ user, body, params }) => {
  const task = loadTask(params.id);
  if (!isAdmin(user) && !isAssignee(user, task.id)) fail(403, 'This task is not assigned to you');
  const status = body.status;
  if (!['todo', 'in_progress'].includes(status)) fail(400, 'Use the "Mark as done" button to finish a task');
  // Moving a done task back re-opens it and clears the completion stamp (completion materials are kept as history).
  run(`UPDATE tasks SET status = ?, completed_at = NULL, completed_by = NULL, completion_note = NULL, updated_at = ? WHERE id = ?`, status, now(), task.id);
  if (status === 'in_progress' && task.status !== 'in_progress') addUpdate(task.id, user.id, 'Started working on this', null, isAdmin(user) ? 1 : 0);
  if (task.status === 'done' && isAdmin(user)) {
    const ids = decorate([task])[0].assignees.map((a) => a.id).filter((u) => u !== user.id);
    notify(ids, { type: 'reopened', title: `Task reopened: ${task.title}`, body: `Reopened by ${user.name}`, task_id: task.id, client_id: task.client_id });
  }
  broadcast(['tasks', 'clients']);
  return fullTask(task.id);
});
route('POST', '/api/tasks/:id/complete', ({ user, body, params }) => {
  const task = loadTask(params.id);
  if (!isAdmin(user) && !isAssignee(user, task.id)) fail(403, 'This task is not assigned to you');
  if (task.status === 'done') fail(400, 'This task is already done');
  const at = now();
  tx(() => {
    for (const m of body.materials || []) addMaterial('task', task.id, 'completion', m, user.id);
    run(`UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ?, completion_note = ?, updated_at = ? WHERE id = ?`,
      at, user.id, str(body.note, 10000), at, task.id);
  });
  const done = fullTask(task.id);
  const files = done.materials.filter((m) => m.stage === 'completion').length;
  notify(adminIds().filter((u) => u !== user.id), {
    type: 'completed', title: `✅ ${user.name} completed a task`,
    body: `${task.title}${done.client_name ? ` · ${done.client_name}` : ''}${files ? ` · ${files} attachment${files > 1 ? 's' : ''}` : ''}`,
    task_id: task.id, client_id: task.client_id,
  });
  broadcast(['tasks', 'clients']);
  return done;
});
route('POST', '/api/tasks/:id/materials', ({ user, body, params }) => {
  const task = loadTask(params.id);
  if (!isAdmin(user) && !isAssignee(user, task.id)) fail(403, 'This task is not assigned to you');
  const stage = body.stage === 'completion' ? 'completion' : 'brief';
  tx(() => { for (const m of body.materials || [body]) addMaterial('task', task.id, stage, m, user.id); });
  broadcast(['tasks', 'clients']);
  return fullTask(task.id);
});

// --- notes (private to each user)
route('GET', '/api/notes', ({ user }) => all(`SELECT n.*, t.title AS task_title, t.status AS task_status FROM notes n
  LEFT JOIN tasks t ON t.id = n.task_id WHERE n.user_id = ? ORDER BY n.updated_at DESC`, user.id));
route('POST', '/api/notes', ({ user, body }) => {
  const content = str(body.content, 20000);
  if (!content) fail(400, 'Note is empty');
  const t = now();
  const { lastInsertRowid } = run('INSERT INTO notes (user_id, content, created_at, updated_at) VALUES (?,?,?,?)', user.id, content, t, t);
  broadcast(['notes'], [user.id]);
  return get('SELECT * FROM notes WHERE id = ?', Number(lastInsertRowid));
});
route('PATCH', '/api/notes/:id', ({ user, body, params }) => {
  const content = str(body.content, 20000);
  if (!content) fail(400, 'Note is empty');
  const r = run('UPDATE notes SET content = ?, updated_at = ? WHERE id = ? AND user_id = ?', content, now(), Number(params.id), user.id);
  if (!r.changes) fail(404, 'Note not found');
  broadcast(['notes'], [user.id]);
  return { ok: true };
});
route('DELETE', '/api/notes/:id', ({ user, params }) => {
  run('DELETE FROM notes WHERE id = ? AND user_id = ?', Number(params.id), user.id);
  broadcast(['notes'], [user.id]);
  return { ok: true };
});

// --- notifications + push
route('GET', '/api/notifications', ({ user }) => all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100', user.id));
route('POST', '/api/notifications/read', ({ user, body }) => {
  if (body.id) run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', Number(body.id), user.id);
  else run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', user.id);
  broadcast(['notifications'], [user.id]);
  return { ok: true };
});
route('GET', '/api/push/key', () => ({ key: vapid.publicKey }));
route('POST', '/api/push/subscribe', ({ user, body }) => {
  const sub = body.subscription;
  if (!sub?.endpoint) fail(400, 'Invalid subscription');
  run('INSERT OR REPLACE INTO push_subscriptions (endpoint, user_id, subscription, created_at) VALUES (?,?,?,?)',
    sub.endpoint, user.id, JSON.stringify(sub), now());
  return { ok: true };
});

route('POST', '/api/push/unsubscribe', ({ user, body }) => {
  run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', String(body.endpoint || ''), user.id);
  return { ok: true };
});

// --- overview for the super admin home screen
route('GET', '/api/overview', ({ user }) => {
  requireAdmin(user);
  const t = now();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const in3days = new Date(Date.now() + 3 * 86400000).toISOString();
  return {
    counts: get(`SELECT SUM(status = 'todo') AS todo, SUM(status = 'in_progress') AS in_progress,
      SUM(status != 'done' AND deadline < ?) AS overdue, SUM(status = 'done' AND completed_at >= ?) AS done_today,
      (SELECT COUNT(*) FROM clients) AS clients FROM tasks`, t, startOfDay.toISOString()),
    recent_done: decorate(all(`${TASK_SELECT} WHERE t.status = 'done' ORDER BY t.completed_at DESC LIMIT 8`)),
    due_soon: decorate(all(`${TASK_SELECT} WHERE t.status != 'done' AND t.deadline IS NOT NULL AND t.deadline <= ?
      ORDER BY t.deadline LIMIT 10`, in3days)),
    latest_updates: all(`SELECT u.id, u.text, u.progress, u.created_at, u.task_id, us.name AS user_name, u.user_id, t.title AS task_title,
      c.name AS client_name, c.color AS client_color, c.logo_key AS client_logo FROM task_updates u JOIN tasks t ON t.id = u.task_id
      LEFT JOIN users us ON us.id = u.user_id LEFT JOIN clients c ON c.id = t.client_id ORDER BY u.id DESC LIMIT 6`),
    team: all(`SELECT u.id, u.name,
      (SELECT COUNT(*) FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE ta.user_id = u.id AND t.status != 'done') AS open,
      (SELECT COUNT(*) FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE ta.user_id = u.id AND t.status != 'done' AND t.deadline < ?) AS overdue,
      (SELECT COUNT(*) FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE ta.user_id = u.id AND t.status = 'done' AND t.completed_at >= ?) AS done_week
      FROM users u WHERE u.role = 'employee' ORDER BY open DESC, u.name`, t, new Date(Date.now() - 7 * 86400000).toISOString()),
    client_deadlines: all(`SELECT d.*, c.name AS client_name, c.color AS client_color, c.logo_key AS client_logo FROM client_deadlines d
      JOIN clients c ON c.id = d.client_id WHERE d.done = 0 AND d.due_at <= ? ORDER BY d.due_at LIMIT 10`, in3days),
  };
});

// --- live stream
route('GET', '/api/stream', ({ user, req, res }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  if (!streams.has(user.id)) streams.set(user.id, new Set());
  streams.get(user.id).add(res);
  req.on('close', () => { streams.get(user.id)?.delete(res); });
  return undefined;
});

// ---------------------------------------------------------------- http plumbing
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'Upload too large (max ~40 MB per save)')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) fail(404, 'Not found');
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(r.re)[i + 1])]));
    let user = null, token = null;
    if (r.auth) {
      token = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('token') || '';
      user = token && get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', token);
      if (!user) fail(401, 'Please log in again');
    }
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const out = await r.handler({ req, res, url, params, body, user, token });
    if (out !== undefined) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    }
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong on the server' : err.message }));
  }
});

// ---------------------------------------------------------------- hourly digest + update reminders
// Every hour during work hours (server time, set TZ to your timezone):
//  1. the super admin gets ONE notification listing every progress update posted since the last digest;
//  2. employees with tasks "In progress" and no update in the last hour get a reminder to post one.
const WORK_START = Number(process.env.WORK_START ?? 9);   // first digest/reminder at 09:00
const WORK_END = Number(process.env.WORK_END ?? 20);      // last one at 20:00
const nextHour = () => { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d; };

function sendDigest() {
  const rows = all(`SELECT u.id, u.text, u.progress, us.name AS user_name, t.id AS task_id, t.title, c.name AS client_name
    FROM task_updates u JOIN tasks t ON t.id = u.task_id LEFT JOIN users us ON us.id = u.user_id LEFT JOIN clients c ON c.id = t.client_id
    WHERE u.digested = 0 ORDER BY u.id`);
  if (!rows.length) return 0;
  const tasks = new Map();
  for (const r of rows) tasks.set(r.task_id, r); // keep the latest update per task for the summary
  const lines = [...tasks.values()].map((r) => `${r.user_name || 'Someone'} · ${r.title}${r.client_name ? ` (${r.client_name})` : ''}: ${r.text}${r.progress !== null ? ` [${r.progress}%]` : ''}`);
  const body = lines.slice(0, 4).join('\n') + (lines.length > 4 ? `\n+ ${lines.length - 4} more` : '');
  run(`UPDATE task_updates SET digested = 1 WHERE id <= ? AND digested = 0`, rows[rows.length - 1].id);
  notify(adminIds(), {
    type: 'digest', title: `Hourly update · ${rows.length} update${rows.length > 1 ? 's' : ''} on ${tasks.size} task${tasks.size > 1 ? 's' : ''}`,
    body, url: '/#/updates',
  });
  broadcast(['updates']);
  return rows.length;
}
function sendReminders() {
  const cutoff = new Date(Date.now() - 55 * 60000).toISOString();
  const due = all(`SELECT ta.user_id, t.id, t.title FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id JOIN users u ON u.id = ta.user_id
    WHERE t.status = 'in_progress' AND u.role = 'employee'
      AND NOT EXISTS (SELECT 1 FROM task_updates x WHERE x.task_id = t.id AND x.created_at >= ?)`, cutoff);
  const byUser = new Map();
  for (const r of due) { if (!byUser.has(r.user_id)) byUser.set(r.user_id, []); byUser.get(r.user_id).push(r); }
  for (const [uid, list] of byUser) {
    notify([uid], {
      type: 'reminder', title: `Hourly update: ${list.length} task${list.length > 1 ? 's need' : ' needs'} an update`,
      body: list.slice(0, 3).map((t) => t.title).join(' · ') + (list.length > 3 ? ` +${list.length - 3} more` : ''),
      task_id: list.length === 1 ? list[0].id : null, url: list.length === 1 ? `/#/task/${list[0].id}` : '/#/tasks',
    });
  }
}
setInterval(() => {
  const d = new Date();
  const slot = `${d.toDateString()} ${d.getHours()}`;
  if (get("SELECT value FROM meta WHERE key = 'last_hourly'")?.value === slot) return;
  if (d.getHours() < WORK_START || d.getHours() > WORK_END) return;
  run("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_hourly', ?)", slot);
  try { sendDigest(); sendReminders(); } catch (err) { console.error('hourly job failed', err); }
}, 30000);

server.listen(PORT, () => console.log(`Digiteq Dashboard running at http://localhost:${PORT}`));

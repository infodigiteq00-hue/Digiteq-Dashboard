// Run against a disposable local Wrangler database: npm run dev, then npm run test:flow.
import assert from 'node:assert/strict';
const base = process.env.TEST_URL || 'http://localhost:8788';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname))
  throw new Error('Use a local, disposable test database');
const stamp = Date.now();
const adminName = process.env.TEST_ADMIN_USERNAME || 'smokeadmin';
const adminPassword = process.env.TEST_ADMIN_PASSWORD || 'local-smoke-password';
let checks = 0;
async function call(method, path, token, body, expected = 200) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
  checks++;
  return data;
}
const needs = await call('GET', '/api/setup');
const admin = needs.needsSetup
  ? await call('POST', '/api/setup', null, {
      name: 'Smoke Admin',
      username: adminName,
      password: adminPassword,
    })
  : await call('POST', '/api/login', null, { username: adminName, password: adminPassword });
const a = admin.token;
assert.equal(admin.user.role, 'superadmin');
await call('POST', '/api/setup', null, { name: 'Other', username: 'other', password: adminPassword }, 400);
await call('POST', '/api/login', null, { username: adminName, password: 'wrong' }, 401);
await call('GET', '/api/me', null, undefined, 401);
await call('PATCH', `/api/users/${admin.user.id}`, a, { role: 'employee' }, 400);
await call('DELETE', `/api/users/${admin.user.id}`, a, undefined, 400);
const people = [];
for (let i = 1; i <= 3; i++) {
  const username = `smoke${stamp}_${i}`;
  const u = await call('POST', '/api/users', a, {
    name: `Employee ${i}`,
    username,
    password: 'employee-password',
  });
  const session = await call('POST', '/api/login', null, { username, password: 'employee-password' });
  people.push({ ...u, token: session.token, username });
}
const [e1, e2, e3] = people;
await call('POST', '/api/users', e1.token, {}, 403);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const client = await call('POST', '/api/clients', a, {
  name: `Smoke Client ${stamp}`,
  logo: `data:image/png;base64,${png}`,
  color: '#4f46e5',
});
const logo = await fetch(`${base}/api/logos/${client.logo_key}`);
assert.equal(logo.status, 200);
assert.match(logo.headers.get('Cache-Control'), /immutable/);
assert.deepEqual(new Uint8Array(await logo.arrayBuffer()), Uint8Array.from(Buffer.from(png, 'base64')));
const initial = await call('GET', '/api/sync', a);
assert.deepEqual(initial.notifications, []);
await call('POST', '/api/tasks', a, { title: 'Missing assignee', client_id: client.id }, 400);
let task = await call('POST', '/api/tasks', a, {
  title: `Smoke Task ${stamp}`,
  client_id: client.id,
  assignees: [e1.id, e2.id],
  materials: [{ kind: 'link', title: 'Brief', url: 'example.com/brief' }],
});
assert.equal(task.assignees.length, 2);
assert.equal(task.materials[0].url, 'https://example.com/brief');
await call('PATCH', `/api/tasks/${task.id}`, a, { assignees: [] }, 400);
const oldNotifications = await call('GET', '/api/sync', e3.token);
await call('PATCH', `/api/tasks/${task.id}`, a, {
  title: `Updated smoke task ${stamp}`,
  assignees: [e1.id, e2.id, e3.id],
});
assert.ok(
  (await call('GET', '/api/sync?n=0', e1.token)).notifications.some(
    (n) => n.type === 'updated' && n.task_id === task.id,
  ),
);
assert.ok(
  (await call('GET', `/api/sync?n=${oldNotifications.last_id}`, e3.token)).notifications.some(
    (n) => n.type === 'assigned',
  ),
);
await call('PATCH', `/api/tasks/${task.id}`, e1.token, { title: 'Forbidden' }, 403);
const bytes = new Uint8Array([0, 1, 2, 127, 128, 255, 10, 65]);
async function upload(token, name = 'test bytes.bin') {
  const res = await fetch(base + '/api/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(name),
    },
    body: bytes,
  });
  const file = await res.json();
  assert.equal(res.status, 200, JSON.stringify(file));
  assert.equal(file.size, bytes.length);
  checks++;
  return { kind: 'file', ...file };
}
const file = await upload(a);
await call('POST', `/api/tasks/${task.id}/materials`, a, { materials: [file] });
await call(
  'POST',
  `/api/tasks/${task.id}/materials`,
  a,
  { materials: [{ kind: 'file', key: '../bad' }] },
  400,
);
await call(
  'POST',
  `/api/tasks/${task.id}/materials`,
  a,
  { materials: [{ kind: 'file', key: 'files/00000000-0000-0000-0000-000000000000' }] },
  400,
);
const beforeUpdate = (await call('GET', '/api/notifications', a)).length;
await call('POST', `/api/tasks/${task.id}/updates`, e1.token, { text: 'Figma file done', progress: 40 });
task = await call('GET', `/api/tasks/${task.id}`, e1.token);
assert.equal(task.status, 'in_progress');
assert.equal(task.progress, 40);
assert.equal((await call('GET', '/api/notifications', a)).length, beforeUpdate);
const digest = await call('POST', '/api/updates/digest', a, {});
assert.ok(digest.sent >= 1);
assert.equal(
  (await call('GET', '/api/notifications', a)).filter(
    (n) => n.type === 'digest' && n.body.includes(task.title),
  ).length,
  1,
);
assert.equal((await call('POST', '/api/updates/digest', a, {})).sent, 0);
await call('POST', '/api/updates/digest', e1.token, {}, 403);
const finished = await upload(e1.token, 'finished.bin');
const done = await call('POST', `/api/tasks/${task.id}/complete`, e1.token, {
  note: 'Finished',
  materials: [finished],
});
assert.equal(done.status, 'done');
assert.equal(done.completed_by, e1.id);
assert.ok(done.completed_at);
assert.ok(done.materials.some((m) => m.stage === 'completion'));
assert.ok(
  (await call('GET', '/api/notifications', a)).some((n) => n.type === 'completed' && n.task_id === task.id),
);
const attached = done.materials.find((m) => m.kind === 'file' && m.stage === 'brief');
const downloaded = await fetch(`${base}/api/files/${attached.id}?download=1`, {
  headers: { Authorization: `Bearer ${e2.token}` },
});
assert.equal(downloaded.status, 200);
assert.match(downloaded.headers.get('Content-Disposition'), /^attachment/);
assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), bytes);
const note = await call('POST', '/api/notes', e1.token, { content: 'Private conversion note' });
assert.ok(!(await call('GET', '/api/notes', e2.token)).some((n) => n.id === note.id));
await call('PATCH', `/api/notes/${note.id}`, e2.token, { content: 'Forbidden' }, 404);
const selfTask = await call('POST', '/api/tasks', e1.token, {
  title: 'From private note',
  note_id: note.id,
  assignees: [e2.id],
});
assert.equal(selfTask.source, 'self');
assert.deepEqual(
  selfTask.assignees.map((u) => u.id),
  [e1.id],
);
assert.equal((await call('GET', '/api/notes', e1.token)).find((n) => n.id === note.id).task_id, selfTask.id);
await call('GET', `/api/tasks/${selfTask.id}`, e2.token, undefined, 403);
const privateFile = await upload(e1.token);
const privateTask = await call('POST', `/api/tasks/${selfTask.id}/materials`, e1.token, {
  materials: [privateFile],
});
await call('GET', `/api/files/${privateTask.materials[0].id}`, e2.token, undefined, 403);
await call('POST', `/api/tasks/${selfTask.id}/status`, e1.token, { status: 'in_progress' });
assert.ok(
  (await call('GET', `/api/tasks/${selfTask.id}`, e1.token)).updates.some(
    (u) => u.text === 'Started working on this',
  ),
);
await call('POST', `/api/tasks/${selfTask.id}/status`, e2.token, { status: 'todo' }, 403);
const sync = await call('GET', `/api/sync?n=${initial.last_id}`, a);
assert.ok(sync.version > initial.version);
assert.ok(sync.notifications.some((n) => n.type === 'completed'));
assert.ok(sync.notifications.some((n) => n.type === 'self_added'));
assert.ok(sync.notifications.every((n, i, all) => i === 0 || all[i - 1].id < n.id));
await call('POST', '/api/notifications/read', a, {});
assert.equal((await call('GET', '/api/sync', a)).unread, 0);
const overview = await call('GET', '/api/overview', a);
assert.ok(overview.counts.done_today >= 1);
await call('GET', '/api/overview', e1.token, undefined, 403);
const schedule = await call('GET', '/api/updates/schedule', a);
assert.equal(schedule.start, 9);
assert.equal(schedule.end, 20);
assert.ok(new Date(schedule.next) > new Date());
assert.equal(
  new Intl.DateTimeFormat('en', { timeZone: 'Asia/Kolkata', minute: '2-digit' }).format(
    new Date(schedule.next),
  ),
  '0',
);
await call('GET', '/api/updates', a);
await call('GET', '/api/users', e1.token);
await call('POST', `/api/clients/${client.id}/deadlines`, a, {
  title: 'Launch',
  due_at: new Date(Date.now() + 86400000).toISOString(),
});
const detail = await call('GET', `/api/clients/${client.id}`, e1.token);
assert.ok(detail.tasks.length);
assert.ok(detail.deadlines.length);
await call('PATCH', `/api/deadlines/${detail.deadlines[0].id}`, a, { done: true });
await call('DELETE', `/api/deadlines/${detail.deadlines[0].id}`, a);
await call('POST', `/api/clients/${client.id}/materials`, a, { materials: [await upload(a)] });
await call('POST', `/api/clients/${client.id}/materials`, a, { materials: [] });
const keys = await Promise.all([call('GET', '/api/push/key', a), call('GET', '/api/push/key', e1.token)]);
assert.equal(keys[0].key, keys[1].key);
assert.equal(Buffer.from(keys[0].key, 'base64url').length, 65);
await call('POST', '/api/push/subscribe', e1.token, {
  subscription: { endpoint: 'https://example.com/local-test-only' },
});
await call('POST', '/api/push/unsubscribe', e1.token, { endpoint: 'https://example.com/local-test-only' });
await call('POST', '/api/cron/hourly', null, {}, 403);
await call('GET', '/api/stream', a, undefined, 404);
const otherLogin = await call('POST', '/api/login', null, {
  username: e2.username,
  password: 'employee-password',
});
await call('POST', '/api/me/password', e2.token, {
  current: 'employee-password',
  password: 'changed-password',
});
await call('GET', '/api/me', otherLogin.token, undefined, 401);
await call('GET', '/api/me', e2.token);
await call('POST', '/api/logout', e2.token, {});
await call('GET', '/api/me', e2.token, undefined, 401);
console.log(`Passed ${checks} API requests plus byte equality, role, notification, and schedule assertions.`);
console.log('Local smoke fixtures retained for browser checks. No production resources touched.');

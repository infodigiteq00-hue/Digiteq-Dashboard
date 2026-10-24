// Isolated, in-memory workerd tests: actual D1/R2 bindings and mocked push service.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { localParts, nextHour, startOfToday } from '../server/time.js';

const compiled = await build({
  stdin: {
    contents: `
  import { handle } from './server/api.js';
  const logError = console.error;
  console.error = (...args) => { if (!String(args[0]).includes('intentional test failure')) logError(...args); };
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-10-24T03:35:00Z'])); }
    static now() { return new RealDate('2026-10-24T03:35:00Z').getTime(); }
  };
  export default { fetch(request, env, ctx) { return handle({ request, env, waitUntil: (p) => ctx.waitUntil(p) }); } };
`,
    resolveDir: process.cwd(),
    sourcefile: 'runtime-test-worker.js',
  },
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
});
const script = compiled.outputFiles[0].text;
const opts = { modules: true, script, compatibilityDate: '2025-01-01', cf: false };
const instances = [];
const worker = (options) => {
  const mf = new Miniflare(convertV4MiniflareOptions({ ...opts, ...options }));
  instances.push(mf);
  return mf;
};
let assertions = 0;
async function call(mf, method, path, token, body, status = 200, headers = {}) {
  const res = await mf.dispatchFetch('http://localhost' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  assertions++;
  return data;
}
const setup = (mf) =>
  call(mf, 'POST', '/api/setup', null, { name: 'Test Admin', username: 'admin', password: 'password123' });
try {
  const missing = worker({});
  assert.match((await call(missing, 'GET', '/api/setup', null, undefined, 500)).error, /Missing DB.*README/);
  const noR2 = worker({ d1Databases: ['DB'] });
  const noR2Admin = await setup(noR2);
  for (const path of ['/api/files/1', '/api/logos/00000000-0000-0000-0000-000000000000.png']) {
    assert.match(
      (await call(noR2, 'GET', path, noR2Admin.token, undefined, 500)).error,
      /Missing FILES.*README/,
    );
  }
  const uploadMissing = await noR2.dispatchFetch('http://localhost/api/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${noR2Admin.token}` },
    body: 'bytes',
  });
  assert.equal(uploadMissing.status, 500);
  assert.match((await uploadMissing.json()).error, /Missing FILES/);
  assert.match(
    (
      await call(
        noR2,
        'POST',
        '/api/clients',
        noR2Admin.token,
        { name: 'Logo', logo: 'data:image/png;base64,YQ==' },
        500,
      )
    ).error,
    /Missing FILES/,
  );
  // Cron must refuse even an empty header when the secret is unset.
  await call(noR2, 'POST', '/api/cron/hourly', null, {}, 403, { 'x-cron-key': '' });

  const pushCalls = [];
  const outboundService = async (request) => {
    const url = new URL(request.url);
    assert.equal(url.hostname, 'push.example.test');
    assert.ok(request.headers.get('Authorization')?.startsWith('vapid '));
    assert.ok((await request.arrayBuffer()).byteLength > 100);
    pushCalls.push(url.pathname);
    return new Response('gone', { status: Number(url.pathname.slice(5)) });
  };
  const mf = worker({
    d1Databases: ['DB'],
    r2Buckets: ['FILES'],
    bindings: { CRON_SECRET: 'runtime-only-secret' },
    outboundService,
  });
  const firstRun = await Promise.all(
    ['admin', 'other'].map(async (username) => {
      const response = await mf.dispatchFetch('http://localhost/api/setup', {
        method: 'POST',
        body: JSON.stringify({ name: 'Test Admin', username, password: 'password123' }),
      });
      return { status: response.status, data: await response.json() };
    }),
  );
  assert.deepEqual(firstRun.map((r) => r.status).sort(), [200, 400]);
  const admin = firstRun.find((r) => r.status === 200).data,
    a = admin.token;
  const db = await mf.getD1Database('DB');
  const stored = await db.prepare('SELECT password_hash FROM users WHERE id = ?').bind(admin.user.id).first();
  assert.match(stored.password_hash, /^pbkdf2\$50000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.match(a, /^[0-9a-f]{64}$/);
  const e = await call(mf, 'POST', '/api/users', a, {
    name: 'Employee',
    username: 'employee',
    password: 'password123',
  });
  const eLogin = await call(mf, 'POST', '/api/login', null, {
    username: 'employee',
    password: 'password123',
  });
  const et = eLogin.token;
  const task = await call(mf, 'POST', '/api/tasks', a, { title: 'Cron progress', assignees: [e.id] });
  await call(mf, 'POST', `/api/tasks/${task.id}/updates`, et, { text: 'Halfway', progress: 50 });
  await call(mf, 'POST', '/api/cron/hourly', null, {}, 403, { 'x-cron-key': 'wrong' });
  // Concurrent cron invocations claim one local slot and produce one digest.
  await Promise.all(
    Array.from({ length: 4 }, () =>
      call(mf, 'POST', '/api/cron/hourly', null, {}, 200, { 'x-cron-key': 'runtime-only-secret' }),
    ),
  );
  assert.equal(
    (await db.prepare("SELECT value FROM meta WHERE key = 'last_hourly'").first()).value,
    '2026-10-24 9',
  );
  assert.equal((await call(mf, 'GET', '/api/notifications', a)).filter((n) => n.type === 'digest').length, 1);
  await call(mf, 'POST', `/api/tasks/${task.id}/updates`, et, { text: 'Another update', progress: 60 });
  await call(mf, 'POST', '/api/cron/hourly', null, {}, 200, { 'x-cron-key': 'runtime-only-secret' });
  assert.equal(
    (await db.prepare('SELECT digested FROM task_updates ORDER BY id DESC LIMIT 1').first()).digested,
    0,
  );
  const digests = await Promise.all([
    call(mf, 'POST', '/api/updates/digest', a, {}),
    call(mf, 'POST', '/api/updates/digest', a, {}),
  ]);
  assert.deepEqual(digests.map((d) => d.sent).sort(), [0, 1]);
  await call(mf, 'POST', `/api/tasks/${task.id}/updates`, a, { text: 'Admin note', progress: 65 });
  assert.equal((await call(mf, 'POST', '/api/updates/digest', a, {})).sent, 0);

  // The automatic hourly fallback runs via waitUntil and reminds stale employees.
  await db.batch([
    db.prepare("DELETE FROM meta WHERE key = 'last_hourly'"),
    db
      .prepare("UPDATE task_updates SET created_at = '2026-10-24T01:00:00.000Z' WHERE task_id = ?")
      .bind(task.id),
  ]);
  await call(mf, 'GET', '/api/sync', a);
  // A subsequent query waits for the background job to complete, bounded to 5 s.
  const deadline = Date.now() + 5000;
  let reminders = [];
  while (Date.now() < deadline) {
    reminders = (
      await db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'reminder'").bind(e.id).all()
    ).results;
    if (reminders.length) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(reminders.length, 1);

  // D1 batches roll back all task fields/assignees when any statement fails.
  const before = await call(mf, 'GET', `/api/tasks/${task.id}`, a);
  await db
    .prepare(
      `CREATE TRIGGER reject_test_material BEFORE INSERT ON materials WHEN NEW.title = 'trigger-failure'
    BEGIN SELECT RAISE(ABORT, 'intentional test failure'); END`,
    )
    .run();
  await call(
    mf,
    'PATCH',
    `/api/tasks/${task.id}`,
    a,
    {
      title: 'Must roll back',
      assignees: [admin.user.id],
      materials: [{ kind: 'link', title: 'trigger-failure', url: 'https://example.com' }],
    },
    500,
  );
  const after = await call(mf, 'GET', `/api/tasks/${task.id}`, a);
  assert.equal(after.title, before.title);
  assert.deepEqual(after.assignees, before.assignees);
  await call(
    mf,
    'POST',
    '/api/tasks',
    a,
    {
      title: 'No partial task',
      assignees: [e.id],
      materials: [{ kind: 'link', title: 'trigger-failure', url: 'https://example.com' }],
    },
    500,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'No partial task'").first()).n,
    0,
  );
  await db.prepare('DROP TRIGGER reject_test_material').run();

  // Keep the existing 1000-task list behavior below D1's parameter cap.
  for (let offset = 0; offset < 999; offset += 100) {
    await db.batch(
      Array.from({ length: Math.min(100, 999 - offset) }, (_, i) =>
        db
          .prepare('INSERT INTO tasks (title, created_at, updated_at) VALUES (?, ?, ?)')
          .bind(`Bulk ${offset + i}`, '2026-10-24T03:00:00.000Z', '2026-10-24T03:00:00.000Z'),
      ),
    );
  }
  assert.equal((await call(mf, 'GET', '/api/tasks?limit=1000', a)).length, 1000);
  const inserts = Array.from({ length: 25 }, (_, i) =>
    db
      .prepare(
        `INSERT INTO notifications (user_id, type, title, created_at) VALUES (?, 'test', ?, '2026-10-24T03:00:00.000Z')`,
      )
      .bind(e.id, `Backlog ${i}`),
  );
  await db.batch(inserts);
  let cursor = 0,
    seen = [];
  for (;;) {
    const page = await call(mf, 'GET', `/api/sync?n=${cursor}`, et);
    assert.ok(page.notifications.length <= 20);
    seen.push(...page.notifications);
    if (!page.notifications.length || page.notifications.at(-1).id === page.last_id) break;
    cursor = page.notifications.at(-1).id;
  }
  assert.equal(seen.filter((n) => n.type === 'test').length, 25);

  // R2 enforces actual material size; downloads and cascade deletion use R2 keys.
  const bucket = await mf.getR2Bucket('FILES');
  const key = 'files/00000000-0000-0000-0000-000000000001';
  await bucket.put(key, 'actual bytes');
  const withFile = await call(mf, 'POST', `/api/tasks/${task.id}/materials`, a, {
    materials: [{ kind: 'file', key, name: 'test.txt', size: 9999 }],
  });
  assert.equal(withFile.materials[0].size, 12);
  await call(mf, 'DELETE', `/api/materials/${withFile.materials[0].id}`, a);
  assert.equal(await bucket.head(key), null);
  const client = await call(mf, 'POST', '/api/clients', a, {
    name: 'Delete cascade',
    logo: 'data:image/png;base64,YQ==',
  });
  await bucket.put(key, 'actual bytes');
  const child = await call(mf, 'POST', '/api/tasks', a, {
    title: 'Child',
    client_id: client.id,
    assignees: [e.id],
    materials: [{ kind: 'file', key, name: 'test.txt' }],
  });
  const note = await call(mf, 'POST', '/api/notes', et, { content: 'Note stays' });
  await db.prepare('UPDATE notes SET task_id = ? WHERE id = ?').bind(child.id, note.id).run();
  await call(mf, 'DELETE', `/api/clients/${client.id}`, a);
  assert.equal(await bucket.head(key), null);
  assert.equal(await bucket.head(`logos/${client.logo_key}`), null);
  assert.equal(await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(child.id).first(), null);
  assert.equal(
    (await db.prepare('SELECT task_id FROM notes WHERE id = ?').bind(note.id).first()).task_id,
    null,
  );

  // Retire both 404 and 410 subscriptions after sending real encrypted Web Push.
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url');
  for (const status of [404, 410]) {
    const endpoint = `https://push.example.test/send${status}`;
    await call(mf, 'POST', '/api/push/subscribe', et, {
      subscription: {
        endpoint,
        keys: { p256dh, auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url') },
      },
    });
    await call(mf, 'PATCH', `/api/tasks/${task.id}`, a, { assignees: [e.id], title: `Push ${status}` });
    const until = Date.now() + 5000;
    let sub;
    do {
      sub = await db
        .prepare('SELECT endpoint FROM push_subscriptions WHERE endpoint = ?')
        .bind(endpoint)
        .first();
      if (!sub) break;
      await new Promise((r) => setTimeout(r, 20));
    } while (Date.now() < until);
    assert.equal(sub, null, `Expired ${status} subscription must be removed`);
  }
  assert.deepEqual(pushCalls, ['/send404', '/send410']);

  const oversized = await mf.dispatchFetch('http://localhost/api/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${a}`, 'Content-Length': String(26 * 1024 * 1024) },
    body: new Uint8Array(26 * 1024 * 1024),
  });
  assert.equal(oversized.status, 413);
  await db.batch(
    ['2026-10-23T19:00:00.000Z', '2026-10-23T18:00:00.000Z'].map((at) =>
      db
        .prepare(
          "INSERT INTO tasks (title, status, completed_at, created_at, updated_at) VALUES ('Date boundary', 'done', ?, ?, ?)",
        )
        .bind(at, at, at),
    ),
  );
  const overview = await call(mf, 'GET', '/api/overview', a);
  assert.equal(overview.counts.done_today, 1);
  const schedule = await call(mf, 'GET', '/api/updates/schedule', a);
  assert.equal(schedule.next, '2026-10-24T04:30:00.000Z');

  // Work hours are interpreted in the configured zone, not the runtime's UTC hour.
  const outside = worker({ d1Databases: ['DB'], bindings: { CRON_SECRET: 'secret', TIMEZONE: 'Etc/UTC' } });
  await setup(outside);
  await call(outside, 'POST', '/api/cron/hourly', null, {}, 200, { 'x-cron-key': 'secret' });
  assert.equal(
    await (
      await outside.getD1Database('DB')
    )
      .prepare("SELECT value FROM meta WHERE key = 'last_hourly'")
      .first(),
    null,
  );

  // Two simultaneous demotions must leave one super admin.
  const second = await call(mf, 'POST', '/api/users', a, {
    name: 'Second Admin',
    username: 'second',
    password: 'password123',
    role: 'superadmin',
  });
  const secondLogin = await call(mf, 'POST', '/api/login', null, {
    username: 'second',
    password: 'password123',
  });
  const demotions = await Promise.all(
    [
      [admin.user.id, a],
      [second.id, secondLogin.token],
    ].map(async ([id, token]) => {
      const res = await mf.dispatchFetch(`http://localhost/api/users/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role: 'employee' }),
      });
      return res.status;
    }),
  );
  assert.deepEqual(demotions.sort(), [200, 400]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'").first()).n, 1);

  // Date boundaries, fractional UTC offsets, and daylight-saving transitions.
  for (const [zone, input, midnight, next] of [
    ['Asia/Kolkata', '2026-10-24T00:10:00Z', '2026-10-23T18:30:00.000Z', '2026-10-24T00:30:00.000Z'],
    ['Asia/Kathmandu', '2026-10-24T00:10:00Z', '2026-10-23T18:15:00.000Z', '2026-10-24T00:15:00.000Z'],
    ['America/New_York', '2026-03-08T06:50:00Z', '2026-03-08T05:00:00.000Z', '2026-03-08T07:00:00.000Z'],
    ['America/New_York', '2026-11-01T05:50:00Z', '2026-11-01T04:00:00.000Z', '2026-11-01T06:00:00.000Z'],
  ]) {
    assert.equal(startOfToday(zone, new Date(input)).toISOString(), midnight);
    assert.equal(nextHour(zone, new Date(input)).toISOString(), next);
    assert.equal(localParts(zone, new Date(next)).minute, '00');
  }
  console.log(
    `Passed ${assertions} isolated Workers API requests plus binding, concurrency, cron, rollback, R2, push, pagination, and timezone assertions.`,
  );
} finally {
  await Promise.all(instances.map((mf) => mf.dispose()));
}

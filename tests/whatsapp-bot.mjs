// WhatsApp bot end-to-end test with a fake WAHA server (records what the bot sends, serves group names and media).
// Needs a FRESH local dashboard started with the bot settings, e.g.:
//   npx wrangler pages dev public --d1 DB --r2 FILES --compatibility-date=2025-01-01 --port 8790 --persist-to /tmp/bot-test \
//     --binding WAHA_URL=http://127.0.0.1:3990 --binding BOT_SECRET=test-bot-key --binding WAHA_API_KEY=test-waha-key
//   TEST_URL=http://localhost:8790 npm run test:bot
import http from 'node:http';

const base = process.env.TEST_URL || 'http://localhost:8790';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) throw new Error('Use a local, disposable test database');
const KEY = process.env.BOT_KEY || 'test-bot-key';
const OWNER = '919800000001', PRIYA = '919800000002', AMAN = '919800000003', CLIENT = '919811111111';
const GROUP = '120363000000000001@g.us';

// ---------------- fake WAHA
const sent = [];
const wahaServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.headers['x-api-key'] !== 'test-waha-key') { res.writeHead(401); return res.end(); }
    if (req.method === 'POST' && req.url === '/api/sendText') { sent.push(JSON.parse(body)); res.writeHead(201, { 'content-type': 'application/json' }); return res.end('{}'); }
    if (req.url.startsWith('/api/default/groups/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ subject: decodeURIComponent(req.url).includes(GROUP) ? 'Sunrise Team' : 'Some Other Group' }));
    }
    if (req.url.startsWith('/media/')) { res.writeHead(200, { 'content-type': req.url.endsWith('.ogg') ? 'audio/ogg' : 'image/jpeg' }); return res.end(Buffer.from('fake-media-bytes')); }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => wahaServer.listen(3990, '127.0.0.1', r));

let n = 0;
const ok = (c, m) => { n++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
const call = async (m, u, t, b, headers = {}) => {
  const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}), ...headers }, body: b ? JSON.stringify(b) : undefined });
  return [r.status, await r.json().catch(() => null)];
};
let msgSeq = 0;
const wa = (from, body, extra = {}) => ({
  event: 'message', session: 'default',
  payload: { id: `false_${from}_${++msgSeq}`, timestamp: Date.now() / 1000, from, fromMe: false, body, hasMedia: false, ...extra },
});
const group = (sender, body, extra = {}) => wa(GROUP, body, { participant: `${sender}@c.us`, _data: { notifyName: extra.name || 'Neha (client)' }, ...extra });
const inbound = (ev) => call('POST', '/api/bot/inbound', null, ev, { 'x-bot-key': KEY });
const tick = () => call('POST', '/api/bot/tick', null, { force: true }, { 'x-bot-key': KEY });
const lastTo = (phone) => [...sent].reverse().find((s) => s.chatId === `${phone}@c.us`)?.text || '';
const countTo = (phone) => sent.filter((s) => s.chatId === `${phone}@c.us`).length;

try {
  // ---------------- setup: owner, two employees with WhatsApp numbers, a client, a watched group
  let [s, d] = await call('GET', '/api/setup');
  if (!d.needsSetup) throw new Error('Start this test against a FRESH database (see the top of this file)');
  [s, d] = await call('POST', '/api/setup', null, { name: 'Rahul Owner', username: 'owner', password: 'owner-pass-1' });
  const O = d.token;
  await call('POST', '/api/me/phone', O, { phone: `+${OWNER}` });
  [s, d] = await call('POST', '/api/users', O, { name: 'Priya Sharma', username: 'priya', password: 'priya-pass-1', phone: PRIYA });
  const priyaId = d.id;
  [s, d] = await call('POST', '/api/users', O, { name: 'Aman Verma', username: 'aman', password: 'aman-pass-1', phone: `+91 98000 00003` });
  ok(s === 200 && d.phone === AMAN, 'WhatsApp number saved (spaces and + removed)');
  [s] = await call('POST', '/api/users', O, { name: 'Dup', username: 'dup', password: 'dup-pass-1', phone: PRIYA });
  ok(s === 400, 'duplicate WhatsApp number rejected');
  [s, d] = await call('POST', '/api/clients', O, { name: 'Sunrise Bakery' });
  const clientId = d.id;
  [s] = await call('POST', '/api/bot/config', O, { enabled: true, buffer_seconds: 60, groups: [{ name: 'sunrise team', client_id: clientId }] });
  ok(s === 200, 'owner saves watched group (name match is case-insensitive)');
  [s] = await call('POST', '/api/bot/inbound', null, group(CLIENT, 'hi'), { 'x-bot-key': 'wrong' });
  ok(s === 403, 'wrong bot key refused');

  // ---------------- 1. a task typed in several messages + photo + link → owner is asked privately
  await inbound(group(CLIENT, 'Hi team, please design a Diwali post for Instagram'));
  await inbound(group(CLIENT, 'use orange and gold colours. reference https://example.com/brand-kit'));
  const photoMsg = group(CLIENT, '', { hasMedia: true, media: { url: 'http://127.0.0.1:3990/media/ref.jpg', mimetype: 'image/jpeg' } });
  await inbound(photoMsg);
  ok(countTo(OWNER) === 0, 'nothing sent while the client is still typing');
  await tick();
  let ask = lastTo(OWNER);
  ok(/New task #\d+/.test(ask) && /Diwali post/i.test(ask) && /orange and gold/i.test(ask), 'owner gets ONE private message with the whole multi-message task');
  ok(/1 file · 1 link/.test(ask), 'attachment summary shows the photo and the link');
  ok(sent.every((x) => x.chatId !== GROUP), 'bot never posts in the group');
  const taskItem = Number(ask.match(/#(\d+)/)[1]);

  // owner replies privately with a name + deadline
  await inbound(wa(`${OWNER}@c.us`, 'priya tomorrow'));
  let [, tasks] = await call('GET', '/api/tasks', O);
  let t = tasks.find((x) => /Diwali/i.test(x.title));
  ok(t && t.assignees.length === 1 && t.assignees[0].id === priyaId, 'task created and assigned to Priya');
  ok(t && /^Please design a Diwali post/.test(t.title), `greeting dropped from the title (“${t?.title}”)`);
  ok(t && t.client_id === clientId && t.deadline, 'task linked to the group’s client with a deadline');
  let [, full] = await call('GET', `/api/tasks/${t.id}`, O);
  ok(full.materials.some((m) => m.kind === 'file' && m.mime === 'image/jpeg') && full.materials.some((m) => m.kind === 'link'), 'photo and link saved on the task');
  ok(/Added \*.*Diwali/i.test(lastTo(OWNER)), 'owner gets a confirmation');
  ok(/New task for you/.test(lastTo(PRIYA)), 'Priya is told on WhatsApp');

  // ---------------- 2. chatter is ignored
  const before = sent.length;
  await inbound(group(CLIENT, 'ok thanks 👍'));
  await tick();
  ok(sent.length === before, '“ok thanks 👍” is ignored');

  // ---------------- 3. duplicate delivery ignored
  const dupe = group(CLIENT, 'Please also make a story version');
  await inbound(dupe); await inbound(dupe); await tick();
  ask = lastTo(OWNER);
  const storyItem = Number(ask.match(/#(\d+)/)[1]);
  ok(/story version/i.test(ask) && sent.filter((x) => /story version/i.test(x.text)).length === 1, 'duplicate webhook delivery creates only one question');

  // ---------------- 4. two open questions → owner must say which one
  await inbound(group(CLIENT, 'Need a new banner for the website homepage please'));
  await tick();
  const bannerItem = Number(lastTo(OWNER).match(/#(\d+)/)[1]);
  await inbound(wa(`${OWNER}@c.us`, 'aman'));
  ok(/start your reply with the number/i.test(lastTo(OWNER)), 'ambiguous reply → bot asks for the number');
  await inbound(wa(`${OWNER}@c.us`, `${storyItem} skip`));
  ok(/Ignored #/.test(lastTo(OWNER)), 'owner can skip a task');
  await inbound(wa(`${OWNER}@c.us`, `${bannerItem} Aman, Priya friday`));
  [, tasks] = await call('GET', '/api/tasks', O);
  const banner = tasks.find((x) => /banner/i.test(x.title));
  ok(banner && banner.assignees.length === 2, 'assign to two people with one reply');

  // ---------------- 5. employee says done in the group (reply to the original message) → private confirm → YES
  await inbound(group(PRIYA, 'Diwali post done ✅', { name: 'Priya', replyTo: { id: `false_${GROUP}_1` } }));
  await inbound(group(PRIYA, '', { name: 'Priya', hasMedia: true, media: { url: 'http://127.0.0.1:3990/media/final.jpg', mimetype: 'image/jpeg' } }));
  await tick();
  ask = lastTo(PRIYA);
  ok(/Should I mark \*[^*]*Diwali[^*]*\*.* as \*done\*/i.test(ask) && /1 file/.test(ask), 'Priya is asked privately to confirm, with her file');
  await inbound(wa(`${PRIYA}@c.us`, 'yes'));
  [, full] = await call('GET', `/api/tasks/${t.id}`, O);
  ok(full.status === 'done' && full.completed_by_name === 'Priya Sharma', 'task marked done by Priya');
  ok(full.materials.some((m) => m.stage === 'completion' && m.kind === 'file'), 'her file saved as finished work');
  let [, notes] = await call('GET', '/api/notifications', O);
  ok(notes.some((x) => x.type === 'completed'), 'owner notified that it is done');

  // ---------------- 6. change request on that task → owner asked → yes → added + reopened + assignee told
  await inbound(group(CLIENT, 'Small change in the diwali post: make the background blue instead'));
  await tick();
  ask = lastTo(OWNER);
  ok(/Change request #\d+/.test(ask) && /Diwali/i.test(ask), 'owner asked privately about the change');
  const changeItem = Number(ask.match(/#(\d+)/)[1]);
  await inbound(wa(`${OWNER}@c.us`, `${changeItem} yes`));
  [, full] = await call('GET', `/api/tasks/${t.id}`, O);
  ok(/background blue/i.test(full.description) && full.status !== 'done', 'change added to the task and task reopened');
  ok(/Change for your task/.test(lastTo(PRIYA)), 'Priya told about the change');

  // ---------------- 7. employee reports work that was never on the dashboard → add + mark done
  await inbound(wa(`${AMAN}@c.us`, 'Nova fitness logo resize done'));
  ask = lastTo(AMAN);
  ok(/couldn’t find this in your tasks|Which task did you finish/i.test(ask), 'Aman asked whether to add it as a new task');
  await inbound(wa(`${AMAN}@c.us`, /Which task/.test(ask) ? '0' : 'yes'));
  [, tasks] = await call('GET', '/api/tasks', O);
  const added = tasks.find((x) => /logo resize/i.test(x.title));
  ok(added && added.status === 'done' && added.source === 'self', 'new self-added task created and marked done');

  // ---------------- 8. voice note task
  await inbound(group(CLIENT, '', { hasMedia: true, media: { url: 'http://127.0.0.1:3990/media/note.ogg', mimetype: 'audio/ogg; codecs=opus' } }));
  await tick();
  ok(/New task #\d+/.test(lastTo(OWNER)) && /1 file/.test(lastTo(OWNER)), 'voice note becomes a task question with the audio attached');

  // ---------------- 9. strangers can’t talk to the bot privately; unwatched groups ignored
  const b2 = sent.length;
  await inbound(wa('919899999999@c.us', 'mark everything done'));
  await inbound(wa('120363000000000999@g.us', 'please do this', { participant: `${CLIENT}@c.us` }));
  await tick();
  ok(sent.length === b2, 'strangers’ DMs and unwatched groups are ignored');

  const [, cfg] = await call('GET', '/api/bot/config', O);
  ok(cfg.recent.length >= 5 && cfg.status.waha && cfg.status.secret, 'bot page shows status and recent activity');
  console.log(`${n} checks`);
  if (process.env.DEBUG) for (const x of sent) console.log(`--> ${x.chatId}\n${x.text}\n`);
} finally {
  wahaServer.close();
}

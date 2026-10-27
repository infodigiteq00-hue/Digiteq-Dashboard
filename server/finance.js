// Owner-only money module: commercials (what each client pays), invoices + payments (receivables / client dues)
// and business opportunities (sales pipeline). Every route here requires an owner.

export const FINANCE_SCHEMA = `;
CREATE TABLE IF NOT EXISTS commercials (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT NOT NULL, billing TEXT NOT NULL DEFAULT 'one_time' CHECK (billing IN ('one_time','monthly','quarterly','yearly')),
  amount REAL NOT NULL DEFAULT 0, start_date TEXT, end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','paused','ended')),
  notes TEXT, file_key TEXT, file_name TEXT, mime TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commercials_client ON commercials(client_id);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  commercial_id INTEGER REFERENCES commercials(id) ON DELETE SET NULL,
  number TEXT, title TEXT NOT NULL, amount REAL NOT NULL, issue_date TEXT NOT NULL, due_date TEXT NOT NULL,
  period TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled')), notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invoices_client ON invoices(client_id);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_period ON invoices(commercial_id, period) WHERE period IS NOT NULL;
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount REAL NOT NULL, paid_on TEXT NOT NULL, method TEXT, reference TEXT, note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_invoice ON payments(invoice_id);
CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, company TEXT, contact_person TEXT, email TEXT, phone TEXT,
  source TEXT, service TEXT, value REAL NOT NULL DEFAULT 0, probability INTEGER NOT NULL DEFAULT 10,
  stage TEXT NOT NULL DEFAULT 'lead' CHECK (stage IN ('lead','contacted','proposal','negotiation','won','lost')),
  expected_close TEXT, next_follow_up TEXT, notes TEXT, lost_reason TEXT,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
)`;

const BILLING = ['one_time', 'monthly', 'quarterly', 'yearly'];
const COMMERCIAL_STATUS = ['draft', 'active', 'paused', 'ended'];
const STAGES = ['lead', 'contacted', 'proposal', 'negotiation', 'won', 'lost'];
const STAGE_PROBABILITY = { lead: 10, contacted: 25, proposal: 50, negotiation: 75, won: 100, lost: 0 };
const DUE_DAYS = 15;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const addDays = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function registerFinance(h) {
  const { route, all, get, run, stmt, DB, fail, files, str, now, isOwner, ownerIds, notify, broadcast, TIMEZONE, localParts } = h;
  const fmt = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: h.currency || 'INR', maximumFractionDigits: 2 }).format(n);
  const requireOwner = (u) => { if (!isOwner(u)) fail(403, 'Only owners can see finance'); };
  const today = () => { const p = localParts(TIMEZONE); return `${p.year}-${p.month}-${p.day}`; };
  const money = (v, label = 'Amount') => {
    const n = round2(v);
    if (!Number.isFinite(n) || n < 0) fail(400, `${label} must be a positive number`);
    return n;
  };
  const date = (v, label, required = false) => {
    if (v === null || v === undefined || v === '') { if (required) fail(400, `${label} is required`); return null; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) fail(400, `${label} is not a valid date`);
    return String(v);
  };
  const pick = (body, existing, key, fn) => (key in body ? fn(body[key]) : existing?.[key] ?? fn(undefined));
  async function validClient(id) {
    const c = await get('SELECT id FROM clients WHERE id = ?', Number(id));
    if (!c) fail(400, 'Choose a client');
    return c.id;
  }

  // ---------------------------------------------------------------- invoices
  const INVOICE_SELECT = `SELECT i.*, c.name AS client_name, c.color AS client_color, c.logo_key AS client_logo,
      cm.title AS commercial_title, COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid
    FROM invoices i JOIN clients c ON c.id = i.client_id LEFT JOIN commercials cm ON cm.id = i.commercial_id`;
  // Adds paid / balance / state ('paid' | 'partial' | 'due' | 'overdue' | 'cancelled') computed against today's local date.
  function withState(inv, t = today()) {
    inv.paid = round2(inv.paid);
    inv.balance = inv.status === 'cancelled' ? 0 : round2(Math.max(0, inv.amount - inv.paid));
    inv.state = inv.status === 'cancelled' ? 'cancelled'
      : inv.balance <= 0 ? 'paid'
        : inv.due_date < t ? 'overdue'
          : inv.paid > 0 ? 'partial' : 'due';
    inv.days_overdue = inv.state === 'overdue' ? Math.round((new Date(`${t}T00:00:00Z`) - new Date(`${inv.due_date}T00:00:00Z`)) / 86400000) : 0;
    return inv;
  }
  async function invoices(where = '', ...p) {
    const t = today();
    return (await all(`${INVOICE_SELECT} ${where} ORDER BY i.due_date DESC, i.id DESC`, ...p)).map((i) => withState(i, t));
  }
  async function loadInvoice(id) {
    const inv = await get(`${INVOICE_SELECT} WHERE i.id = ?`, Number(id));
    if (!inv) fail(404, 'Invoice not found');
    return withState(inv);
  }
  async function nextNumber() {
    const y = today().slice(0, 4);
    const row = await get("SELECT COUNT(*) AS n FROM invoices WHERE number LIKE ?", `INV-${y}-%`);
    return `INV-${y}-${String(row.n + 1).padStart(4, '0')}`;
  }
  async function invoiceFields(body, existing) {
    const client_id = 'client_id' in body || !existing ? await validClient(body.client_id) : existing.client_id;
    let commercial_id = pick(body, existing, 'commercial_id', (v) => (v ? Number(v) : null));
    if (commercial_id && !(await get('SELECT 1 FROM commercials WHERE id = ? AND client_id = ?', commercial_id, client_id))) commercial_id = null;
    const title = pick(body, existing, 'title', (v) => str(v ?? '', 300));
    if (!title) fail(400, 'Invoice title is required');
    const amount = pick(body, existing, 'amount', (v) => money(v));
    if (!(amount > 0)) fail(400, 'Amount must be more than 0');
    const issue_date = pick(body, existing, 'issue_date', (v) => date(v, 'Invoice date') || today());
    const due_date = pick(body, existing, 'due_date', (v) => date(v, 'Due date') || addDays(issue_date, DUE_DAYS));
    if (due_date < issue_date) fail(400, 'Due date cannot be before the invoice date');
    return {
      client_id, commercial_id, title, amount, issue_date, due_date,
      number: pick(body, existing, 'number', (v) => str(v ?? '', 50)) || null,
      notes: pick(body, existing, 'notes', (v) => str(v ?? '', 5000)),
    };
  }
  route('GET', '/api/finance/invoices', async ({ user, url }) => {
    requireOwner(user);
    const client = url.searchParams.get('client');
    return client ? invoices('WHERE i.client_id = ?', Number(client)) : invoices();
  });
  route('GET', '/api/finance/invoices/:id', async ({ user, params }) => {
    requireOwner(user);
    const inv = await loadInvoice(params.id);
    inv.payments = await all(`SELECT p.*, u.name AS created_by_name FROM payments p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.invoice_id = ? ORDER BY p.paid_on DESC, p.id DESC`, inv.id);
    return inv;
  });
  route('POST', '/api/finance/invoices', async ({ user, body }) => {
    requireOwner(user);
    const f = await invoiceFields(body);
    const t = now();
    const r = await run(`INSERT INTO invoices (client_id, commercial_id, number, title, amount, issue_date, due_date, notes, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, f.client_id, f.commercial_id, f.number || (await nextNumber()), f.title, f.amount,
    f.issue_date, f.due_date, f.notes, user.id, t, t);
    await broadcast();
    return loadInvoice(r.meta.last_row_id);
  });
  route('PATCH', '/api/finance/invoices/:id', async ({ user, body, params }) => {
    requireOwner(user);
    const existing = await loadInvoice(params.id);
    const f = await invoiceFields(body, existing);
    const status = 'status' in body ? (body.status === 'cancelled' ? 'cancelled' : 'open') : existing.status;
    if (f.amount + 0.005 < existing.paid) fail(400, 'Amount cannot be less than what has already been paid');
    await run(`UPDATE invoices SET client_id=?, commercial_id=?, number=?, title=?, amount=?, issue_date=?, due_date=?, notes=?, status=?, updated_at=? WHERE id=?`,
      f.client_id, f.commercial_id, f.number || existing.number, f.title, f.amount, f.issue_date, f.due_date, f.notes, status, now(), existing.id);
    await broadcast();
    return loadInvoice(existing.id);
  });
  route('DELETE', '/api/finance/invoices/:id', async ({ user, params }) => {
    requireOwner(user);
    await run('DELETE FROM invoices WHERE id = ?', Number(params.id));
    await broadcast();
    return { ok: true };
  });
  route('POST', '/api/finance/invoices/:id/payments', async ({ user, body, params }) => {
    requireOwner(user);
    const inv = await loadInvoice(params.id);
    if (inv.status === 'cancelled') fail(400, 'This invoice is cancelled');
    const amount = money(body.amount);
    if (!(amount > 0)) fail(400, 'Payment must be more than 0');
    if (amount > inv.balance + 0.005) fail(400, `Payment is more than the balance due (${fmt(inv.balance)})`);
    await run('INSERT INTO payments (invoice_id, amount, paid_on, method, reference, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
      inv.id, amount, date(body.paid_on, 'Payment date') || today(), str(body.method, 40), str(body.reference, 120), str(body.note, 2000), user.id, now());
    const after = await loadInvoice(inv.id);
    await notify((await ownerIds()).filter((id) => id !== user.id), {
      type: 'payment', title: `💰 Payment received: ${after.client_name}`,
      body: `${fmt(amount)} on ${after.number || after.title}${after.state === 'paid' ? ' · fully paid' : ` · ${fmt(after.balance)} still due`} · recorded by ${user.name}`,
      client_id: after.client_id, url: '/#/receivables',
    });
    await broadcast();
    return after;
  });
  route('DELETE', '/api/finance/payments/:id', async ({ user, params }) => {
    requireOwner(user);
    await run('DELETE FROM payments WHERE id = ?', Number(params.id));
    await broadcast();
    return { ok: true };
  });

  // ---------------------------------------------------------------- commercials
  const COMMERCIAL_SELECT = `SELECT cm.*, c.name AS client_name, c.color AS client_color, c.logo_key AS client_logo,
      (SELECT COUNT(*) FROM invoices i WHERE i.commercial_id = cm.id AND i.status = 'open') AS invoice_count,
      (SELECT COALESCE(SUM(i.amount), 0) FROM invoices i WHERE i.commercial_id = cm.id AND i.status = 'open') AS invoiced
    FROM commercials cm JOIN clients c ON c.id = cm.client_id`;
  async function loadCommercial(id) {
    const c = await get(`${COMMERCIAL_SELECT} WHERE cm.id = ?`, Number(id));
    if (!c) fail(404, 'Commercial not found');
    return c;
  }
  async function commercialFields(body, existing) {
    const client_id = 'client_id' in body || !existing ? await validClient(body.client_id) : existing.client_id;
    const title = pick(body, existing, 'title', (v) => str(v ?? '', 300));
    if (!title) fail(400, 'Give the commercial a name, e.g. “Social media retainer”');
    const billing = pick(body, existing, 'billing', (v) => (BILLING.includes(v) ? v : 'one_time'));
    const status = pick(body, existing, 'status', (v) => (COMMERCIAL_STATUS.includes(v) ? v : 'active'));
    const start_date = pick(body, existing, 'start_date', (v) => date(v, 'Start date'));
    const end_date = pick(body, existing, 'end_date', (v) => date(v, 'End date'));
    if (start_date && end_date && end_date < start_date) fail(400, 'End date cannot be before the start date');
    let file = existing ? { file_key: existing.file_key, file_name: existing.file_name, mime: existing.mime } : { file_key: null, file_name: null, mime: null };
    if (body.file === null) file = { file_key: null, file_name: null, mime: null };
    else if (body.file) {
      const key = String(body.file.key || '');
      if (!/^files\/[0-9a-f-]{36}$/.test(key)) fail(400, 'Invalid file');
      const obj = await files().head(key);
      if (!obj) fail(400, 'Uploaded file not found');
      file = { file_key: key, file_name: str(body.file.name, 200) || 'contract', mime: str(body.file.type, 100) || obj.httpMetadata?.contentType || 'application/octet-stream' };
    }
    return {
      client_id, title, billing, status, start_date, end_date, ...file,
      amount: pick(body, existing, 'amount', (v) => money(v ?? 0)),
      notes: pick(body, existing, 'notes', (v) => str(v ?? '', 5000)),
    };
  }
  route('GET', '/api/finance/commercials', async ({ user, url }) => {
    requireOwner(user);
    const client = url.searchParams.get('client');
    return all(`${COMMERCIAL_SELECT} ${client ? 'WHERE cm.client_id = ?' : ''}
      ORDER BY CASE cm.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, c.name COLLATE NOCASE, cm.id DESC`,
    ...(client ? [Number(client)] : []));
  });
  route('POST', '/api/finance/commercials', async ({ user, body }) => {
    requireOwner(user);
    const f = await commercialFields(body);
    const t = now();
    const r = await run(`INSERT INTO commercials (client_id, title, billing, amount, start_date, end_date, status, notes, file_key, file_name, mime, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, f.client_id, f.title, f.billing, f.amount, f.start_date, f.end_date, f.status, f.notes,
    f.file_key, f.file_name, f.mime, user.id, t, t);
    await broadcast();
    return loadCommercial(r.meta.last_row_id);
  });
  route('PATCH', '/api/finance/commercials/:id', async ({ user, body, params }) => {
    requireOwner(user);
    const existing = await loadCommercial(params.id);
    const f = await commercialFields(body, existing);
    await run(`UPDATE commercials SET client_id=?, title=?, billing=?, amount=?, start_date=?, end_date=?, status=?, notes=?, file_key=?, file_name=?, mime=?, updated_at=? WHERE id=?`,
      f.client_id, f.title, f.billing, f.amount, f.start_date, f.end_date, f.status, f.notes, f.file_key, f.file_name, f.mime, now(), existing.id);
    if (existing.file_key && existing.file_key !== f.file_key) await files().delete(existing.file_key);
    await broadcast();
    return loadCommercial(existing.id);
  });
  route('DELETE', '/api/finance/commercials/:id', async ({ user, params }) => {
    requireOwner(user);
    const existing = await loadCommercial(params.id);
    await run('DELETE FROM commercials WHERE id = ?', existing.id);
    if (existing.file_key) await files().delete(existing.file_key);
    await broadcast();
    return { ok: true };
  });
  route('GET', '/api/finance/commercials/:id/file', async ({ user, params }) => {
    requireOwner(user);
    const c = await loadCommercial(params.id);
    if (!c.file_key) fail(404, 'No file attached');
    const obj = await files().get(c.file_key);
    if (!obj) fail(404, 'File missing on server');
    return new Response(obj.body, {
      headers: {
        'Content-Type': c.mime || 'application/octet-stream', 'Content-Length': String(obj.size),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(c.file_name || 'contract')}`,
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'",
      },
    });
  });
  // Raise this period's invoices for every active recurring commercial (safe to press twice: one invoice per period).
  route('POST', '/api/finance/commercials/generate', async ({ user, body }) => {
    requireOwner(user);
    const period = String(body.period || today().slice(0, 7));
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) fail(400, 'Choose a month');
    const first = `${period}-01`;
    const last = addDays(addDays(first, 32).slice(0, 7) + '-01', -1);
    const list = await all(`SELECT * FROM commercials WHERE status = 'active' AND billing IN ('monthly','quarterly','yearly')
      AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?) AND amount > 0`, last, first);
    const month = Number(period.slice(5));
    const due = (c) => {
      if (c.billing === 'monthly') return true;
      const startMonth = c.start_date ? Number(c.start_date.slice(5, 7)) : month;
      return c.billing === 'quarterly' ? (month - startMonth + 12) % 3 === 0 : month === startMonth;
    };
    const label = new Date(`${first}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const issue = first > today() ? first : today() < last ? today() : first;
    const y = period.slice(0, 4);
    const base = (await get("SELECT COUNT(*) AS n FROM invoices WHERE number LIKE ?", `INV-${y}-%`)).n;
    const t = now();
    const statements = list.filter(due).map((c, i) => stmt(`INSERT OR IGNORE INTO invoices
      (client_id, commercial_id, number, title, amount, issue_date, due_date, period, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, c.client_id, c.id, `INV-${y}-${String(base + i + 1).padStart(4, '0')}`,
    `${c.title} — ${label}`, c.amount, issue, addDays(issue, DUE_DAYS), period, user.id, t, t));
    const results = statements.length ? await DB.batch(statements) : [];
    const created = results.reduce((n, r) => n + (r.meta.changes || 0), 0);
    if (created) await broadcast();
    return { created, skipped: statements.length - created, period };
  });

  // ---------------------------------------------------------------- opportunities (sales pipeline)
  const OPP_SELECT = `SELECT o.*, u.name AS owner_name, c.name AS client_name FROM opportunities o
    LEFT JOIN users u ON u.id = o.owner_id LEFT JOIN clients c ON c.id = o.client_id`;
  async function loadOpp(id) {
    const o = await get(`${OPP_SELECT} WHERE o.id = ?`, Number(id));
    if (!o) fail(404, 'Opportunity not found');
    return o;
  }
  function oppFields(body, existing) {
    const name = pick(body, existing, 'name', (v) => str(v ?? '', 200));
    if (!name) fail(400, 'Give the opportunity a name');
    const stage = pick(body, existing, 'stage', (v) => (STAGES.includes(v) ? v : 'lead'));
    const stageChanged = !existing || stage !== existing.stage;
    let probability = 'probability' in body ? Math.max(0, Math.min(100, Math.round(Number(body.probability)) || 0))
      : stageChanged ? STAGE_PROBABILITY[stage] : existing.probability;
    if (stage === 'won') probability = 100;
    if (stage === 'lost') probability = 0;
    const s = (k, max = 200) => pick(body, existing, k, (v) => str(v ?? '', max));
    return {
      name, stage, probability,
      company: s('company'), contact_person: s('contact_person'), email: s('email'), phone: s('phone', 50),
      source: s('source', 60), service: s('service'), notes: s('notes', 10000), lost_reason: s('lost_reason', 1000),
      value: pick(body, existing, 'value', (v) => money(v ?? 0, 'Value')),
      expected_close: pick(body, existing, 'expected_close', (v) => date(v, 'Expected close date')),
      next_follow_up: pick(body, existing, 'next_follow_up', (v) => date(v, 'Follow-up date')),
      closed_at: ['won', 'lost'].includes(stage) ? (stageChanged ? now() : existing.closed_at) : null,
    };
  }
  route('GET', '/api/finance/opportunities', async ({ user }) => {
    requireOwner(user);
    return all(`${OPP_SELECT} ORDER BY o.stage IN ('won','lost'), o.next_follow_up IS NULL, o.next_follow_up, o.updated_at DESC`);
  });
  route('POST', '/api/finance/opportunities', async ({ user, body }) => {
    requireOwner(user);
    const f = oppFields(body);
    const t = now();
    const r = await run(`INSERT INTO opportunities (name, company, contact_person, email, phone, source, service, value, probability, stage,
      expected_close, next_follow_up, notes, lost_reason, owner_id, created_at, updated_at, closed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    f.name, f.company, f.contact_person, f.email, f.phone, f.source, f.service, f.value, f.probability, f.stage,
    f.expected_close, f.next_follow_up, f.notes, f.lost_reason, user.id, t, t, f.closed_at);
    await broadcast();
    return loadOpp(r.meta.last_row_id);
  });
  route('PATCH', '/api/finance/opportunities/:id', async ({ user, body, params }) => {
    requireOwner(user);
    const existing = await loadOpp(params.id);
    const f = oppFields(body, existing);
    await run(`UPDATE opportunities SET name=?, company=?, contact_person=?, email=?, phone=?, source=?, service=?, value=?, probability=?, stage=?,
      expected_close=?, next_follow_up=?, notes=?, lost_reason=?, closed_at=?, updated_at=? WHERE id=?`,
    f.name, f.company, f.contact_person, f.email, f.phone, f.source, f.service, f.value, f.probability, f.stage,
    f.expected_close, f.next_follow_up, f.notes, f.lost_reason, f.closed_at, now(), existing.id);
    await broadcast();
    return loadOpp(existing.id);
  });
  route('DELETE', '/api/finance/opportunities/:id', async ({ user, params }) => {
    requireOwner(user);
    await run('DELETE FROM opportunities WHERE id = ?', Number(params.id));
    await broadcast();
    return { ok: true };
  });
  // Won deal → becomes a client (keeps contact details) so work and invoices can start.
  route('POST', '/api/finance/opportunities/:id/convert', async ({ user, params }) => {
    requireOwner(user);
    const o = await loadOpp(params.id);
    let clientId = o.client_id;
    if (!clientId) {
      const t = now();
      const r = await run(`INSERT INTO clients (name, contact_person, email, phone, details, color, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
        o.company || o.name, o.contact_person, o.email, o.phone,
        [o.service && `Service: ${o.service}`, o.notes].filter(Boolean).join('\n\n'), '#059669', t, t);
      clientId = r.meta.last_row_id;
    }
    await run(`UPDATE opportunities SET stage = 'won', probability = 100, client_id = ?, closed_at = COALESCE(closed_at, ?), updated_at = ? WHERE id = ?`,
      clientId, now(), now(), o.id);
    await broadcast();
    return { client_id: clientId, opportunity: await loadOpp(o.id) };
  });

  // ---------------------------------------------------------------- summaries
  async function financeSummary() {
    const t = today();
    const open = await invoices("WHERE i.status = 'open'");
    const outstanding = round2(open.reduce((n, i) => n + i.balance, 0));
    const overdue = round2(open.filter((i) => i.state === 'overdue').reduce((n, i) => n + i.balance, 0));
    return { outstanding, overdue, overdue_count: open.filter((i) => i.state === 'overdue').length, today: t };
  }
  async function clientFinance(clientId) {
    const inv = await invoices('WHERE i.client_id = ?', clientId);
    const live = inv.filter((i) => i.status === 'open');
    return {
      commercials: await all(`${COMMERCIAL_SELECT} WHERE cm.client_id = ? ORDER BY cm.status = 'ended', cm.id DESC`, clientId),
      invoices: inv,
      totals: {
        invoiced: round2(live.reduce((n, i) => n + i.amount, 0)),
        paid: round2(live.reduce((n, i) => n + i.paid, 0)),
        due: round2(live.reduce((n, i) => n + i.balance, 0)),
        overdue: round2(live.filter((i) => i.state === 'overdue').reduce((n, i) => n + i.balance, 0)),
      },
    };
  }
  route('GET', '/api/finance/overview', async ({ user }) => {
    requireOwner(user);
    const t = today();
    const month = t.slice(0, 7);
    const all_ = await invoices("WHERE i.status = 'open'");
    const open = all_.filter((i) => i.balance > 0);
    const byClient = new Map();
    for (const i of all_) {
      const c = byClient.get(i.client_id) || { client_id: i.client_id, name: i.client_name, color: i.client_color, logo_key: i.client_logo, invoiced: 0, paid: 0, balance: 0, overdue: 0, oldest_due: null };
      c.invoiced += i.amount; c.paid += i.paid; c.balance += i.balance;
      if (i.state === 'overdue') { c.overdue += i.balance; if (!c.oldest_due || i.due_date < c.oldest_due) c.oldest_due = i.due_date; }
      byClient.set(i.client_id, c);
    }
    const dues = [...byClient.values()].filter((c) => c.balance > 0)
      .map((c) => ({ ...c, invoiced: round2(c.invoiced), paid: round2(c.paid), balance: round2(c.balance), overdue: round2(c.overdue) }))
      .sort((a, b) => b.overdue - a.overdue || b.balance - a.balance);
    const collected = await get('SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE paid_on >= ?', `${month}-01`);
    const invoicedMonth = await get("SELECT COALESCE(SUM(amount), 0) AS n FROM invoices WHERE status = 'open' AND issue_date >= ?", `${month}-01`);
    const recurring = await all("SELECT billing, amount FROM commercials WHERE status = 'active' AND billing IN ('monthly','quarterly','yearly') AND (end_date IS NULL OR end_date >= ?)", t);
    const mrr = round2(recurring.reduce((n, c) => n + (c.billing === 'monthly' ? c.amount : c.billing === 'quarterly' ? c.amount / 3 : c.amount / 12), 0));
    const opps = await all("SELECT stage, value, probability, closed_at FROM opportunities");
    const openOpps = opps.filter((o) => !['won', 'lost'].includes(o.stage));
    return {
      today: t,
      totals: {
        outstanding: round2(open.reduce((n, i) => n + i.balance, 0)),
        overdue: round2(open.filter((i) => i.state === 'overdue').reduce((n, i) => n + i.balance, 0)),
        overdue_count: open.filter((i) => i.state === 'overdue').length,
        collected_month: round2(collected.n),
        invoiced_month: round2(invoicedMonth.n),
        mrr,
        pipeline: round2(openOpps.reduce((n, o) => n + o.value, 0)),
        pipeline_weighted: round2(openOpps.reduce((n, o) => n + (o.value * o.probability) / 100, 0)),
        open_deals: openOpps.length,
        won_month: round2(opps.filter((o) => o.stage === 'won' && (o.closed_at || '') >= `${month}-01`).reduce((n, o) => n + o.value, 0)),
      },
      dues,
      upcoming: open.sort((a, b) => (a.due_date < b.due_date ? -1 : 1)).slice(0, 10),
      followups: await all(`${OPP_SELECT} WHERE o.stage NOT IN ('won','lost') AND o.next_follow_up IS NOT NULL AND o.next_follow_up <= ?
        ORDER BY o.next_follow_up LIMIT 10`, addDays(t, 3)),
      recent_payments: await all(`SELECT p.*, i.number, i.title, c.name AS client_name, c.color AS client_color, c.logo_key AS client_logo
        FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = i.client_id ORDER BY p.paid_on DESC, p.id DESC LIMIT 8`),
    };
  });

  // Morning message for owners: money overdue + follow-ups due today.
  async function sendFinanceAlert() {
    const s = await financeSummary();
    const follow = (await get(`SELECT COUNT(*) AS n FROM opportunities WHERE stage NOT IN ('won','lost') AND next_follow_up IS NOT NULL AND next_follow_up <= ?`, s.today)).n;
    if (!s.overdue_count && !follow) return;
    await notify(await ownerIds(), {
      type: 'finance', title: 'Today’s money check',
      body: [s.overdue_count ? `${s.overdue_count} overdue invoice${s.overdue_count > 1 ? 's' : ''} (${fmt(s.overdue)})` : '',
        follow ? `${follow} sales follow-up${follow > 1 ? 's' : ''} due` : ''].filter(Boolean).join(' · '),
      url: '/#/finance',
    });
  }

  return { clientFinance, financeSummary, sendFinanceAlert };
}

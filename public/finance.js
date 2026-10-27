// Owner-only Finance screens: overview, receivables (invoices + payments = client dues), commercials and the sales pipeline.
// app.js passes in its helpers via registerFinance(); everything here is only reachable for owners.
let A; // app helpers

const money = (n, compact = false) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: A.S.currency || 'INR',
  ...(compact ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: Number.isInteger(Math.round((+n || 0) * 100) / 100) ? 0 : 2 }),
}).format(+n || 0);
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const addDays = (ymd, days) => { const d = new Date(`${ymd}T00:00:00`); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtDate = (ymd) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtMonth = (ymd) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '');
const clientOf = (x) => ({ name: x.client_name, color: x.client_color, logo_key: x.client_logo });

const STATE = { paid: ['Paid', 'green'], partial: ['Part paid', 'blue'], due: ['Due', 'amber'], overdue: ['Overdue', 'red'], cancelled: ['Cancelled', ''] };
const BILLING = { one_time: 'One-time', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };
const PER = { one_time: '', monthly: ' / month', quarterly: ' / quarter', yearly: ' / year' };
const CSTATUS = { active: ['Active', 'green'], draft: ['Draft', ''], paused: ['Paused', 'amber'], ended: ['Ended', ''] };
const STAGES = { lead: 'Lead', contacted: 'Contacted', proposal: 'Proposal sent', negotiation: 'Negotiation', won: 'Won', lost: 'Lost' };
const OPEN_STAGES = ['lead', 'contacted', 'proposal', 'negotiation'];
const METHODS = ['Bank transfer', 'UPI', 'Cash', 'Cheque', 'Card', 'Other'];
const SOURCES = ['Referral', 'Website', 'Instagram', 'LinkedIn', 'Facebook', 'Cold call', 'Existing client', 'Other'];

const stateChip = (i) => `<span class="chip ${STATE[i.state][1]}">${STATE[i.state][0]}</span>`;
const finTabs = (active) => `<div class="tabs">${[['finance', 'Overview'], ['receivables', 'Receivables'], ['commercials', 'Commercials'], ['pipeline', 'Opportunities']]
  .map(([k, l]) => `<button class="${k === active ? 'on' : ''}" data-act="nav" data-to="${k}">${l}</button>`).join('')}</div>`;
const statCard = (label, value, tone, icon, act = '', extra = '') => `<button class="stat ${tone}" ${act}>
  <div class="ico">${A.ic(icon)}</div><div><b class="num">${value}</b><span>${label}</span>${extra}</div></button>`;

function invoiceRow(i, { showClient = true } = {}) {
  const late = i.state === 'overdue';
  return `<div class="fin-row" data-act="openInvoice" data-id="${i.id}" role="button" tabindex="0">
    ${showClient ? A.logo(clientOf(i), 'sm') : `<div class="mat-icon file" style="width:28px;height:28px">${A.ic('file')}</div>`}
    <div class="grow"><div class="strong ellipsis">${A.esc(i.title)}</div>
      <div class="meta"><span>${A.esc(i.number || '')}</span>${showClient ? `<span class="client">${A.esc(i.client_name)}</span>` : ''}
        <span class="${late ? 'red' : ''}">${A.ic('calendar')}${i.state === 'paid' ? 'Paid' : `Due ${fmtDate(i.due_date)}`}${late ? ` · ${i.days_overdue} d late` : ''}</span></div></div>
    <div class="amt"><b class="num">${money(i.state === 'paid' || i.state === 'cancelled' ? i.amount : i.balance)}</b>
      <div class="tiny muted">${i.paid > 0 && i.balance > 0 ? `of ${money(i.amount)}` : i.state === 'paid' ? 'received' : i.state === 'cancelled' ? 'cancelled' : 'due'}</div></div>
    ${stateChip(i)}
  </div>`;
}
function commercialRow(c, { showClient = true } = {}) {
  const [label, tone] = CSTATUS[c.status];
  return `<div class="fin-row" data-act="editCommercial" data-id="${c.id}" role="button" tabindex="0">
    ${showClient ? A.logo(clientOf(c), 'sm') : `<div class="mat-icon" style="width:28px;height:28px">${A.ic('briefcase')}</div>`}
    <div class="grow"><div class="strong ellipsis">${A.esc(c.title)}</div>
      <div class="meta">${showClient ? `<span class="client">${A.esc(c.client_name)}</span>` : ''}<span>${BILLING[c.billing]}</span>
        ${c.start_date ? `<span>${A.ic('calendar')}${fmtMonth(c.start_date)}${c.end_date ? ` – ${fmtMonth(c.end_date)}` : ' onwards'}</span>` : ''}
        ${c.invoice_count ? `<span>${A.plural(c.invoice_count, 'invoice')}</span>` : ''}${c.file_key ? `<span>${A.ic('clip')}Contract</span>` : ''}</div></div>
    <div class="amt"><b class="num">${money(c.amount)}</b><div class="tiny muted">${PER[c.billing] ? PER[c.billing].slice(3) : 'total'}</div></div>
    <span class="chip ${tone}">${label}</span>
  </div>`;
}
function dealCard(o) {
  const t = todayStr();
  const follow = o.next_follow_up && !['won', 'lost'].includes(o.stage);
  return `<div class="task deal" data-act="openDeal" data-id="${o.id}" role="button" tabindex="0" ${OPEN_STAGES.includes(o.stage) && !A.isMobile() ? 'draggable="true" data-kind="deal"' : ''}>
    <div class="task-main">
      <div class="task-title">${A.esc(o.name)}</div>
      <div class="meta">${o.company ? `<span class="client">${A.esc(o.company)}</span>` : ''}${o.service ? `<span>${A.esc(o.service)}</span>` : ''}
        ${follow ? `<span class="${o.next_follow_up <= t ? 'red' : ''}">${A.ic('phone')}Follow up ${fmtDate(o.next_follow_up)}</span>` : ''}
        ${o.stage === 'lost' && o.lost_reason ? `<span>${A.esc(o.lost_reason)}</span>` : ''}</div>
    </div>
    <div class="amt"><b class="num">${money(o.value)}</b><div class="tiny muted">${o.stage === 'won' ? '<span class="chip green">Won</span>' : o.stage === 'lost' ? '<span class="chip red">Lost</span>' : `${o.probability}% likely`}</div></div>
  </div>`;
}

// ------------------------------------------------------------------ views
function overviewHtml(o) {
  const t = o.totals;
  return `${finTabs('finance')}
    <div class="stats">
      ${statCard('Outstanding', money(t.outstanding, true), '', 'inbox', 'data-act="finGo" data-to="receivables" data-filter="open"')}
      ${statCard('Overdue', money(t.overdue, true), t.overdue ? 'tone-red' : '', 'alert', 'data-act="finGo" data-to="receivables" data-filter="overdue"', t.overdue_count ? `<span class="tiny">${A.plural(t.overdue_count, 'invoice')}</span>` : '')}
      ${statCard('Collected this month', money(t.collected_month, true), 'tone-green', 'check', 'data-act="finGo" data-to="receivables" data-filter="paid"')}
      ${statCard('Monthly recurring', money(t.mrr, true), 'tone-blue', 'undo', 'data-act="nav" data-to="commercials"')}
      ${statCard('Pipeline (likely)', money(t.pipeline_weighted, true), 'tone-amber', 'arrow', 'data-act="nav" data-to="pipeline"', `<span class="tiny">${A.plural(t.open_deals, 'open deal')}</span>`)}
    </div>
    <div class="cols">
      <div>
        <div class="section"><div class="section-head"><h2 class="grow">Client dues</h2><span class="small muted">who owes what</span></div>
          ${o.dues.length ? `<div class="card list">${o.dues.map((d) => {
    const pct = d.invoiced ? Math.round((d.paid / d.invoiced) * 100) : 0;
    return `<div class="list-item click" data-act="clientFinance" data-id="${d.client_id}">
              ${A.logo(d, 'sm')}
              <div class="grow"><div class="row between"><b class="ellipsis">${A.esc(d.name)}</b><b class="num nowrap">${money(d.balance)}</b></div>
                <div class="progress" style="margin-top:6px;--c:var(--green)"><i style="width:${pct}%"></i></div>
                <div class="tiny muted" style="margin-top:4px">${money(d.paid)} paid of ${money(d.invoiced)}${d.overdue ? ` · <span style="color:var(--red);font-weight:600">${money(d.overdue)} overdue since ${fmtDate(d.oldest_due)}</span>` : ''}</div></div>
            </div>`;
  }).join('')}</div>` : `<div class="card">${A.empty('check', 'No dues', 'Every client is fully paid up.')}</div>`}</div>
        <div class="section"><div class="section-head"><h2 class="grow">Coming due & overdue</h2><button class="btn ghost sm" data-act="nav" data-to="receivables">All invoices ${A.ic('arrow')}</button></div>
          ${o.upcoming.length ? `<div class="fin-list">${o.upcoming.map((i) => invoiceRow(i)).join('')}</div>` : `<div class="card">${A.empty('inbox', 'Nothing due', 'Create an invoice or generate this month’s retainers.', '<button class="btn primary" data-act="newInvoice">New invoice</button>')}</div>`}</div>
      </div>
      <div>
        <div class="section"><div class="section-head"><h2 class="grow">Sales follow-ups</h2><button class="btn ghost sm" data-act="nav" data-to="pipeline">Pipeline ${A.ic('arrow')}</button></div>
          ${o.followups.length ? `<div class="task-list">${o.followups.map(dealCard).join('')}</div>` : `<div class="card">${A.empty('phone', 'No follow-ups due', 'Set a follow-up date on an opportunity and it shows here.')}</div>`}</div>
        <div class="section"><div class="section-head"><h2 class="grow">Recent payments</h2></div>
          <div class="card">${o.recent_payments.length ? `<div class="list">${o.recent_payments.map((p) => `
            <div class="list-item click" data-act="openInvoice" data-id="${p.invoice_id}">${A.logo(clientOf(p), 'sm')}
              <div class="grow"><div class="strong ellipsis">${A.esc(p.client_name)}</div><div class="tiny muted">${fmtDate(p.paid_on)} · ${A.esc(p.method || 'Payment')} · ${A.esc(p.number || p.title)}</div></div>
              <b class="num" style="color:var(--green)">+${money(p.amount)}</b></div>`).join('')}</div>` : A.empty('check', 'No payments yet', 'Record payments on invoices as they arrive.')}</div></div>
        <div class="section"><div class="card pad">
          <div class="row between"><span class="muted small">Invoiced this month</span><b class="num">${money(t.invoiced_month)}</b></div>
          <div class="row between" style="margin-top:8px"><span class="muted small">Deals won this month</span><b class="num">${money(t.won_month)}</b></div>
          <div class="row between" style="margin-top:8px"><span class="muted small">Total open pipeline</span><b class="num">${money(t.pipeline)}</b></div>
        </div></div>
      </div>
    </div>`;
}

function receivablesHtml({ invoices, clients }) {
  const u = A.S.ui;
  const q = (u.finSearch || '').toLowerCase();
  let list = invoices;
  if (u.finClient) list = list.filter((i) => String(i.client_id) === u.finClient);
  if (q) list = list.filter((i) => [i.title, i.number, i.client_name].some((v) => (v || '').toLowerCase().includes(q)));
  const groups = {
    open: list.filter((i) => i.balance > 0), overdue: list.filter((i) => i.state === 'overdue'),
    paid: list.filter((i) => i.state === 'paid'), cancelled: list.filter((i) => i.state === 'cancelled'), all: list,
  };
  const labels = { open: 'Due', overdue: 'Overdue', paid: 'Paid', cancelled: 'Cancelled', all: 'All' };
  const f = groups[u.finFilter] ? u.finFilter : 'open';
  const shown = f === 'open' ? [...groups.open].sort((a, b) => (a.due_date < b.due_date ? -1 : 1)) : groups[f];
  const total = shown.reduce((n, i) => n + (f === 'paid' ? i.amount : i.balance), 0);
  return `${finTabs('receivables')}
    <div class="tabs" style="border:0;margin-bottom:10px">${Object.keys(groups).map((k) => `<button class="${f === k ? 'on' : ''}" data-act="finFilter" data-v="${k}">${labels[k]}<span class="n">${groups[k].length}</span></button>`).join('')}</div>
    <div class="toolbar">
      <div class="search">${A.ic('search')}<input class="input" data-keep="fin-search" data-on-input="finSearch" placeholder="Search invoices…" value="${A.esc(u.finSearch || '')}"></div>
      <select class="input" data-on-change="finClient"><option value="">All clients</option>${clients.map((c) => `<option value="${c.id}" ${u.finClient === String(c.id) ? 'selected' : ''}>${A.esc(c.name)}</option>`).join('')}</select>
      <span class="grow"></span>${f !== 'all' && f !== 'cancelled' && shown.length ? `<b class="num">${money(total)}</b><span class="small muted">${f === 'paid' ? 'received' : 'to collect'}</span>` : ''}
    </div>
    ${shown.length ? `<div class="fin-list">${shown.map((i) => invoiceRow(i)).join('')}</div>`
    : `<div class="card">${A.empty('inbox', f === 'overdue' ? 'Nothing overdue 🎉' : 'No invoices here', invoices.length ? 'Try another tab or filter.' : 'Create your first invoice, or add a monthly commercial and generate invoices from it.', invoices.length ? '' : '<button class="btn primary" data-act="newInvoice">New invoice</button>')}</div>`}`;
}

function commercialsHtml({ commercials }) {
  const thisMonth = todayStr().slice(0, 7);
  const recurring = commercials.filter((c) => c.status === 'active' && c.billing !== 'one_time');
  return `${finTabs('commercials')}
    ${recurring.length ? `<form class="banner" data-submit="generateInvoices"><div class="ico">${A.ic('spark')}</div>
      <div class="grow"><b>Raise retainer invoices</b><div class="small muted">Creates one invoice per active monthly / quarterly / yearly commercial for the chosen month. Pressing twice won’t duplicate.</div></div>
      <input class="input" type="month" name="period" value="${thisMonth}" style="width:auto"><button class="btn primary sm">Generate</button></form>` : ''}
    ${commercials.length ? ['active', 'draft', 'paused', 'ended'].map((st) => {
    const list = commercials.filter((c) => c.status === st);
    return list.length ? `<div class="sub-head">${CSTATUS[st][0]} · ${list.length}</div><div class="fin-list">${list.map((c) => commercialRow(c)).join('')}</div>` : '';
  }).join('') : `<div class="card">${A.empty('file', 'No commercials yet', 'Record what each client pays: one-time projects or monthly retainers, with the signed quote or contract.', '<button class="btn primary" data-act="newCommercial">New commercial</button>')}</div>`}`;
}

function pipelineHtml(opps) {
  const t = todayStr();
  const open = opps.filter((o) => OPEN_STAGES.includes(o.stage));
  const closed = opps.filter((o) => !OPEN_STAGES.includes(o.stage));
  const value = open.reduce((n, o) => n + o.value, 0), weighted = open.reduce((n, o) => n + (o.value * o.probability) / 100, 0);
  const won = closed.filter((o) => o.stage === 'won');
  const head = `${finTabs('pipeline')}
    <div class="chips" style="margin-bottom:14px"><span class="chip blue">${A.plural(open.length, 'open deal')} · ${money(value)}</span>
      <span class="chip amber">Likely ${money(weighted)}</span><span class="chip green">Won ${won.length} · ${money(won.reduce((n, o) => n + o.value, 0))}</span>
      ${open.filter((o) => o.next_follow_up && o.next_follow_up <= t).length ? `<span class="chip red">${A.ic('phone')}${open.filter((o) => o.next_follow_up && o.next_follow_up <= t).length} follow-ups due</span>` : ''}</div>`;
  let body;
  if (A.isMobile()) {
    if (!A.S.ui.dealStagePicked && !opps.some((o) => o.stage === A.S.ui.dealStage)) A.S.ui.dealStage = OPEN_STAGES.find((k) => opps.some((o) => o.stage === k)) || 'lead';
    const st = A.S.ui.dealStage;
    const list = opps.filter((o) => o.stage === st);
    body = `<div class="tabs">${Object.keys(STAGES).map((k) => `<button class="${st === k ? 'on' : ''}" data-act="dealStage" data-v="${k}">${STAGES[k]}<span class="n">${opps.filter((o) => o.stage === k).length}</span></button>`).join('')}</div>
      ${list.length ? `<div class="task-list">${list.map(dealCard).join('')}</div>` : `<div class="card">${A.empty('arrow', 'Nothing here', 'Add a lead with the + button.')}</div>`}`;
  } else {
    body = `<div class="board deals">${OPEN_STAGES.map((k) => {
      const list = open.filter((o) => o.stage === k);
      return `<div class="col" data-col="${k}"><div class="col-head">${STAGES[k]}<span class="n">${list.length}</span></div>
        <div class="tiny muted" style="padding:0 14px 8px;margin-top:-6px">${money(list.reduce((n, o) => n + o.value, 0))}</div>
        <div class="col-body">${list.map(dealCard).join('') || '<div class="col-empty">Drop a deal here</div>'}</div></div>`;
    }).join('')}</div>
    ${closed.length ? `<div class="sub-head">Closed · ${closed.length}</div><div class="task-list">${closed.map(dealCard).join('')}</div>` : ''}`;
  }
  return head + (opps.length ? body : `<div class="card">${A.empty('arrow', 'No opportunities yet', 'Track every lead from first call to signed deal. Won deals become clients in one click.', '<button class="btn primary" data-act="newDeal">New opportunity</button>')}</div>`);
}

// Finance tab on a client's page (owners only).
export function clientFinanceTab(c) {
  const f = c.finance, t = f.totals;
  return `<div class="stats" style="margin-bottom:18px">
      ${statCard('Invoiced', money(t.invoiced, true), '', 'file')}${statCard('Received', money(t.paid, true), 'tone-green', 'check')}
      ${statCard('Due', money(t.due, true), 'tone-amber', 'inbox')}${statCard('Overdue', money(t.overdue, true), t.overdue ? 'tone-red' : '', 'alert')}
    </div>
    <div class="section-head"><h2 class="grow">Commercials</h2><button class="btn sm" data-act="newCommercial" data-client="${c.id}">${A.ic('plus')} Add</button></div>
    ${f.commercials.length ? `<div class="fin-list">${f.commercials.map((x) => commercialRow(x, { showClient: false })).join('')}</div>` : '<div class="muted small">No commercials yet — add the quote, retainer or contract for this client.</div>'}
    <div class="section-head" style="margin-top:24px"><h2 class="grow">Invoices</h2><button class="btn primary sm" data-act="newInvoice" data-client="${c.id}">${A.ic('plus')} New invoice</button></div>
    ${f.invoices.length ? `<div class="fin-list">${f.invoices.map((i) => invoiceRow(i, { showClient: false })).join('')}</div>` : '<div class="muted small">No invoices yet.</div>'}`;
}
// Money banner on the Overview page (owners only).
export function financeBanner(s) {
  if (!s.outstanding) return '';
  return `<div class="banner ${s.overdue ? 'red' : ''}" data-act="nav" data-to="finance" style="cursor:pointer"><div class="ico">${A.ic('inbox')}</div>
    <div class="grow"><b>${money(s.outstanding)} due from clients</b><div class="small muted">${s.overdue ? `${money(s.overdue)} is overdue (${A.plural(s.overdue_count, 'invoice')})` : 'Nothing overdue'} · tap for finance</div></div>${A.ic('arrow')}</div>`;
}

// ------------------------------------------------------------------ sheets & forms
async function openInvoice(id) {
  const m = A.openModal({ title: 'Invoice', wide: true, body: '<div class="empty"><div class="spinner" style="margin:auto"></div></div>' });
  m.refresh = async () => {
    let i;
    try { i = await A.api('GET', `/api/finance/invoices/${id}`); } catch (err) { if (err.status === 404) { A.closeModalObj(m); A.toast('This invoice was deleted', 'bad'); return; } throw err; }
    m.data.invoice = i;
    m.setTitle(i.number || 'Invoice');
    m.setHead(`<button type="button" class="icon-btn" data-act="editInvoice" aria-label="Edit" title="Edit">${A.ic('edit')}</button>
      <button type="button" class="icon-btn" data-act="delInvoice" aria-label="Delete" title="Delete">${A.ic('trash')}</button>`);
    m.setBody(`<div class="chips">${stateChip(i)}${i.commercial_title ? `<span class="chip">${A.esc(i.commercial_title)}</span>` : ''}</div>
      <h2 class="sheet-title">${A.esc(i.title)}</h2>
      <div class="money-hero"><div><span class="muted small">${i.state === 'paid' ? 'Fully paid' : i.state === 'cancelled' ? 'Cancelled' : 'Balance due'}</span>
        <b class="num" style="color:${i.state === 'overdue' ? 'var(--red)' : i.state === 'paid' ? 'var(--green)' : 'inherit'}">${money(i.state === 'paid' || i.state === 'cancelled' ? i.amount : i.balance)}</b></div>
        <div class="progress" style="--c:var(--green)"><i style="width:${i.amount ? Math.round((i.paid / i.amount) * 100) : 0}%"></i></div>
        <div class="row between tiny muted"><span>${money(i.paid)} received</span><span>${money(i.amount)} total</span></div></div>
      <dl class="props" style="margin-top:14px">
        <dt>${A.ic('briefcase')}Client</dt><dd><button type="button" class="chip click" data-act="clientFinance" data-id="${i.client_id}">${A.logo(clientOf(i), 'xs')}${A.esc(i.client_name)}</button></dd>
        <dt>${A.ic('calendar')}Invoice date</dt><dd>${fmtDate(i.issue_date)}</dd>
        <dt>${A.ic('clock')}Due date</dt><dd>${fmtDate(i.due_date)}${i.state === 'overdue' ? ` <span class="chip red">${i.days_overdue} days late</span>` : ''}</dd>
      </dl>
      ${i.notes ? `<div class="sub-head">Notes</div><div class="desc">${A.linkify(i.notes)}</div>` : ''}
      <div class="sub-head">Payments</div>
      ${i.payments.length ? `<div class="card list">${i.payments.map((p) => `<div class="list-item"><div class="mat-icon green">${A.ic('check')}</div>
        <div class="grow"><b class="num">${money(p.amount)}</b><div class="tiny muted">${fmtDate(p.paid_on)} · ${A.esc(p.method || 'Payment')}${p.reference ? ` · ${A.esc(p.reference)}` : ''}${p.created_by_name ? ` · by ${A.esc(p.created_by_name)}` : ''}</div>${p.note ? `<div class="small">${A.esc(p.note)}</div>` : ''}</div>
        <button type="button" class="icon-btn sm" data-act="delPayment" data-id="${p.id}" aria-label="Remove payment">${A.ic('trash')}</button></div>`).join('')}</div>`
    : '<div class="muted small">No payments recorded yet.</div>'}`);
    m.setFoot(i.status === 'cancelled'
      ? '<button type="button" class="btn" data-act="reopenInvoice">Reopen invoice</button>'
      : `${i.paid === 0 ? '<button type="button" class="btn ghost" data-act="cancelInvoice">Cancel invoice</button>' : ''}
        ${i.balance > 0 ? `<button type="button" class="btn success lg" data-act="recordPayment">${A.ic('check')} Record payment</button>` : '<span class="chip green">Fully paid ✓</span>'}`);
  };
  try { await m.refresh(); } catch (err) { A.toast(err.message, 'bad'); A.closeModalObj(m); }
}

async function openInvoiceForm({ invoice = null, prefill = {} } = {}) {
  const [clients, commercials] = await Promise.all([A.api('GET', '/api/clients'), A.api('GET', '/api/finance/commercials')]);
  const v = invoice || prefill;
  const issue = v.issue_date || todayStr();
  A.openModal({
    title: invoice ? `Edit ${invoice.number || 'invoice'}` : 'New invoice', form: 'invoice', sticky: true, wide: true, data: { invoice, commercials },
    body: `<div class="grid2">
        <label class="field"><span>Client <span class="req">*</span></span><select class="input" name="client_id" required data-on-change="invClient">
          <option value="">Choose client…</option>${clients.map((c) => `<option value="${c.id}" ${String(v.client_id || '') === String(c.id) ? 'selected' : ''}>${A.esc(c.name)}</option>`).join('')}</select></label>
        <label class="field"><span>For commercial <span class="faint">(optional)</span></span><select class="input" name="commercial_id" data-on-change="invCommercial">${commercialOptions(commercials, v.client_id, v.commercial_id)}</select></label>
      </div>
      <label class="field"><span>What is this invoice for? <span class="req">*</span></span><input class="input" name="title" required maxlength="300" value="${A.esc(v.title || '')}" placeholder="e.g. Website design — 50% advance"></label>
      <div class="grid2">
        <label class="field"><span>Amount (${A.esc(A.S.currency || 'INR')}) <span class="req">*</span></span><input class="input num" name="amount" type="number" min="0" step="0.01" inputmode="decimal" required value="${v.amount ?? ''}" placeholder="0"></label>
        <label class="field"><span>Invoice number</span><input class="input" name="number" maxlength="50" value="${A.esc(v.number || '')}" placeholder="Auto (e.g. INV-${issue.slice(0, 4)}-0001)"></label>
      </div>
      <div class="grid2">
        <label class="field"><span>Invoice date</span><input class="input" name="issue_date" type="date" value="${issue}"></label>
        <div class="field"><span>Due date</span><input class="input" name="due_date" type="date" value="${v.due_date || addDays(issue, 15)}">
          <div class="date-quick">${[7, 15, 30, 45].map((d) => `<button type="button" class="btn sm" data-act="dueIn" data-v="${d}">${d} days</button>`).join('')}</div></div>
      </div>
      <label class="field" style="margin-bottom:0"><span>Notes</span><textarea class="input" name="notes" placeholder="Bank details, terms, anything for your records…">${A.esc(v.notes || '')}</textarea></label>`,
    foot: `<button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn primary lg">${invoice ? 'Save' : 'Create invoice'}</button>`,
  });
}
const commercialOptions = (list, clientId, selected) => `<option value="">— None —</option>${list.filter((c) => String(c.client_id) === String(clientId || ''))
  .map((c) => `<option value="${c.id}" ${String(selected || '') === String(c.id) ? 'selected' : ''}>${A.esc(c.title)} · ${money(c.amount)}${PER[c.billing]}</option>`).join('')}`;

async function openCommercialForm({ commercial = null, prefill = {} } = {}) {
  const clients = await A.api('GET', '/api/clients');
  const v = commercial || { billing: 'monthly', status: 'active', start_date: todayStr(), ...prefill };
  A.openModal({
    title: commercial ? 'Edit commercial' : 'New commercial', form: 'commercial', sticky: true, wide: true, data: { commercial, file: undefined },
    body: `<div class="grid2">
        <label class="field"><span>Client <span class="req">*</span></span><select class="input" name="client_id" required>
          <option value="">Choose client…</option>${clients.map((c) => `<option value="${c.id}" ${String(v.client_id || '') === String(c.id) ? 'selected' : ''}>${A.esc(c.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Name <span class="req">*</span></span><input class="input" name="title" required value="${A.esc(v.title || '')}" placeholder="e.g. Social media retainer"></label>
      </div>
      <div class="grid2">
        <label class="field"><span>Billing</span><select class="input" name="billing">${Object.entries(BILLING).map(([k, l]) => `<option value="${k}" ${v.billing === k ? 'selected' : ''}>${l}${k === 'one_time' ? ' (project / quote)' : ' retainer'}</option>`).join('')}</select></label>
        <label class="field"><span>Amount (${A.esc(A.S.currency || 'INR')})</span><input class="input num" name="amount" type="number" min="0" step="0.01" inputmode="decimal" value="${v.amount ?? ''}" placeholder="Per month for retainers"></label>
      </div>
      <div class="grid2">
        <label class="field"><span>Start date</span><input class="input" name="start_date" type="date" value="${v.start_date || ''}"></label>
        <label class="field"><span>End date <span class="faint">(empty = ongoing)</span></span><input class="input" name="end_date" type="date" value="${v.end_date || ''}"></label>
      </div>
      <label class="field"><span>Status</span><select class="input" name="status">${Object.entries(CSTATUS).map(([k, [l]]) => `<option value="${k}" ${v.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="field"><span>Signed quote / contract <span class="faint">(optional)</span></span>
        <div class="row wrap" data-contract>${commercial?.file_key ? `<button type="button" class="btn sm" data-act="commercialFile" data-id="${commercial.id}" data-name="${A.esc(commercial.file_name)}">${A.ic('download')} ${A.esc(commercial.file_name)}</button>` : ''}
          <label class="btn sm">${A.ic('upload')} ${commercial?.file_key ? 'Replace' : 'Upload'} file<input type="file" hidden data-contract-file></label>
          <span class="small muted" data-contract-name></span></div></div>
      <label class="field" style="margin-bottom:0"><span>Notes</span><textarea class="input" name="notes" placeholder="Scope, deliverables, payment terms…">${A.esc(v.notes || '')}</textarea></label>`,
    foot: `${commercial ? `<button type="button" class="btn ghost danger" data-act="delCommercial" style="margin-right:auto">${A.ic('trash')} Delete</button>
        <button type="button" class="btn" data-act="invoiceFromCommercial">${A.ic('file')} Create invoice</button>` : ''}
      <button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn primary lg">${commercial ? 'Save' : 'Add commercial'}</button>`,
  });
}

async function openDeal(id) {
  const m = A.openModal({ title: 'Opportunity', wide: true, body: '<div class="empty"><div class="spinner" style="margin:auto"></div></div>' });
  m.refresh = async () => {
    const o = (await A.api('GET', '/api/finance/opportunities')).find((x) => String(x.id) === String(id));
    if (!o) { A.closeModalObj(m); A.toast('This opportunity was deleted', 'bad'); return; }
    m.data.deal = o;
    m.setTitle(STAGES[o.stage]);
    m.setHead(`<button type="button" class="icon-btn" data-act="editDeal" aria-label="Edit" title="Edit">${A.ic('edit')}</button>
      <button type="button" class="icon-btn" data-act="delDeal" aria-label="Delete" title="Delete">${A.ic('trash')}</button>`);
    const closed = ['won', 'lost'].includes(o.stage);
    m.setBody(`<h2 class="sheet-title" style="margin-top:0">${A.esc(o.name)}</h2>
      <div class="money-hero"><div><span class="muted small">Deal value</span><b class="num">${money(o.value)}</b></div>
        <div class="progress" style="--c:var(--primary)"><i style="width:${o.probability}%"></i></div><div class="tiny muted">${o.probability}% likely to close</div></div>
      ${closed ? '' : `<div class="sub-head">Move to stage</div><div class="seg" style="flex-wrap:wrap">${OPEN_STAGES.map((k) => `<button class="${o.stage === k ? 'on' : ''}" data-act="dealMove" data-v="${k}">${STAGES[k]}</button>`).join('')}</div>`}
      <dl class="props" style="margin-top:14px">
        ${o.company ? `<dt>${A.ic('briefcase')}Company</dt><dd>${A.esc(o.company)}</dd>` : ''}
        ${o.contact_person ? `<dt>${A.ic('user')}Contact</dt><dd>${A.esc(o.contact_person)}</dd>` : ''}
        ${o.phone ? `<dt>${A.ic('phone')}Phone</dt><dd><a href="tel:${A.esc(o.phone)}">${A.esc(o.phone)}</a></dd>` : ''}
        ${o.email ? `<dt>${A.ic('mail')}Email</dt><dd><a href="mailto:${A.esc(o.email)}">${A.esc(o.email)}</a></dd>` : ''}
        ${o.service ? `<dt>${A.ic('spark')}Service</dt><dd>${A.esc(o.service)}</dd>` : ''}
        ${o.source ? `<dt>${A.ic('arrow')}Source</dt><dd>${A.esc(o.source)}</dd>` : ''}
        <dt>${A.ic('phone')}Next follow-up</dt><dd>${o.next_follow_up ? `${fmtDate(o.next_follow_up)}${!closed && o.next_follow_up <= todayStr() ? ' <span class="chip red">Due</span>' : ''}` : '<span class="muted">Not set</span>'}</dd>
        <dt>${A.ic('calendar')}Expected close</dt><dd>${fmtDate(o.expected_close)}</dd>
        ${o.client_id ? `<dt>${A.ic('briefcase')}Client</dt><dd><button type="button" class="chip click green" data-act="nav" data-to="clients/${o.client_id}">${A.esc(o.client_name || 'Open client')}</button></dd>` : ''}
        ${o.stage === 'lost' && o.lost_reason ? `<dt>${A.ic('x')}Lost because</dt><dd>${A.esc(o.lost_reason)}</dd>` : ''}
      </dl>
      ${o.notes ? `<div class="sub-head">Notes</div><div class="desc">${A.linkify(o.notes)}</div>` : ''}`);
    m.setFoot(closed
      ? `<button type="button" class="btn" data-act="dealMove" data-v="negotiation">${A.ic('undo')} Reopen</button>${o.stage === 'won' && !o.client_id ? `<button type="button" class="btn primary" data-act="dealWon">${A.ic('briefcase')} Create client</button>` : ''}`
      : `<button type="button" class="btn ghost danger" data-act="dealLost">Mark lost</button>
        <button type="button" class="btn success lg" data-act="dealWon">${A.ic('check')} Won — make client</button>`);
  };
  try { await m.refresh(); } catch (err) { A.toast(err.message, 'bad'); A.closeModalObj(m); }
}

function openDealForm(deal = null) {
  const v = deal || { stage: 'lead', next_follow_up: addDays(todayStr(), 2) };
  A.openModal({
    title: deal ? 'Edit opportunity' : 'New opportunity', form: 'deal', sticky: true, wide: true, data: { deal },
    body: `<label class="field"><span>Opportunity <span class="req">*</span></span><input class="input" name="name" required value="${A.esc(v.name || '')}" placeholder="e.g. Cafe Bloom — website + social media"></label>
      <div class="grid2">
        <label class="field"><span>Company</span><input class="input" name="company" value="${A.esc(v.company || '')}"></label>
        <label class="field"><span>Contact person</span><input class="input" name="contact_person" value="${A.esc(v.contact_person || '')}"></label>
        <label class="field"><span>Phone</span><input class="input" name="phone" type="tel" value="${A.esc(v.phone || '')}"></label>
        <label class="field"><span>Email</span><input class="input" name="email" type="email" value="${A.esc(v.email || '')}"></label>
        <label class="field"><span>Service</span><input class="input" name="service" value="${A.esc(v.service || '')}" placeholder="Website, SEO, Ads…"></label>
        <label class="field"><span>Source</span><select class="input" name="source"><option value="">—</option>${SOURCES.map((s) => `<option ${v.source === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label class="field"><span>Deal value (${A.esc(A.S.currency || 'INR')})</span><input class="input num" name="value" type="number" min="0" step="0.01" inputmode="decimal" value="${v.value ?? ''}"></label>
        <label class="field"><span>Stage</span><select class="input" name="stage">${OPEN_STAGES.map((k) => `<option value="${k}" ${v.stage === k ? 'selected' : ''}>${STAGES[k]}</option>`).join('')}</select></label>
        <label class="field"><span>Next follow-up</span><input class="input" name="next_follow_up" type="date" value="${v.next_follow_up || ''}"></label>
        <label class="field"><span>Expected close</span><input class="input" name="expected_close" type="date" value="${v.expected_close || ''}"></label>
      </div>
      <label class="field" style="margin-bottom:0"><span>Notes</span><textarea class="input" name="notes" placeholder="Requirements, budget, who decides…">${A.esc(v.notes || '')}</textarea></label>`,
    foot: `<button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn primary lg">${deal ? 'Save' : 'Add opportunity'}</button>`,
  });
}

async function uploadFile(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} is larger than 25 MB`);
  const res = await fetch('/api/upload', {
    method: 'POST', body: file,
    headers: { Authorization: `Bearer ${A.S.token}`, 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not upload file');
  return data;
}
const val = (f, k) => f[k].value.trim();

// Drag a deal card to another pipeline column (desktop board).
export async function dropDeal(id, stage) {
  const o = A.cur()?.data?.find?.((x) => String(x.id) === String(id));
  if (!o || o.stage === stage) return;
  await A.api('PATCH', `/api/finance/opportunities/${id}`, { stage });
  A.toast(`Moved to ${STAGES[stage]}`, 'ok');
  A.scheduleRefresh();
}

export function registerFinance(app) {
  A = app;
  const { VIEWS, ACT, SUBMIT, INPUT, CHANGE, S } = app;
  Object.assign(S.ui, { finFilter: 'open', finClient: '', finSearch: '', dealStage: 'lead' });

  VIEWS.finance = {
    owner: true, title: () => 'Finance', sub: () => 'Money due, money in and deals in progress',
    action: { label: 'New invoice', act: 'newInvoice' }, load: () => app.api('GET', '/api/finance/overview'), html: overviewHtml,
  };
  VIEWS.receivables = {
    owner: true, title: () => 'Receivables', sub: (d) => `${money(d.invoices.reduce((n, i) => n + i.balance, 0))} to collect`,
    action: { label: 'New invoice', act: 'newInvoice' },
    load: async () => { const [invoices, clients] = await Promise.all([app.api('GET', '/api/finance/invoices'), app.api('GET', '/api/clients')]); return { invoices, clients }; },
    html: receivablesHtml,
  };
  VIEWS.commercials = {
    owner: true, title: () => 'Commercials', sub: (d) => `${app.plural(d.commercials.filter((c) => c.status === 'active').length, 'active agreement')}`,
    action: { label: 'New commercial', act: 'newCommercial' },
    load: async () => ({ commercials: await app.api('GET', '/api/finance/commercials') }), html: commercialsHtml,
  };
  VIEWS.pipeline = {
    owner: true, title: () => 'Opportunities', sub: (d) => `${app.plural(d.filter((o) => OPEN_STAGES.includes(o.stage)).length, 'open deal')}`,
    action: { label: 'New opportunity', act: 'newDeal' }, load: () => app.api('GET', '/api/finance/opportunities'), html: pipelineHtml,
  };

  const modalData = (el) => app.modalOf(el).data;
  Object.assign(ACT, {
    finGo(el) { S.ui.finFilter = el.dataset.filter; app.go(el.dataset.to); },
    finFilter(el) { S.ui.finFilter = el.dataset.v; app.paint(); },
    dealStage(el) { S.ui.dealStage = el.dataset.v; S.ui.dealStagePicked = true; app.paint(); },
    clientFinance(el) { S.ui.clientTab = 'finance'; app.go(`clients/${el.dataset.id}`); },
    openInvoice: (el) => openInvoice(el.dataset.id),
    newInvoice: (el) => openInvoiceForm({ prefill: { client_id: el?.dataset?.client || (app.cur()?.r.name === 'client' ? app.cur().data.id : '') } }),
    editInvoice: (el) => openInvoiceForm({ invoice: modalData(el).invoice }),
    async delInvoice(el) {
      const m = app.modalOf(el), i = m.data.invoice;
      if (!(await app.ask(`Delete ${i.number || 'this invoice'} and its payment records? Use “Cancel invoice” instead if you want to keep a record.`, { ok: 'Delete', danger: true }))) return;
      await app.api('DELETE', `/api/finance/invoices/${i.id}`);
      app.closeModalObj(m); app.toast('Invoice deleted', 'ok'); app.scheduleRefresh();
    },
    async cancelInvoice(el) {
      const m = app.modalOf(el);
      if (!(await app.ask('Cancel this invoice? It stops counting as due, but stays in your records.', { ok: 'Cancel invoice', danger: true }))) return;
      await app.api('PATCH', `/api/finance/invoices/${m.data.invoice.id}`, { status: 'cancelled' });
      await m.refresh(); app.scheduleRefresh();
    },
    async reopenInvoice(el) { const m = app.modalOf(el); await app.api('PATCH', `/api/finance/invoices/${m.data.invoice.id}`, { status: 'open' }); await m.refresh(); app.scheduleRefresh(); },
    recordPayment(el) {
      const i = modalData(el).invoice;
      app.openModal({
        title: 'Record payment', form: 'payment', sticky: true, data: { invoice: i },
        body: `<div class="muted small" style="margin-bottom:14px">${app.esc(i.client_name)} · ${app.esc(i.number || i.title)} · <b>${money(i.balance)}</b> due</div>
          <div class="grid2">
            <label class="field"><span>Amount received <span class="req">*</span></span><input class="input num" name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" required value="${i.balance}"></label>
            <label class="field"><span>Date</span><input class="input" name="paid_on" type="date" value="${todayStr()}"></label>
            <label class="field"><span>Method</span><select class="input" name="method">${METHODS.map((x) => `<option>${x}</option>`).join('')}</select></label>
            <label class="field"><span>Reference</span><input class="input" name="reference" placeholder="UTR / cheque no."></label>
          </div>
          <label class="field" style="margin-bottom:0"><span>Note</span><input class="input" name="note"></label>`,
        foot: `<button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn success lg">${app.ic('check')} Save payment</button>`,
      });
    },
    async delPayment(el) {
      if (!(await app.ask('Remove this payment? The invoice will show as due again.', { ok: 'Remove', danger: true }))) return;
      await app.api('DELETE', `/api/finance/payments/${el.dataset.id}`);
      await app.modalOf(el)?.refresh?.(); app.scheduleRefresh();
    },
    dueIn(el) { const f = el.closest('form'); f.due_date.value = addDays(f.issue_date.value || todayStr(), Number(el.dataset.v)); },
    newCommercial: (el) => openCommercialForm({ prefill: { client_id: el?.dataset?.client || (app.cur()?.r.name === 'client' ? app.cur().data.id : '') } }),
    async editCommercial(el) {
      const c = (await app.api('GET', '/api/finance/commercials')).find((x) => String(x.id) === el.dataset.id);
      if (c) openCommercialForm({ commercial: c });
    },
    async delCommercial(el) {
      const m = app.modalOf(el);
      if (!(await app.ask('Delete this commercial? Invoices already raised from it are kept.', { ok: 'Delete', danger: true }))) return;
      await app.api('DELETE', `/api/finance/commercials/${m.data.commercial.id}`);
      app.closeModalObj(m); app.toast('Commercial deleted', 'ok'); app.scheduleRefresh();
    },
    invoiceFromCommercial(el) {
      const c = modalData(el).commercial;
      app.closeModalObj(app.modalOf(el));
      openInvoiceForm({ prefill: { client_id: c.client_id, commercial_id: c.id, title: c.title, amount: c.amount } });
    },
    async commercialFile(el) {
      const res = await fetch(`/api/finance/commercials/${el.dataset.id}/file`, { headers: { Authorization: `Bearer ${S.token}` } });
      if (!res.ok) throw new Error('Could not download the file');
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: el.dataset.name || 'contract' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
    newDeal: () => openDealForm(),
    openDeal: (el) => openDeal(el.dataset.id),
    editDeal: (el) => openDealForm(modalData(el).deal),
    async delDeal(el) {
      const m = app.modalOf(el);
      if (!(await app.ask('Delete this opportunity?', { ok: 'Delete', danger: true }))) return;
      await app.api('DELETE', `/api/finance/opportunities/${m.data.deal.id}`);
      app.closeModalObj(m); app.toast('Opportunity deleted', 'ok'); app.scheduleRefresh();
    },
    async dealMove(el) {
      const m = app.modalOf(el);
      await app.api('PATCH', `/api/finance/opportunities/${m.data.deal.id}`, { stage: el.dataset.v });
      await m.refresh(); app.scheduleRefresh();
    },
    async dealWon(el) {
      const m = app.modalOf(el), o = m.data.deal;
      if (!(await app.ask(`Mark “${o.name}” as won and add ${o.company || o.name} as a client?`, { ok: 'Yes, create client', title: 'Deal won 🎉' }))) return;
      const r = await app.api('POST', `/api/finance/opportunities/${o.id}/convert`);
      app.toast('Client created — add the commercial next', 'ok', { title: 'Deal won 🎉' });
      S.ui.clientTab = 'finance';
      app.go(`clients/${r.client_id}`);
    },
    dealLost(el) {
      const o = modalData(el).deal;
      app.openModal({
        title: 'Mark as lost', form: 'dealLost', data: { deal: o },
        body: `<label class="field" style="margin:0"><span>Why was it lost? <span class="faint">(helps later)</span></span><input class="input" name="reason" placeholder="Budget, went with competitor, no response…"></label>`,
        foot: '<button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn danger-fill">Mark lost</button>',
      });
    },
  });

  Object.assign(INPUT, { finSearch(el) { S.ui.finSearch = el.value; app.paint(); } });
  Object.assign(CHANGE, {
    finClient(el) { S.ui.finClient = el.value; app.paint(); },
    invClient(el) { const f = el.closest('form'); f.commercial_id.innerHTML = commercialOptions(app.modalOf(el).data.commercials, el.value, ''); },
    invCommercial(el) {
      const f = el.closest('form');
      const c = app.modalOf(el).data.commercials.find((x) => String(x.id) === el.value);
      if (c) { if (!f.title.value.trim()) f.title.value = c.title; if (!f.amount.value) f.amount.value = c.amount; }
    },
  });
  document.addEventListener('change', (e) => {
    if (!e.target.matches?.('[data-contract-file]') || !e.target.files[0]) return;
    const m = app.modalOf(e.target);
    m.data.file = e.target.files[0];
    $('[data-contract-name]', m.el).textContent = m.data.file.name;
  });
  const $ = app.$;

  Object.assign(SUBMIT, {
    async invoice(f, m) {
      const body = {
        client_id: f.client_id.value, commercial_id: f.commercial_id.value || null, title: val(f, 'title'), amount: f.amount.value,
        number: val(f, 'number'), issue_date: f.issue_date.value, due_date: f.due_date.value, notes: f.notes.value,
      };
      if (!body.client_id) throw new Error('Choose a client');
      const inv = m.data.invoice ? await app.api('PATCH', `/api/finance/invoices/${m.data.invoice.id}`, body) : await app.api('POST', '/api/finance/invoices', body);
      app.closeModalObj(m);
      app.toast(`${inv.number} · ${money(inv.amount)}`, 'ok', { title: m.data.invoice ? 'Invoice updated' : 'Invoice created' });
      app.scheduleRefresh();
    },
    async payment(f, m) {
      const inv = await app.api('POST', `/api/finance/invoices/${m.data.invoice.id}/payments`, {
        amount: f.amount.value, paid_on: f.paid_on.value, method: f.method.value, reference: val(f, 'reference'), note: val(f, 'note'),
      });
      app.closeModalObj(m);
      app.toast(inv.state === 'paid' ? 'Invoice fully paid' : `${money(inv.balance)} still due`, 'ok', { title: 'Payment saved 💰' });
      app.scheduleRefresh();
    },
    async commercial(f, m) {
      const body = {
        client_id: f.client_id.value, title: val(f, 'title'), billing: f.billing.value, amount: f.amount.value || 0,
        start_date: f.start_date.value, end_date: f.end_date.value, status: f.status.value, notes: f.notes.value,
      };
      if (!body.client_id) throw new Error('Choose a client');
      if (m.data.file) body.file = await uploadFile(m.data.file);
      await (m.data.commercial ? app.api('PATCH', `/api/finance/commercials/${m.data.commercial.id}`, body) : app.api('POST', '/api/finance/commercials', body));
      app.closeModalObj(m);
      app.toast(body.title, 'ok', { title: m.data.commercial ? 'Commercial saved' : 'Commercial added' });
      app.scheduleRefresh();
    },
    async generateInvoices(f) {
      const r = await app.api('POST', '/api/finance/commercials/generate', { period: f.period.value });
      app.toast(r.created ? `${app.plural(r.created, 'invoice')} created for ${r.period}` : `All invoices for ${r.period} already exist`, r.created ? 'ok' : '');
      app.scheduleRefresh();
    },
    async deal(f, m) {
      const body = Object.fromEntries(['name', 'company', 'contact_person', 'phone', 'email', 'service', 'source', 'value', 'stage', 'next_follow_up', 'expected_close', 'notes'].map((k) => [k, f[k].value]));
      await (m.data.deal ? app.api('PATCH', `/api/finance/opportunities/${m.data.deal.id}`, body) : app.api('POST', '/api/finance/opportunities', body));
      app.closeModalObj(m);
      app.toast(body.name, 'ok', { title: m.data.deal ? 'Opportunity saved' : 'Opportunity added' });
      app.scheduleRefresh();
    },
    async dealLost(f, m) {
      await app.api('PATCH', `/api/finance/opportunities/${m.data.deal.id}`, { stage: 'lost', lost_reason: f.reason.value });
      app.closeModalObj(m); app.toast('Marked as lost'); app.scheduleRefresh();
    },
  });
}

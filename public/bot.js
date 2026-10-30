// Owner page for the WhatsApp bot: which groups to watch (and which client each group belongs to), status, recent activity.
let A;
const KIND = { task: ['🆕', 'New task'], done: ['✅', 'Done report'], change: ['✏️', 'Change request'] };
const STATUS = { pending: ['Waiting for reply', 'amber'], done: ['Done', 'green'], skipped: ['Ignored', ''], handled: ['Handled by another owner', ''], expired: ['Expired', ''] };

function html(d) {
  const ok = (v, yes, no) => `<div class="row" style="gap:8px">${v ? `<span class="chip green">${A.ic('check')}${yes}</span>` : `<span class="chip red">${A.ic('alert')}${no}</span>`}</div>`;
  const ownersWithPhone = d.phones.filter((u) => u.is_owner && u.phone).length;
  const missing = d.phones.filter((u) => !u.phone);
  return `<div class="banner"><div class="ico">${A.ic('msg')}</div><div class="grow small">
      Add the bot’s number to your WhatsApp groups and list the group names below. ${d.mode === 'auto' ? 'Tasks go straight to the right team and changes are added automatically. Owners are only asked when the bot isn’t sure.' : 'When someone posts a task, the bot <b>privately</b> asks the owners who should do it.'}
      When an employee says it’s done, the bot <b>privately</b> asks them to confirm. Change requests go to the owners too. Files, photos, videos, voice notes and links are saved to the task.</div></div>
    <div class="settings-grid">
      <div class="card pad"><b>Connection</b><div style="display:grid;gap:8px;margin-top:12px">
        ${ok(d.status.waha, 'WhatsApp (WAHA) connected', 'WAHA_URL not set on the server')}
        ${ok(d.status.secret, 'Bot key set', 'BOT_SECRET not set on the server')}
        ${ok(d.status.files, 'File storage ready', 'R2 “FILES” not connected — attachments can’t be saved')}
        ${ok(ownersWithPhone, `${A.plural(ownersWithPhone, 'owner')} with WhatsApp number`, 'No owner has a WhatsApp number yet')}
        <div class="row" style="gap:8px"><span class="chip ${d.status.ai ? 'indigo' : ''}">${A.ic('spark')}${d.status.ai ? `AI: ${A.esc(d.status.ai)}` : 'Built-in rules (no AI yet)'}</span></div>
        <button class="btn sm" data-act="botTest" style="margin-top:6px;justify-self:start">${A.ic('msg')} Send me a test message</button></div></div>
      <div class="card pad"><b>WhatsApp numbers</b><div class="small muted" style="margin:2px 0 10px">The bot recognises people by their number. Add numbers in Team → edit, or each person in Settings.</div>
        ${missing.length ? `<div class="small" style="color:var(--red)">${A.ic('alert')} Missing: ${missing.map((u) => A.esc(u.name)).join(', ')}</div>` : '<span class="chip green">Everyone has a number</span>'}
        <button class="btn sm" data-act="nav" data-to="team" style="margin-top:10px">Open Team</button></div>
    </div>
    <form class="card pad section" data-submit="botConfig">
      <div class="row between wrap"><b>Groups to watch</b>
        <label class="row small" style="gap:8px"><input type="checkbox" name="enabled" ${d.enabled ? 'checked' : ''}> Bot is on</label></div>
      <div class="small muted" style="margin:4px 0 12px">Type the group name exactly as it appears in WhatsApp, and pick the client its tasks belong to.</div>
      <div data-groups>${(d.groups.length ? d.groups : [{ name: '', client_id: '' }]).map((g) => groupRow(g, d.clients)).join('')}</div>
      <button type="button" class="btn sm" data-act="botAddGroup">${A.ic('plus')} Add group</button>
      ${d.seen_groups.filter((g) => g.name && !d.groups.some((x) => x.name?.toLowerCase() === g.name.toLowerCase())).length ? `<div class="small muted" style="margin-top:14px">Groups the bot is already in (tap to add):</div>
        <div class="chips" style="margin-top:6px">${d.seen_groups.filter((g) => g.name && !d.groups.some((x) => x.name?.toLowerCase() === g.name.toLowerCase())).map((g) => `<button type="button" class="chip click" data-act="botPickGroup" data-name="${A.esc(g.name)}">${A.ic('plus')}${A.esc(g.name)}</button>`).join('')}</div>` : ''}
      <div class="divider"></div>
      <label class="field" style="max-width:340px"><span>Wait for more messages before asking</span><select class="input" name="buffer_seconds">
        ${[[30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes']].map(([v, l]) => `<option value="${v}" ${d.buffer_seconds === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="tiny muted" style="font-weight:400">People often type one task in several messages + photos. The bot waits until they stop typing.</span></label>
      <label class="field" style="max-width:520px"><span>How tasks are handled</span><select class="input" name="mode">
        <option value="auto" ${d.mode === 'auto' ? 'selected' : ''}>Automatic: send to the right team; ask owners only when unsure</option>
        <option value="ask" ${d.mode === 'ask' ? 'selected' : ''}>Ask owners about every task and change</option></select></label>
      <button class="btn primary">Save</button>
    </form>
    <div class="section"><div class="section-head"><h2 class="grow">Recent bot activity</h2></div>
      ${d.recent.length ? `<div class="card list">${d.recent.map((r) => `<div class="list-item ${r.task_id ? 'click' : ''}" ${r.task_id ? `data-act="openTask" data-id="${r.task_id}"` : ''}>
        <div class="mat-icon">${KIND[r.kind][0]}</div>
        <div class="grow"><div class="strong ellipsis">${A.esc(r.title || '')}</div>
          <div class="tiny muted">${KIND[r.kind][1]}${r.group_name ? ` · ${A.esc(r.group_name)}` : ''}${r.sender_name ? ` · ${A.esc(r.sender_name)}` : ''} · ${String(r.result || '').startsWith('auto') ? A.esc(r.result) : `asked ${A.esc(r.asked || '')}`} · ${A.timeAgo(r.created_at)}</div></div>
        <span class="chip ${STATUS[r.status]?.[1] || ''}">${STATUS[r.status]?.[0] || A.esc(r.status)}</span></div>`).join('')}</div>`
    : `<div class="card">${A.empty('msg', 'Nothing yet', 'Once the bot is in a watched group, tasks and replies show up here.')}</div>`}</div>`;
}
const groupRow = (g, clients) => `<div class="row wrap" data-group-row style="margin-bottom:8px">
  <input class="input grow" name="group_name" placeholder="WhatsApp group name, e.g. Sunrise Bakery × Digiteq" value="${A.esc(g.name || '')}" style="min-width:200px">
  <select class="input" name="group_client" style="width:auto;min-width:170px"><option value="">No client</option>${clients.map((c) => `<option value="${c.id}" ${String(g.client_id || '') === String(c.id) ? 'selected' : ''}>${A.esc(c.name)}</option>`).join('')}</select>
  <button type="button" class="icon-btn sm" data-act="botRemoveGroup" aria-label="Remove">${A.ic('trash')}</button></div>`;

export function registerBotUI(app) {
  A = app;
  app.VIEWS.bot = {
    owner: true, title: () => 'WhatsApp bot', sub: (d) => `${A.plural(d.groups.length, 'group')} watched`,
    async load() { const [cfg, clients] = await Promise.all([app.api('GET', '/api/bot/config'), app.api('GET', '/api/clients')]); return { ...cfg, clients }; },
    html,
  };
  Object.assign(app.ACT, {
    botAddGroup(el) { el.closest('form').querySelector('[data-groups]').insertAdjacentHTML('beforeend', groupRow({}, app.cur().data.clients)); },
    botRemoveGroup(el) { el.closest('[data-group-row]').remove(); },
    botPickGroup(el) {
      const box = document.querySelector('[data-groups]');
      const empty = [...box.querySelectorAll('[name=group_name]')].find((i) => !i.value.trim());
      if (empty) empty.value = el.dataset.name;
      else { box.insertAdjacentHTML('beforeend', groupRow({ name: el.dataset.name }, app.cur().data.clients)); }
      el.remove();
    },
    async botTest() { await app.api('POST', '/api/bot/test'); app.toast('Check your WhatsApp', 'ok', { title: 'Test message sent' }); },
  });
  Object.assign(app.SUBMIT, {
    async botConfig(f) {
      const groups = [...f.querySelectorAll('[data-group-row]')].map((r) => ({ name: r.querySelector('[name=group_name]').value.trim(), client_id: r.querySelector('[name=group_client]').value || null }))
        .filter((g) => g.name);
      await app.api('POST', '/api/bot/config', { enabled: f.enabled.checked, mode: f.mode.value, buffer_seconds: Number(f.buffer_seconds.value), groups });
      app.toast(`${A.plural(groups.length, 'group')} watched`, 'ok', { title: 'Bot settings saved' });
      app.scheduleRefresh();
    },
  });
}

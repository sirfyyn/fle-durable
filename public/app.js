// FLE Durable's page: the main conversation live (server-sent events), the agenda, approvals and the queue.
// Signed in by cookie (one-time code); every write sends X-FLE-Durable: 1.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-FLE-Durable': '1' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ------------------------------------------------------------------------------------------------ conversation

let entries = [];
let live = null; // the assistant message being written

const blocks = (m) => (Array.isArray(m?.content) ? m.content : typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : []);
const textOf = (m) => blocks(m).filter((b) => b.type === 'text').map((b) => b.text).join('');

function messageView(who, text, cls) {
  const d = el('div', `msg ${cls}`);
  d.append(el('span', 'who', who), document.createTextNode(text));
  return d;
}

function render() {
  const log = $('log');
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
  log.replaceChildren();
  for (const e of entries) {
    if (e.kind === 'fle.event') {
      const d = e.data ?? {};
      if (d.source === 'chat') log.append(messageView('You', d.text, 'you'));
      else log.append(messageView(`${d.source}${d.from && d.from !== d.source ? ` · ${d.from}` : ''}`, d.text, 'event'));
      continue;
    }
    if (e.kind === 'fle.approval') {
      log.append(messageView('approval', `Asked: ${e.data?.action}`, 'event'));
      continue;
    }
    if (e.kind === 'fle.approval-decision') {
      log.append(messageView('approval', `${e.data?.decision}${e.data?.note ? ` · ${e.data.note}` : ''}`, 'event'));
      continue;
    }
    const msgs = Array.isArray(e.model) ? e.model : e.model ? [e.model] : [];
    for (const m of msgs) {
      if (m.role === 'assistant') {
        const t = textOf(m);
        if (t) log.append(messageView('Agent', t, 'agent'));
        for (const b of blocks(m)) if (b.type === 'toolCall') log.append(messageView('tool', `${b.name} ${JSON.stringify(b.arguments ?? {}).slice(0, 200)}`, 'tool'));
      }
    }
  }
  if (live && textOf(live)) log.append(messageView('Agent', textOf(live), 'agent'));
  if (!log.childElementCount) {
    log.append(el('div', 'faint', 'Nothing yet. Write to your agent, plan something on the right, or send it a webhook (POST /api/events). Everything it does shows up here.'));
  }
  if (stick) log.scrollTop = log.scrollHeight;
}

function onEvents(list) {
  let reload = false;
  for (const ev of list) {
    if (ev.type === 'message_start' && ev.message?.role === 'assistant') live = structuredClone(ev.message);
    if (ev.type === 'message_update' && live) {
      for (const c of ev.changes ?? []) {
        if (c.type === 'message') live = structuredClone(c.message);
        if (c.type === 'text_start') (live.content ??= [])[c.contentIndex] = { type: 'text', text: '' };
        if (c.type === 'text_delta' && live.content?.[c.contentIndex]) live.content[c.contentIndex].text += c.delta ?? '';
      }
    }
    if (ev.type === 'message_end' || ev.type === 'entry_appended') {
      const entry = ev.entry;
      if (entry && !entries.some((x) => x.id === entry.id)) entries.push(entry);
      if (ev.type === 'message_end' && entry?.model?.[0]?.role === 'assistant') live = null;
    }
    if (ev.type === 'run_start') setStatus('working', 'warn');
    if (ev.type === 'run_end') {
      setStatus('ready', 'good');
      reload = true;
    }
  }
  render();
  if (reload) refreshSide();
}

function setStatus(text, kind = '') {
  const s = $('status');
  s.textContent = text;
  s.className = `pill ${kind}`;
}

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (m) => {
    entries = JSON.parse(m.data).entries ?? [];
    api('GET', '/api/conversation').then((r) => {
      entries = r.entries;
      render();
    });
    setStatus('ready', 'good');
  });
  es.addEventListener('events', (m) => onEvents(JSON.parse(m.data)));
  es.onerror = () => setStatus('reconnecting …');
}

$('send').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = $('text').value.trim();
  if (!t) return;
  $('text').value = '';
  try {
    await api('POST', '/api/message', { text: t });
    refreshSide();
  } catch (err) {
    alert(err.message);
  }
});
$('text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('send').requestSubmit();
  }
});
$('abort').addEventListener('click', () => api('POST', '/api/abort').catch((e) => alert(e.message)));

// ------------------------------------------------------------------------------------------------ side

const pad = (n) => String(n).padStart(2, '0');
const hm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function day(ms) {
  const d = new Date(ms).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  const n = Math.round((d - today) / 86400000);
  return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : new Date(ms).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}
const rule = (it) => (it.kind === 'once' ? 'once' : it.kind === 'daily' ? `daily ${it.time}` : it.kind === 'weekly' ? `weekly ${it.time}` : `every ${it.every_min} min`);

async function refreshSide() {
  try {
    const [agenda, queue, approvals] = await Promise.all([api('GET', '/api/agenda'), api('GET', '/api/queue'), api('GET', '/api/approvals')]);
    $('zone').textContent = agenda.zone;
    const box = $('agenda');
    box.replaceChildren();
    let last = '';
    for (const it of agenda.items) {
      const label = it.next ? day(it.next) : 'Paused';
      if (label !== last) box.append(el('div', 'day', (last = label)));
      const row = el('div', 'item');
      const del = el('button', '', '×');
      del.title = 'Remove';
      del.onclick = () => api('DELETE', `/api/agenda/${it.id}`).then(refreshSide).catch((e) => alert(e.message));
      const body = el('div');
      body.append(el('div', '', it.title), el('div', 'meta', `${rule(it)} · ${it.by === 'agent' ? 'planned by the agent' : 'you'}`));
      row.append(el('div', 't', it.next ? hm(it.next) : '–'), body, del);
      box.append(row);
    }
    if (!agenda.items.length) box.append(el('div', 'faint', 'Nothing planned. The agent plans its own follow-ups here too.'));
    const q = $('queue');
    q.replaceChildren();
    for (const e of queue.entries) q.append(el('div', 'item', `${e.source}: ${e.text}`));
    if (!queue.entries.length) q.textContent = queue.paused ? 'Paused.' : 'Nothing waits.';
    const open = approvals.approvals.filter((a) => a.status === 'open');
    $('approvals-card').hidden = !open.length;
    const ab = $('approvals');
    ab.replaceChildren();
    for (const a of open) {
      const card = el('div', 'approval');
      card.append(el('b', '', a.action), el('div', '', a.context));
      if (a.command) card.append(el('pre', '', a.command));
      const row = el('div', 'row');
      const yes = el('button', 'btn primary', 'Allow');
      const no = el('button', 'btn', 'Refuse');
      yes.onclick = () => api('POST', `/api/approvals/${a.id}`, { decision: 'granted' }).then(refreshSide);
      no.onclick = () => api('POST', `/api/approvals/${a.id}`, { decision: 'refused' }).then(refreshSide);
      row.append(no, yes);
      card.append(row);
      ab.append(card);
    }
  } catch (e) {
    setStatus(e.message, 'warn');
  }
}

$('plan-kind').addEventListener('change', (e) => {
  $('plan-when').value = e.target.value === 'daily' ? '08:00' : e.target.value === 'interval' ? '60' : '30';
});
$('plan').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('plan-text').value.trim();
  const kind = $('plan-kind').value;
  const when = $('plan-when').value.trim();
  const body = kind === 'in' ? { kind: 'once', in_minutes: Number(when), text } : kind === 'daily' ? { kind: 'daily', time: when, text } : { kind: 'interval', every_min: Number(when), text };
  try {
    await api('POST', '/api/agenda', body);
    $('plan-text').value = '';
    refreshSide();
  } catch (err) {
    alert(err.message);
  }
});

api('GET', '/api/health')
  .then((h) => {
    $('model').textContent = ` · ${h.model.id} · ${h.model.contextWindow} tokens`;
  })
  .catch(() => {});
connect();
refreshSide();
setInterval(refreshSide, 10000);

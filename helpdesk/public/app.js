// מוקד וואטסאפ – צד הדפדפן
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');

const S = {
  me: null, version: 0, company: '',
  tickets: new Map(), // id -> summary (פתוחות)
  closed: [], // סגורות (נטען לפי דרישה)
  sel: null, // id נבחר
  view: null, // {ticket, messages, history, readOnly}
  users: [], instances: [],
  tab: 'mine', // mine | all | routing | closed
  q: '',
};

async function api(method, url, body, headers) {
  const opts = { method, headers: { ...(headers || {}) } };
  if (body instanceof Blob || body instanceof ArrayBuffer) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && S.me) { S.me = null; boot(); }
  if (!r.ok) throw new Error(data.error || 'שגיאה ' + r.status);
  return data;
}

function toast(msg, err = false, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg; t.className = err ? 'err' : ''; t.style.display = 'block';
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.style.display = 'none'), ms);
}
const modal = $('#modal'), box = $('#box');
function openModal(html, wide = false) { box.className = 'box' + (wide ? ' wide' : ''); box.innerHTML = html; modal.classList.add('on'); }
function closeModal() { modal.classList.remove('on'); }
modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });

const initials = (n) => String(n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
const avColor = (s) => `hsl(${[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 35% 42%)`;
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), n = new Date();
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}
function waitText(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'עכשיו';
  if (m < 60) return `${m} דק׳`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}:${String(m % 60).padStart(2, '0')} שע׳` : `${Math.floor(h / 24)} ימים`;
}

// =====================================================================
// כניסה
// =====================================================================
async function boot() {
  let st;
  try { st = await api('GET', '/api/state'); } catch { app.innerHTML = '<div class="welcome"><h2>אין חיבור לשרת</h2>מנסה שוב...</div>'; return setTimeout(boot, 3000); }
  S.version = st.version; S.company = st.company;
  if (st.setupNeeded) return renderSetup();
  if (!st.user) return renderLogin();
  S.me = st.user;
  startMain();
}

function renderSetup() {
  app.innerHTML = `<div class="login"><form class="card" id="f">
    <h1>👋 ברוך הבא למוקד הוואטסאפ</h1>
    <p>הגדרה ראשונה: צור את משתמש המנהל.</p>
    <label>השם שלך</label><input name="name" required placeholder="חיים">
    <label>שם משתמש (לכניסה)</label><input name="username" required placeholder="haim" dir="ltr">
    <label>סיסמה</label><input name="password" type="password" required minlength="4">
    <button class="primary">צור מנהל והמשך</button><div class="err" id="err"></div></form></div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api('POST', '/api/setup', f); await api('POST', '/api/login', f); boot(); }
    catch (er) { $('#err').textContent = er.message; }
  };
}

function renderLogin() {
  app.innerHTML = `<div class="login"><form class="card" id="f">
    <h1>מוקד וואטסאפ</h1><p>${esc(S.company)}</p>
    <label>שם משתמש</label><input name="username" required autofocus dir="ltr">
    <label>סיסמה</label><input name="password" type="password" required>
    <button class="primary">כניסה</button><div class="err" id="err"></div></form></div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/login', Object.fromEntries(new FormData(e.target))); boot(); }
    catch (er) { $('#err').textContent = er.message; }
  };
}

// =====================================================================
// מסך ראשי
// =====================================================================
let es = null;
async function startMain() {
  app.innerHTML = `<div class="main">
    <div class="top">
      <span class="logo">💬 מוקד וואטסאפ</span>
      <span id="insts"></span>
      <span class="spacer"></span>
      <button id="newChat" title="שליחת הודעה ללקוח חדש">✉️ שיחה חדשה</button>
      <button id="muteBtn"></button>
      <button id="mySettings" title="צלצולים וסיסמה">⚙️</button>
      ${S.me.role === 'admin' ? '<button id="adminBtn">🛠️ ניהול</button>' : ''}
      <span class="me">${esc(S.me.name)} · v${S.version}</span>
      <button class="ghost" id="logout">יציאה</button>
    </div>
    <div class="side">
      <div class="tabs" id="tabs"></div>
      <div class="search"><input id="q" placeholder="🔍 חיפוש לפי שם או טלפון"></div>
      <div class="list" id="list"></div>
    </div>
    <div class="chat" id="chat"></div>
  </div>`;
  if (S.me.role === 'admin') { S.tab = localStorage.getItem('hd-tab') || 'all'; $('#adminBtn').onclick = () => adminDialog(); }
  $('#logout').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); location.reload(); };
  $('#mySettings').onclick = mySettingsDialog;
  $('#newChat').onclick = newChatDialog;
  $('#q').oninput = (e) => { S.q = e.target.value.trim(); renderList(); };
  const paintMute = () => { $('#muteBtn').textContent = Sounds.settings.muted ? '🔕' : '🔔'; $('#muteBtn').title = Sounds.settings.muted ? 'הצלצולים כבויים' : 'הצלצולים פעילים'; };
  $('#muteBtn').onclick = () => { Sounds.settings.muted = !Sounds.settings.muted; Sounds.save(); paintMute(); };
  paintMute();

  const [list, users, insts] = await Promise.all([api('GET', '/api/tickets'), api('GET', '/api/users'), api('GET', '/api/instances')]);
  S.tickets = new Map(list.map((t) => [t.id, t]));
  S.users = users; S.instances = insts;
  renderInstances(); renderTabs(); renderList(); renderChat();
  connectEvents();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

function connectEvents() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch (er) { console.error(er); } };
  es.onerror = () => { $('#insts') && ($('#insts').innerHTML = '<span class="inst-dot bad"><i></i>אין חיבור לשרת – מתחבר מחדש...</span>'); };
}

function notify(title, body) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { const n = new Notification(title, { body, tag: 'hd', renotify: true }); n.onclick = () => { window.focus(); n.close(); }; } catch {}
}

function onEvent(ev) {
  if (ev.type === 'hello') {
    if (ev.version && S.version && ev.version !== S.version) location.reload();
    S.instances = ev.instances; renderInstances();
    // חיבור מחדש – מרעננים את הרשימה
    api('GET', '/api/tickets').then((list) => { S.tickets = new Map(list.map((t) => [t.id, t])); renderList(); }).catch(() => {});
  } else if (ev.type === 'instances') { S.instances = ev.list; renderInstances(); }
  else if (ev.type === 'ticket') {
    const t = ev.ticket;
    const visible = S.me.role === 'admin' || t.assigneeId === S.me.id;
    if (t.status === 'closed' || !visible) S.tickets.delete(t.id); else S.tickets.set(t.id, t);
    if (S.view && S.view.ticket.id === t.id) { S.view.ticket = t; renderChatHead(); renderComposer(); }
    renderList();
    if (ev.sound && t.assigneeId === S.me.id) {
      Sounds.newMessage();
      notify(ev.sound === 'new' ? 'קריאה חדשה' : 'הודעה חדשה', `${t.customerName}: ${t.lastText || ''}`);
    }
  } else if (ev.type === 'remove') {
    S.tickets.delete(ev.id);
    if (S.sel === ev.id) { S.sel = null; S.view = null; renderChat(); toast('השיחה הועברה לעובד אחר'); }
    renderList();
  } else if (ev.type === 'message') {
    if (S.view && S.view.ticket.id === ev.ticketId && !S.view.messages.some((m) => m.id === ev.message.id)) {
      S.view.messages.push(ev.message); appendMessage(ev.message, true);
    }
  } else if (ev.type === 'status') {
    if (S.view && S.view.ticket.id === ev.ticketId) {
      const m = S.view.messages.find((x) => x.id === ev.msgId);
      if (m) { m.status = ev.status; const el = document.querySelector(`[data-mid="${ev.msgId}"] .ticks`); if (el) el.outerHTML = ticks(m); }
    }
  } else if (ev.type === 'restarting') {
    toast('המערכת מתעדכנת לגרסה חדשה – מתחבר מחדש בעוד רגע...', false, 8000);
    setTimeout(() => location.reload(), 8000);
  }
}

function renderInstances() {
  const el = $('#insts'); if (!el) return;
  el.innerHTML = S.instances.filter((i) => i.enabled).map((i) => {
    const ok = i.state === 'authorized';
    const label = ok ? '' : i.state === 'notAuthorized' ? ' – לא מחובר (צריך לסרוק)' : String(i.state).startsWith('error') ? ' – שגיאה' : '';
    return `<span class="inst-dot ${ok ? 'ok' : 'bad'}" title="${esc(i.state)}"><i></i>${esc(i.name)}${label}</span>`;
  }).join(' ') || (S.me.role === 'admin' ? '<span class="inst-dot bad"><i></i>לא הוגדרו מספרים – לחץ "ניהול"</span>' : '');
}

// ---------- רשימת קריאות ----------
function renderTabs() {
  const tabs = S.me.role === 'admin'
    ? [['all', 'כל הפתוחות'], ['mine', 'שלי'], ['routing', 'בניתוב'], ['closed', 'סגורות']]
    : [['mine', 'הקריאות שלי'], ['closed', 'סגורות']];
  $('#tabs').innerHTML = tabs.map(([k, n]) => `<button data-k="${k}" class="${S.tab === k ? 'on' : ''}">${n} <span data-cnt="${k}"></span></button>`).join('');
  $('#tabs').querySelectorAll('button').forEach((b) => (b.onclick = async () => {
    S.tab = b.dataset.k; localStorage.setItem('hd-tab', S.tab); renderTabs();
    if (S.tab === 'closed') S.closed = await api('GET', '/api/tickets?scope=closed').catch(() => []);
    renderList();
  }));
}

function sortTickets(list) {
  return list.sort((a, b) => {
    if (a.awaiting !== b.awaiting) return a.awaiting ? -1 : 1; // ממתינים לתשובה – למעלה
    if (a.awaiting) return (a.lastInAt || 0) - (b.lastInAt || 0); // הכי ותיק – ראשון
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

function currentList() {
  let list;
  if (S.tab === 'closed') list = [...S.closed];
  else {
    list = [...S.tickets.values()];
    if (S.tab === 'mine') list = list.filter((t) => t.assigneeId === S.me.id);
    if (S.tab === 'routing') list = list.filter((t) => t.status === 'routing' || !t.assigneeId);
    sortTickets(list);
  }
  if (S.q) {
    const q = S.q.toLowerCase();
    list = list.filter((t) => String(t.customerName).toLowerCase().includes(q) || String(t.phone).includes(q.replace(/\D/g, '') || '§') || String(t.id) === q.replace('#', ''));
  }
  return list;
}

function renderList() {
  const el = $('#list'); if (!el) return;
  const list = currentList();
  const now = Date.now();
  const myWaiting = [...S.tickets.values()].filter((t) => t.assigneeId === S.me.id && t.awaiting).length;
  document.title = (myWaiting ? `(${myWaiting}) ` : '') + 'מוקד וואטסאפ';
  const counts = { mine: [...S.tickets.values()].filter((t) => t.assigneeId === S.me.id).length, all: S.tickets.size, routing: [...S.tickets.values()].filter((t) => t.status === 'routing' || !t.assigneeId).length };
  for (const [k, n] of Object.entries(counts)) { const c = document.querySelector(`[data-cnt="${k}"]`); if (c) c.textContent = n ? `(${n})` : ''; }
  if (!list.length) {
    el.innerHTML = `<div class="empty">${S.tab === 'closed' ? 'אין קריאות סגורות' : S.q ? 'לא נמצא' : 'אין קריאות פתוחות 🎉'}</div>`;
    return;
  }
  el.innerHTML = list.map((t) => {
    const wait = t.awaiting ? now - (t.lastInAt || t.updatedAt) : 0;
    const cls = ['item', t.id === S.sel ? 'sel' : '', t.awaiting ? 'wait' : '', wait > 15 * 60000 ? 'late' : wait > 5 * 60000 ? 'mid' : '', t.status === 'routing' ? 'routing' : ''].join(' ');
    return `<div class="${cls}" data-id="${t.id}">
      <div class="av" style="background:${avColor(t.phone)}">${esc(initials(t.customerName))}</div>
      <div class="body">
        <div class="row1"><span class="name">${esc(t.customerName)}</span><span class="time">${fmtTime(t.updatedAt)}</span></div>
        <div class="row2"><span class="last">${t.lastDir === 'out' ? '↩ ' : ''}${esc(t.lastText)}</span>${t.awaiting ? '<span class="dot"></span>' : ''}</div>
        <div class="row3">
          <span class="chip">#${t.id}</span>${t.isGroup ? '<span class="chip">👥 קבוצה</span>' : ''}
          ${t.instanceName ? `<span class="chip">📱 ${esc(t.instanceName)}</span>` : ''}
          ${t.status === 'routing' ? '<span class="chip">🤖 מנתב...</span>' : t.departmentName ? `<span class="chip dep">${esc(t.departmentName)}</span>` : ''}
          ${S.me.role === 'admin' && t.assigneeName ? `<span class="chip who">👤 ${esc(t.assigneeName)}</span>` : ''}
          ${t.awaiting ? `<span class="chip waittime">⏳ ${waitText(wait)}</span>` : ''}
        </div>
      </div></div>`;
  }).join('');
  el.querySelectorAll('.item').forEach((it) => (it.onclick = () => openTicket(it.dataset.id)));
}
setInterval(renderList, 30000);

// תזכורת: כל עוד יש קריאה שלי שמחכה לתשובה
let lastRemind = Date.now();
setInterval(() => {
  if (!S.me) return;
  const waiting = [...S.tickets.values()].some((t) => t.assigneeId === S.me.id && t.awaiting);
  if (!waiting) { lastRemind = Date.now(); return; }
  if (Date.now() - lastRemind >= Sounds.settings.remindSec * 1000) {
    lastRemind = Date.now();
    Sounds.reminder();
    notify('יש לקוחות שמחכים לתשובה', 'לחץ כדי לחזור למוקד');
  }
}, 1000);

// ---------- צ'אט ----------
async function openTicket(id) {
  S.sel = id; renderList();
  try { S.view = await api('GET', '/api/tickets/' + id); } catch (e) { toast(e.message, true); return; }
  renderChat();
}

function renderChat() {
  const el = $('#chat'); if (!el) return;
  if (!S.view) {
    el.innerHTML = `<div class="welcome"><h2>שלום ${esc(S.me.name)} 👋</h2><div>בחר קריאה מהרשימה כדי להתחיל.</div>
      <div class="hint">קריאות שמחכות לתשובה שלך מסומנות בנקודה ירוקה ומופיעות למעלה.<br>כל עוד יש לקוח שמחכה – יהיה צלצול תזכורת.</div>
      ${Sounds.unlocked() ? '' : '<button class="primary" onclick="Sounds.play(Sounds.settings.newTone)">🔊 הפעל צלילים</button>'}</div>`;
    return;
  }
  el.innerHTML = `<div class="chat-head" id="chead"></div><div id="hist"></div><div class="msgs" id="msgs"></div><div id="comp"></div>`;
  renderChatHead();
  renderHistory();
  const msgs = $('#msgs');
  let lastDay = '';
  for (const m of S.view.messages) {
    const day = new Date(m.ts).toLocaleDateString('he-IL');
    if (day !== lastDay) { msgs.insertAdjacentHTML('beforeend', `<div class="day">${day}</div>`); lastDay = day; }
    msgs.insertAdjacentHTML('beforeend', messageHtml(m));
  }
  msgs.scrollTop = msgs.scrollHeight;
  renderComposer();
}

function renderChatHead() {
  const h = $('#chead'); if (!h || !S.view) return;
  const t = S.view.ticket;
  const ro = S.view.readOnly;
  h.innerHTML = `<div class="av" style="background:${avColor(t.phone)}">${esc(initials(t.customerName))}</div>
    <div class="who"><b>${esc(t.customerName)}</b>
      ${t.isGroup ? '<small>👥 קבוצה</small>' : `<small dir="ltr">+${esc(t.phone)}</small>`} <small>· #${t.id} · 📱 ${esc(t.instanceName)}${t.departmentName ? ' · ' + esc(t.departmentName) : ''}${t.assigneeName ? ' · 👤 ' + esc(t.assigneeName) : ''}${t.status === 'closed' ? ' · ✅ סגורה' : ''}</small></div>
    ${ro ? '<span class="chip">צפייה בלבד</span>' : t.status === 'closed'
      ? '<button id="reopenBtn">🔄 פתח מחדש</button>'
      : '<button id="transferBtn">↪️ העבר שיחה</button><button class="primary" id="closeBtn">✅ סגור קריאה</button>'}
    ${S.me.role === 'admin' && !ro ? `<button class="ghost" id="ignoreBtn" title="לא לפתוח יותר קריאות מ${t.isGroup ? 'הקבוצה' : 'הצ׳אט'} הזה">🔕 התעלם</button>` : ''}`;
  if ($('#transferBtn')) $('#transferBtn').onclick = transferDialog;
  if ($('#closeBtn')) $('#closeBtn').onclick = closeTicket;
  if ($('#ignoreBtn')) $('#ignoreBtn').onclick = async (e) => {
    const b = e.currentTarget;
    if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = 'בטוח? לא ייפתחו יותר קריאות מכאן – לחץ שוב'; return; }
    try {
      await api('POST', `/api/tickets/${t.id}/ignore`);
      S.tickets.delete(t.id); S.sel = null; S.view = null; renderList(); renderChat();
      toast(`🔕 "${t.customerName}" לא יפתח יותר קריאות. אפשר לבטל ב"ניהול ← כללי"`, false, 6000);
    } catch (er) { toast(er.message, true); }
  };
  if ($('#reopenBtn')) $('#reopenBtn').onclick = async () => { try { await api('POST', `/api/tickets/${t.id}/reopen`); openTicket(t.id); } catch (e) { toast(e.message, true); } };
}

function renderHistory() {
  const h = $('#hist'); if (!h) return;
  const list = S.view.history || [];
  if (!list.length) { h.innerHTML = ''; return; }
  h.innerHTML = `<div class="history">📜 קריאות קודמות של הלקוח: ${list.map((x) => `<a data-id="${x.id}">#${x.id} (${new Date(x.createdAt).toLocaleDateString('he-IL')}${x.assigneeName ? ', ' + esc(x.assigneeName) : ''})</a>`).join(' · ')}</div>`;
  h.querySelectorAll('a').forEach((a) => (a.onclick = () => openTicket(a.dataset.id)));
}

function ticks(m) {
  if (m.dir !== 'out') return '';
  const s = m.status;
  return `<span class="ticks ${s === 'read' ? 'read' : ''}">${s === 'read' || s === 'delivered' ? '✓✓' : s === 'failed' || s === 'noAccount' ? '⚠️' : '✓'}</span>`;
}

function messageHtml(m) {
  if (m.dir === 'note') return `<div class="msg note" data-mid="${m.id}">${esc(m.text)} <span class="meta">${fmtTime(m.ts)}</span></div>`;
  let media = '';
  if (m.url) {
    if (m.type === 'image') media = `<a href="${esc(m.url)}" target="_blank"><img src="${esc(m.url)}" loading="lazy" alt=""></a>`;
    else if (m.type === 'video') media = `<video src="${esc(m.url)}" controls preload="none"></video>`;
    else if (m.type === 'audio') media = `<audio src="${esc(m.url)}" controls preload="none"></audio>`;
    else if (m.type === 'location') media = `<a href="${esc(m.url)}" target="_blank">📍 פתח מיקום במפה</a><br>`;
    else media = `<a href="${esc(m.url)}" target="_blank">📎 ${esc(m.fileName || 'קובץ')}</a><br>`;
  } else if (m.type !== 'text') media = `<i>${{ image: '📷 תמונה', video: '🎬 וידאו', audio: '🎤 הקלטה', file: '📎 ' + esc(m.fileName || 'קובץ') }[m.type] || ''}</i><br>`;
  const by = m.dir === 'out' && m.byName ? `<div class="by">${esc(m.byName)}</div>`
    : m.dir === 'in' && m.senderName ? `<div class="by sender">${esc(m.senderName)}</div>` : '';
  return `<div class="msg ${m.dir} ${m.auto ? 'auto' : ''}" data-mid="${m.id}">${by}${media}${esc(m.text)}<div class="meta">${fmtTime(m.ts)} ${ticks(m)}</div></div>`;
}

function appendMessage(m, scroll) {
  const msgs = $('#msgs'); if (!msgs) return;
  const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 150;
  msgs.insertAdjacentHTML('beforeend', messageHtml(m));
  if (scroll && (nearBottom || m.byUserId === S.me.id)) msgs.scrollTop = msgs.scrollHeight;
}

function renderComposer() {
  const c = $('#comp'); if (!c || !S.view) return;
  const t = S.view.ticket;
  if (S.view.readOnly) { c.innerHTML = '<div class="closed-bar">קריאה קודמת – צפייה בלבד</div>'; return; }
  if (t.status === 'closed') { c.innerHTML = '<div class="closed-bar">הקריאה סגורה. כדי לכתוב ללקוח – "פתח מחדש", או שהלקוח יכתוב ותיפתח קריאה חדשה.</div>'; return; }
  if (c.dataset.for === t.id && $('#txt')) return; // לא מוחקים טקסט שבאמצע הקלדה
  c.dataset.for = t.id;
  c.innerHTML = `<div class="composer">
    <button id="attach" title="שליחת קובץ / תמונה">📎</button>
    <input type="file" id="file" hidden>
    <textarea id="txt" placeholder="כתוב הודעה... (Enter לשליחה, Shift+Enter לשורה חדשה)"></textarea>
    <button class="primary" id="sendBtn" title="שלח">➤</button></div>`;
  const txt = $('#txt');
  const grow = () => { txt.style.height = 'auto'; txt.style.height = Math.min(160, txt.scrollHeight) + 'px'; };
  txt.oninput = grow;
  txt.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } };
  $('#sendBtn').onclick = sendText;
  $('#attach').onclick = () => $('#file').click();
  $('#file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) sendFile(f); };
  txt.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])][0];
    if (f) { e.preventDefault(); sendFile(f); }
  });
  txt.focus();
}

async function sendText() {
  const txt = $('#txt'); const text = txt.value.trim();
  if (!text || !S.view) return;
  const id = S.view.ticket.id;
  txt.value = ''; txt.style.height = '42px';
  try { await api('POST', `/api/tickets/${id}/send`, { text }); }
  catch (e) { toast(e.message, true, 6000); if (!$('#txt').value) $('#txt').value = text; }
}

async function sendFile(file) {
  if (!S.view) return;
  const caption = $('#txt') ? $('#txt').value.trim() : '';
  toast('שולח את ' + file.name + '...');
  try {
    await api('POST', `/api/tickets/${S.view.ticket.id}/upload`, file, {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
      'X-Caption': encodeURIComponent(caption),
    });
    if ($('#txt')) $('#txt').value = '';
    toast('נשלח ✓');
  } catch (e) { toast(e.message, true, 6000); }
}

async function closeTicket() {
  const t = S.view.ticket;
  try {
    await api('POST', `/api/tickets/${t.id}/close`);
    S.tickets.delete(t.id); S.sel = null; S.view = null;
    renderList(); renderChat(); toast(`קריאה #${t.id} נסגרה ✅`);
  } catch (e) { toast(e.message, true); }
}

function transferDialog() {
  const t = S.view.ticket;
  const users = S.users.filter((u) => u.id !== t.assigneeId);
  openModal(`<h3>↪️ העברת השיחה עם ${esc(t.customerName)}</h3>
    <label>הערה לעובד (לא נשלחת ללקוח)</label><input id="tnote" placeholder="למשל: מבקש החזר על חשבונית מאוקטובר">
    <label>למי להעביר?</label><div class="pick">${users.map((u) => `<button data-id="${u.id}"><span class="av" style="width:32px;height:32px;font-size:13px;background:${avColor(u.username)}">${esc(initials(u.name))}</span>${esc(u.name)}</button>`).join('')}</div>
    <div class="row"><button id="cancel">ביטול</button></div>`);
  $('#cancel').onclick = closeModal;
  box.querySelectorAll('.pick button').forEach((b) => (b.onclick = async () => {
    try {
      const r = await api('POST', `/api/tickets/${t.id}/transfer`, { userId: b.dataset.id, note: $('#tnote').value.trim() });
      closeModal(); toast(`השיחה הועברה ל${r.assigneeName} ✓`);
      if (S.me.role !== 'admin') { S.tickets.delete(t.id); S.sel = null; S.view = null; renderList(); renderChat(); }
    } catch (e) { toast(e.message, true); }
  }));
}

function newChatDialog() {
  const insts = S.instances.filter((i) => i.enabled);
  if (!insts.length) return toast('לא הוגדרו מספרי וואטסאפ', true);
  openModal(`<h3>✉️ שיחה חדשה עם לקוח</h3>
    <label>מאיזה מספר לשלוח?</label><select id="ninst">${insts.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select>
    <div class="grid2"><div><label>טלפון הלקוח</label><input id="nphone" dir="ltr" placeholder="0521234567"></div>
    <div><label>שם (לא חובה)</label><input id="nname"></div></div>
    <label>הודעה</label><textarea id="ntext" rows="4"></textarea>
    <div class="row"><button class="primary" id="nsend">שלח ופתח קריאה</button><button id="cancel">ביטול</button></div>`);
  $('#cancel').onclick = closeModal;
  $('#nsend').onclick = async () => {
    try {
      const t = await api('POST', '/api/tickets/new', { instanceId: $('#ninst').value, phone: $('#nphone').value, name: $('#nname').value, text: $('#ntext').value });
      closeModal(); S.tickets.set(t.id, t); S.tab = S.me.role === 'admin' ? S.tab : 'mine'; openTicket(t.id);
    } catch (e) { toast(e.message, true, 6000); }
  };
}

// ---------- הגדרות אישיות ----------
function mySettingsDialog() {
  const s = Sounds.settings;
  const opts = (cur) => Object.entries(Sounds.TONES).map(([k, t]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${t.name}</option>`).join('');
  openModal(`<h3>⚙️ ההגדרות שלי</h3>
    <h4>צלצולים</h4>
    <label>צליל להודעה / קריאה חדשה</label><div class="row" style="margin:0"><select id="sNew" style="flex:1">${opts(s.newTone)}</select><button id="tNew">▶</button></div>
    <label>צלצול תזכורת (כשלקוח מחכה לתשובה)</label><div class="row" style="margin:0"><select id="sRem" style="flex:1">${opts(s.remindTone)}</select><button id="tRem">▶</button></div>
    <label>כל כמה זמן לצלצל תזכורת</label><select id="sSec">${[[15, '15 שניות'], [30, 'חצי דקה'], [60, 'דקה'], [120, '2 דקות'], [300, '5 דקות']].map(([v, n]) => `<option value="${v}" ${v === s.remindSec ? 'selected' : ''}>${n}</option>`).join('')}</select>
    <label>עוצמה</label><input id="sVol" type="range" min="0" max="1" step="0.05" value="${s.vol}">
    <h4>שינוי סיסמה</h4>
    <div class="grid2"><div><label>סיסמה נוכחית</label><input id="pOld" type="password"></div><div><label>סיסמה חדשה</label><input id="pNew" type="password"></div></div>
    <div class="row"><button id="pSave">שנה סיסמה</button><span class="spacer" style="flex:1"></span><button class="primary" id="done">סגור</button></div>`);
  $('#sNew').onchange = (e) => { s.newTone = e.target.value; Sounds.save(); Sounds.play(s.newTone); };
  $('#sRem').onchange = (e) => { s.remindTone = e.target.value; Sounds.save(); Sounds.play(s.remindTone); };
  $('#tNew').onclick = () => Sounds.play(s.newTone);
  $('#tRem').onclick = () => Sounds.play(s.remindTone);
  $('#sSec').onchange = (e) => { s.remindSec = Number(e.target.value); Sounds.save(); };
  $('#sVol').oninput = (e) => { s.vol = Number(e.target.value); Sounds.save(); };
  $('#pSave').onclick = async () => {
    try { await api('POST', '/api/me/password', { old: $('#pOld').value, password: $('#pNew').value }); toast('הסיסמה שונתה ✓'); $('#pOld').value = $('#pNew').value = ''; }
    catch (e) { toast(e.message, true); }
  };
  $('#done').onclick = closeModal;
}

// =====================================================================
// ניהול (מנהל בלבד)
// =====================================================================
let A = null; // {config, users, instances}
async function adminDialog(tab = 'deps') {
  try { A = await api('GET', '/api/admin/config'); } catch (e) { return toast(e.message, true); }
  const tabs = [['deps', '🏷️ מחלקות וניתוב'], ['users', '👥 עובדים'], ['wa', '📱 מספרי וואטסאפ'], ['ai', '🤖 AI ומענה אוטומטי'], ['general', '⚙️ כללי']];
  openModal(`<h3>🛠️ ניהול המוקד</h3><div class="stabs">${tabs.map(([k, n]) => `<button data-k="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('')}</div><div id="apane"></div>
    <div class="row"><span style="flex:1"></span><button id="aclose">סגור</button></div>`, true);
  box.querySelectorAll('.stabs button').forEach((b) => (b.onclick = () => adminDialog(b.dataset.k)));
  $('#aclose').onclick = closeModal;
  ({ deps: adminDeps, users: adminUsers, wa: adminWa, ai: adminAi, general: adminGeneral })[tab]();
}
const userOptions = (cur) => `<option value="">— בחר עובד —</option>` + A.users.filter((u) => u.active).map((u) => `<option value="${u.id}" ${u.id === cur ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
async function saveConfig(patch, msg = 'נשמר ✓') {
  try { const r = await api('POST', '/api/admin/config', patch); A.config = r.config; toast(msg); return true; } catch (e) { toast(e.message, true); return false; }
}

function adminDeps() {
  const deps = A.config.departments.map((d) => ({ ...d }));
  const draw = () => {
    $('#apane').innerHTML = `<div class="hint">כל פנייה חדשה מלקוח נקראת על ידי Claude, שמחליט לאיזו מחלקה היא שייכת לפי התיאור – ומעביר לעובד של המחלקה.
      פנייה שלא זוהתה (למשל רק "שלום") עוברת למנהל.</div>
      ${deps.map((d, i) => `<div class="card2"><div class="grid2">
        <div><label>שם המחלקה</label><input data-i="${i}" data-f="name" value="${esc(d.name)}" placeholder="הנהלת חשבונות"></div>
        <div><label>העובד שמקבל את הפניות</label><select data-i="${i}" data-f="userId">${userOptions(d.userId)}</select></div></div>
        <label>במה המחלקה מטפלת? (בשביל ה-AI – כמה שיותר דוגמאות)</label>
        <textarea data-i="${i}" data-f="description" rows="2" placeholder="חשבוניות, קבלות, תשלומים, חובות, החזרים, הצעות מחיר">${esc(d.description)}</textarea>
        <div class="row" style="margin-top:6px"><button class="ghost" data-del="${i}">🗑️ מחק מחלקה</button></div></div>`).join('')}
      <div class="row"><button id="addDep">+ הוסף מחלקה</button><span style="flex:1"></span><button class="primary" id="saveDeps">💾 שמור</button></div>`;
    $('#apane').querySelectorAll('[data-f]').forEach((el) => (el.oninput = el.onchange = () => (deps[el.dataset.i][el.dataset.f] = el.value)));
    $('#apane').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { deps.splice(Number(b.dataset.del), 1); draw(); }));
    $('#addDep').onclick = () => { deps.push({ name: '', description: '', userId: '' }); draw(); };
    $('#saveDeps').onclick = () => saveConfig({ departments: deps });
  };
  if (!deps.length) {
    deps.push(
      { name: 'הנהלת חשבונות', description: 'חשבוניות, קבלות, תשלומים, חובות, החזרים, הצעות מחיר, הוראות קבע', userId: '' },
      { name: 'תמיכת מרכזיות', description: 'מרכזייה, טלפונים, שלוחות, הקלטות, IVR, שיחות לא נכנסות, קווים, ניתובי שיחות', userId: '' },
      { name: 'תמיכת מחשוב', description: 'מחשבים, מדפסות, רשת, אינטרנט, מיילים, תוכנות, וירוסים, שרתים, גיבויים', userId: '' },
    );
  }
  draw();
}

function adminUsers() {
  const draw = () => {
    $('#apane').innerHTML = `<table><tr><th>שם</th><th>שם משתמש</th><th>תפקיד</th><th>פעיל</th><th></th></tr>
      ${A.users.map((u) => `<tr><td>${esc(u.name)}</td><td dir="ltr">${esc(u.username)}</td><td>${u.role === 'admin' ? 'מנהל' : 'נציג'}</td><td>${u.active ? '✓' : '✗'}</td><td><button class="ghost" data-edit="${u.id}">✏️ עריכה</button></td></tr>`).join('')}</table>
      <div class="card2" style="margin-top:14px" id="uform"></div>`;
    $('#apane').querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => form(A.users.find((u) => u.id === b.dataset.edit))));
    form(null);
  };
  const form = (u) => {
    $('#uform').innerHTML = `<b>${u ? 'עריכת ' + esc(u.name) : '+ עובד חדש'}</b>
      <div class="grid2"><div><label>שם</label><input id="uname" value="${esc(u?.name || '')}" placeholder="טל"></div>
      <div><label>שם משתמש (לכניסה, באנגלית)</label><input id="uuser" dir="ltr" value="${esc(u?.username || '')}" placeholder="tal"></div>
      <div><label>${u ? 'סיסמה חדשה (ריק = בלי שינוי)' : 'סיסמה'}</label><input id="upass" type="text" dir="ltr"></div>
      <div><label>תפקיד</label><select id="urole"><option value="agent">נציג – רואה רק את הקריאות שלו</option><option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>מנהל – רואה הכל ומנהל</option></select></div></div>
      ${u ? `<label class="check"><input type="checkbox" id="uactive" ${u.active ? 'checked' : ''}> פעיל (אפשר להיכנס ולקבל קריאות)</label>` : ''}
      <div class="row"><button class="primary" id="usave">💾 שמור</button>${u ? '<button id="unew">+ עובד חדש</button>' : ''}</div>`;
    if ($('#unew')) $('#unew').onclick = () => form(null);
    $('#usave').onclick = async () => {
      try {
        await api('POST', '/api/admin/users', { id: u?.id, name: $('#uname').value, username: $('#uuser').value, password: $('#upass').value, role: $('#urole').value, active: u ? $('#uactive').checked : true });
        A = await api('GET', '/api/admin/config'); S.users = await api('GET', '/api/users');
        toast('נשמר ✓'); draw();
      } catch (e) { toast(e.message, true); }
    };
  };
  draw();
}

function adminWa() {
  const stateOf = (id) => (A.instances.find((x) => x.id === id) || {}).state || '';
  const stateText = (s) => s === 'authorized' ? '🟢 מחובר' : s === 'notAuthorized' ? '🔴 לא מחובר – סרוק QR באתר Green API' : s.startsWith('error') ? '🔴 ' + s : s === 'unknown' || !s ? '⚪ לא ידוע' : '🟡 ' + s;
  const card = (i) => `<div class="card2" data-card="${i.id || 'new'}">
    <div class="grid2"><div><label>שם (למשל: משרד, עסקי)</label><input data-f="name" value="${esc(i.name || '')}"></div>
    <div><label>מצב</label><div style="padding-top:8px">${i.id ? stateText(stateOf(i.id)) : '—'}</div></div>
    <div><label>idInstance</label><input data-f="idInstance" dir="ltr" value="${esc(i.idInstance || '')}"></div>
    <div><label>apiTokenInstance</label><input data-f="token" dir="ltr" value="${esc(i.token || '')}"></div>
    <div><label>apiUrl</label><input data-f="apiUrl" dir="ltr" value="${esc(i.apiUrl || 'https://api.green-api.com')}"></div>
    <div><label>mediaUrl</label><input data-f="mediaUrl" dir="ltr" value="${esc(i.mediaUrl || 'https://media.green-api.com')}"></div></div>
    <label class="check"><input type="checkbox" data-f="enabled" ${i.enabled !== false ? 'checked' : ''}> פעיל</label>
    <div class="row"><button class="primary" data-save>💾 שמור ובדוק חיבור</button>${i.id ? '<button class="ghost" data-del>🗑️ מחק</button>' : ''}</div></div>`;
  $('#apane').innerHTML = `<div class="hint">את הפרטים מעתיקים מהאתר של Green API (console.green-api.com) ← בחירת ה-instance.
    השמירה גם מפעילה ב-Green API את ההתראות שהמוקד צריך. הסריקה של ה-QR נעשית באתר של Green API – פעם אחת לכל מספר.</div>
    ${A.config.instances.map(card).join('')}${card({})}`;
  $('#apane').querySelectorAll('[data-card]').forEach((c) => {
    const id = c.dataset.card === 'new' ? null : c.dataset.card;
    c.querySelector('[data-save]').onclick = async () => {
      const v = {}; c.querySelectorAll('[data-f]').forEach((el) => (v[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value));
      if (!v.idInstance || !v.token) return toast('חסר idInstance או token', true);
      toast('בודק חיבור...');
      try {
        const r = await api('POST', '/api/admin/instances', { id, ...v });
        toast(r.error ? 'נשמר, אבל יש בעיה: ' + r.error : r.state === 'authorized' ? 'מחובר ✓ ההתראות הופעלו' : 'נשמר. מצב: ' + r.state, !!r.error || r.state !== 'authorized', 7000);
        adminDialog('wa');
      } catch (e) { toast(e.message, true); }
    };
    const del = c.querySelector('[data-del]');
    if (del) del.onclick = async () => { if (!del.dataset.sure) { del.dataset.sure = 1; del.textContent = 'בטוח? לחץ שוב'; return; } await api('DELETE', '/api/admin/instances/' + id); adminDialog('wa'); };
  });
}

function adminAi() {
  const c = A.config;
  $('#apane').innerHTML = `<h4 style="margin-top:0">🤖 ניתוב עם Claude</h4>
    <label class="check"><input type="checkbox" id="aiOn" ${c.ai.enabled ? 'checked' : ''}> להפעיל ניתוב אוטומטי</label>
    <div class="grid2"><div><label>מפתח API של Anthropic</label><input id="aiKey" dir="ltr" value="${esc(c.ai.apiKey)}" placeholder="sk-ant-..."></div>
    <div><label>מודל</label><input id="aiModel" dir="ltr" value="${esc(c.ai.model)}"></div></div>
    <div class="hint">את המפתח יוצרים ב-console.anthropic.com ← API Keys. הניתוב עולה בערך אגורות בודדות לפנייה.</div>
    <div class="row"><input id="aiTest" style="flex:1" placeholder="נסה: 'המרכזייה לא מעבירה שיחות לשלוחה 3'"><button id="aiTestBtn">🧪 בדוק ניתוב</button></div>
    <div class="hint" id="aiRes"></div>
    <h4>💬 הודעה אוטומטית ללקוח</h4>
    <label class="check"><input type="checkbox" id="arOn" ${c.autoReply.enabled ? 'checked' : ''}> לשלוח הודעה אוטומטית כשנפתחת קריאה</label>
    <label>כשזוהתה מחלקה</label><textarea id="arRouted" rows="3">${esc(c.autoReply.routed)}</textarea>
    <label>כשלא זוהתה מחלקה</label><textarea id="arUnknown" rows="3">${esc(c.autoReply.unknown)}</textarea>
    <div class="hint">אפשר להשתמש ב: <code>{name}</code> שם הלקוח · <code>{agent}</code> שם העובד · <code>{department}</code> המחלקה · <code>{company}</code> שם החברה</div>
    <div class="row"><span style="flex:1"></span><button class="primary" id="aiSave">💾 שמור</button></div>`;
  $('#aiSave').onclick = () => saveConfig({
    ai: { enabled: $('#aiOn').checked, apiKey: $('#aiKey').value.trim(), model: $('#aiModel').value.trim() },
    autoReply: { enabled: $('#arOn').checked, routed: $('#arRouted').value, unknown: $('#arUnknown').value },
  });
  $('#aiTestBtn').onclick = async () => {
    $('#aiRes').textContent = 'שואל את Claude...';
    try { const r = await api('POST', '/api/admin/test-ai', { text: $('#aiTest').value }); $('#aiRes').textContent = `➜ ${r.departmentName} – ${r.reason}`; }
    catch (e) { $('#aiRes').textContent = e.message; }
  };
}

function adminGeneral() {
  const c = A.config;
  $('#apane').innerHTML = `<div class="grid2">
    <div><label>שם החברה</label><input id="gName" value="${esc(c.companyName)}"></div>
    <div><label>כמה שניות לחכות להודעות נוספות לפני ניתוב</label><input id="gDelay" type="number" min="0" max="120" value="${c.routeDelaySec}"></div>
    <div><label>מאיפה אפשר להיכנס למוקד</label><select id="gHost"><option value="127.0.0.1">רק מהשרת עצמו (מומלץ)</option><option value="0.0.0.0" ${c.host === '0.0.0.0' ? 'selected' : ''}>גם ממחשבים אחרים ברשת המשרד</option></select></div>
    <div><label>פורט</label><input id="gPort" type="number" value="${c.port}"></div></div>
    <h4>👥 קבוצות</h4>
    <label class="check"><input type="checkbox" id="gGroups" ${c.groups.enabled ? 'checked' : ''}> הודעות מקבוצות פותחות קריאות</label>
    <label class="check"><input type="checkbox" id="gGroupsAR" ${c.groups.autoReply ? 'checked' : ''}> לשלוח מענה אוטומטי גם לקבוצות</label>
    <h4>🔕 צ'אטים וקבוצות שמתעלמים מהם</h4>
    <div id="ignList">${c.ignoredChats.length ? c.ignoredChats.map((x, i) => `<div class="row" style="margin-top:4px"><span style="flex:1">${x.isGroup ? '👥' : '👤'} ${esc(x.name || x.chatId)}</span><button class="ghost" data-unign="${i}">החזר</button></div>`).join('') : '<div class="hint">אין. (כפתור "🔕 התעלם" בראש כל שיחה)</div>'}</div>
    <div class="hint">שינוי "מאיפה אפשר להיכנס" או הפורט נכנס לתוקף אחרי הפעלה מחדש של השרת.<br>
    לקוח שכותב "שלום" ואז את הבעיה – ההמתנה נותנת ל-AI את כל ההודעות ביחד, וכך הניתוב מדויק יותר.</div>
    <div class="row"><span style="flex:1"></span><button class="primary" id="gSave">💾 שמור</button></div>`;
  let ign = [...c.ignoredChats];
  $('#apane').querySelectorAll('[data-unign]').forEach((b) => (b.onclick = () => { ign.splice(Number(b.dataset.unign), 1); b.parentElement.remove(); }));
  $('#gSave').onclick = () => saveConfig({ companyName: $('#gName').value, routeDelaySec: $('#gDelay').value, host: $('#gHost').value, port: $('#gPort').value,
    groups: { enabled: $('#gGroups').checked, autoReply: $('#gGroupsAR').checked }, ignoredChats: ign });
}

boot();

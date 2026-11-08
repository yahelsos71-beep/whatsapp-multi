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

const localPhone = (p) => { p = String(p || ''); if (!p.startsWith('972')) return p ? '+' + p : ''; const d = '0' + p.slice(3); return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3) : d.length === 9 ? d.slice(0, 2) + '-' + d.slice(2) : d; };
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
      <button id="taskBtn" title="הודעה בקבוצה המשותפת – פותחת קריאה אצל הצד השני">${S.me.role === 'admin' ? '📋 קריאה לעובד' : '📋 פנייה למנהל'}</button>
      <button id="newChat" title="שליחת הודעה ללקוח חדש">✉️ שיחה חדשה</button>
      <button id="muteBtn"></button>
      <button id="mySettings" title="צלצולים וסיסמה">⚙️</button>
      ${S.me.role === 'admin' ? '<button id="dashBtn">📊 דשבורד</button><button id="adminBtn">🛠️ ניהול</button>' : ''}
      <span class="me">${esc(S.me.name)} · v${S.version}</span>
      <button class="ghost" id="logout">יציאה</button>
    </div>
    <div class="side">
      <div class="tabs" id="tabs"></div>
      <div class="search" style="display:flex;gap:6px"><input id="q" placeholder="🔍 חיפוש לפי שם או טלפון" style="flex:1">
        ${S.me.role === 'admin' ? '<select id="fuser" title="סינון לפי עובד" style="width:auto;max-width:130px"></select>' : ''}</div>
      <div class="list" id="list"></div>
    </div>
    <div class="chat" id="chat"></div>
  </div>`;
  if (S.me.role === 'admin') { S.tab = localStorage.getItem('hd-tab') || 'all'; $('#adminBtn').onclick = () => adminDialog(); $('#dashBtn').onclick = () => dashboardDialog(); }
  $('#logout').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); location.reload(); };
  $('#mySettings').onclick = mySettingsDialog;
  $('#newChat').onclick = newChatDialog;
  $('#taskBtn').onclick = taskDialog;
  $('#q').oninput = (e) => { S.q = e.target.value.trim(); renderList(); };
  if ($('#fuser')) $('#fuser').onchange = (e) => { S.fuser = e.target.value; try { localStorage.setItem('hd-fuser', S.fuser); } catch {} renderList(); };
  const paintMute = () => { $('#muteBtn').textContent = Sounds.settings.muted ? '🔕' : '🔔'; $('#muteBtn').title = Sounds.settings.muted ? 'הצלצולים כבויים' : 'הצלצולים פעילים'; };
  $('#muteBtn').onclick = () => { Sounds.settings.muted = !Sounds.settings.muted; Sounds.save(); paintMute(); };
  paintMute();

  const [list, users, insts] = await Promise.all([api('GET', '/api/tickets'), api('GET', '/api/users'), api('GET', '/api/instances')]);
  S.tickets = new Map(list.map((t) => [t.id, t]));
  S.users = users; S.instances = insts;
  fillUserFilter();
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

function fillUserFilter() {
  const el = $('#fuser'); if (!el) return;
  try { S.fuser = S.fuser ?? localStorage.getItem('hd-fuser') ?? ''; } catch { S.fuser = S.fuser || ''; }
  el.innerHTML = `<option value="">👥 כל העובדים</option>` + S.users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('') + `<option value="none">לא משויך</option>`;
  if (![...el.options].some((o) => o.value === S.fuser)) S.fuser = '';
  el.value = S.fuser;
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
  if (S.me.role === 'admin' && S.fuser && S.tab !== 'mine') {
    list = list.filter((t) => (S.fuser === 'none' ? !t.assigneeId : t.assigneeId === S.fuser || (S.tab === 'closed' && t.closedBy === S.fuser)));
  }
  if (S.q) {
    const q = S.q.toLowerCase();
    list = list.filter((t) => String(t.customerName).toLowerCase().includes(q) || String(t.company || '').toLowerCase().includes(q) || String(t.phone).includes(q.replace(/\D/g, '') || '§') || String(t.id) === q.replace('#', ''));
  }
  return list;
}

function renderList() {
  const el = $('#list'); if (!el) return;
  if ($('#fuser')) $('#fuser').style.display = S.tab === 'mine' ? 'none' : '';
  const list = currentList();
  const now = Date.now();
  const myWaiting = [...S.tickets.values()].filter((t) => t.assigneeId === S.me.id && t.awaiting).length;
  document.title = (myWaiting ? `(${myWaiting}) ` : '') + 'מוקד וואטסאפ';
  const counts = { mine: [...S.tickets.values()].filter((t) => t.assigneeId === S.me.id).length, all: S.tickets.size, routing: [...S.tickets.values()].filter((t) => t.status === 'routing' || !t.assigneeId).length };
  for (const [k, n] of Object.entries(counts)) { const c = document.querySelector(`[data-cnt="${k}"]`); if (c) c.textContent = n ? `(${n})` : ''; }
  if (!list.length) {
    el.innerHTML = `<div class="empty">${S.q ? 'לא נמצא' : S.fuser && S.tab !== 'mine' ? 'אין קריאות לעובד הזה' : S.tab === 'closed' ? 'אין קריאות סגורות' : 'אין קריאות פתוחות 🎉'}</div>`;
    return;
  }
  el.innerHTML = list.map((t) => {
    const wait = t.awaiting ? now - (t.lastInAt || t.updatedAt) : 0;
    const cls = ['item', t.id === S.sel ? 'sel' : '', t.awaiting ? 'wait' : '', wait > 15 * 60000 ? 'late' : wait > 5 * 60000 ? 'mid' : '', t.status === 'routing' ? 'routing' : ''].join(' ');
    return `<div class="${cls}" data-id="${t.id}">
      <div class="av" style="background:${avColor(t.phone)}">${esc(initials(t.customerName))}</div>
      <div class="body">
        <div class="row1"><span class="name">${esc(t.customerName)}${!t.isGroup && t.customerName !== localPhone(t.phone) ? ` <span class="ph" dir="ltr">${localPhone(t.phone)}</span>` : ''}</span><span class="time">${fmtTime(t.updatedAt)}</span></div>
        <div class="row2"><span class="last">${t.lastDir === 'out' ? '↩ ' : ''}${esc(t.lastText)}</span>${t.awaiting ? '<span class="dot"></span>' : ''}</div>
        <div class="row3">
          <span class="chip">#${t.id}</span>${t.isGroup ? '<span class="chip">👥 קבוצה</span>' : ''}${t.company ? `<span class="chip dep">🏢 ${esc(t.company)}</span>` : ''}
          ${t.instanceName ? `<span class="chip">📱 ${esc(t.instanceName)}</span>` : ''}
          ${t.status === 'routing' ? `<span class="chip">🤖 ${t.aiTurns ? 'העוזר מברר עם הלקוח...' : 'מנתב...'}</span>` : t.departmentName ? `<span class="chip dep">${esc(t.departmentName)}</span>` : ''}
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
    <div class="who"><b>${esc(t.customerName)}${!t.isGroup ? ` <span class="ph big" dir="ltr">${localPhone(t.phone)}</span>` : ''}${t.company ? ` <span class="chip dep">🏢 ${esc(t.company)}</span>` : ''}</b>
      ${t.isGroup ? '<small>👥 קבוצה</small>' : ''} <small>#${t.id} · 📱 ${esc(t.instanceName)}${t.departmentName ? ' · ' + esc(t.departmentName) : ''}${t.assigneeName ? ' · 👤 ' + esc(t.assigneeName) : ''}${t.status === 'closed' ? ' · ✅ סגורה' : ''}</small></div>
    ${ro ? '<span class="chip">צפייה בלבד</span>' : t.status === 'closed'
      ? '<button id="reopenBtn">🔄 פתח מחדש</button>'
      : '<button id="transferBtn">↪️ העבר שיחה</button><button class="primary" id="closeBtn">✅ סגור קריאה</button>'}
    ${!t.isGroup && !ro ? `<button class="ghost" id="contactBtn" title="שמירת שם וחברה ללקוח הזה">👤 ${t.contact ? 'איש קשר' : 'שמור איש קשר'}</button>` : ''}
    <button class="ghost" id="waHistBtn" title="ההודעות הקודמות עם ${t.isGroup ? 'הקבוצה' : 'הלקוח'} מוואטסאפ – גם מלפני המוקד">📜 היסטוריה</button>
    ${t.pinnedTo ? `<span class="chip who">📌 קבוע: ${esc(t.pinnedTo)}</span>` : ''}
    ${S.me.role === 'admin' && !ro ? `<button class="ghost" id="pinBtn" title="כל הודעה מ${t.isGroup ? 'הקבוצה' : 'הצ׳אט'} הזה תגיע ישר לעובד שתבחר, בלי AI">📌 קבע לעובד</button>` : ''}
    ${S.me.role === 'admin' && !ro ? `<button class="ghost" id="ignoreBtn" title="לא לפתוח יותר קריאות מ${t.isGroup ? 'הקבוצה' : 'הצ׳אט'} הזה">🔕 התעלם</button>` : ''}`;
  if ($('#transferBtn')) $('#transferBtn').onclick = transferDialog;
  if ($('#closeBtn')) $('#closeBtn').onclick = closeTicket;
  $('#waHistBtn').onclick = () => waHistoryDialog(t);
  if ($('#contactBtn')) $('#contactBtn').onclick = () => {
    const c = t.contact;
    openModal(`<h3>👤 ${c ? 'עריכת איש קשר' : 'שמירת איש קשר'}</h3>
      <div class="grid2"><div><label>שם</label><input id="kn" value="${esc(c ? c.name : (t.waName && !/^[\d+\s-]+$/.test(t.waName) ? t.waName : ''))}"></div>
      <div><label>חברה</label><input id="kc" value="${esc(c ? c.company : '')}"></div></div>
      <label>טלפונים (מופרדים בפסיק)</label><input id="kp" dir="ltr" value="${esc(c ? c.phones.map(localPhone).join(', ') : localPhone(t.phone))}">
      <div class="hint">השם והחברה יופיעו במוקד אצל כל העובדים, בכל הקריאות של הלקוח.</div>
      <div class="row"><button class="primary" id="ksave">💾 שמור</button><button id="cancel">ביטול</button></div>`);
    $('#cancel').onclick = closeModal;
    $('#kn').focus();
    $('#ksave').onclick = async () => {
      try { await api('POST', '/api/contacts', { id: c ? c.id : undefined, name: $('#kn').value, company: $('#kc').value, phones: $('#kp').value }); closeModal(); toast('איש הקשר נשמר ✓'); openTicket(t.id); }
      catch (e) { toast(e.message, true); }
    };
  };
  if ($('#pinBtn')) $('#pinBtn').onclick = () => {
    openModal(`<h3>📌 קיבוע ${t.isGroup ? 'הקבוצה' : 'הצ׳אט'} "${esc(t.customerName)}" לעובד</h3>
      <div class="hint">כל הודעה חדשה מכאן תיפתח כקריאה ישר אצל העובד – בלי ניתוב AI.${t.isGroup ? '<br>קבוצה שמקובעת לעובד מופיעה גם בכפתור "📋 קריאה לעובד".' : ''}</div>
      <div class="pick" style="margin-top:10px">${S.users.map((u) => `<button data-id="${u.id}">${esc(u.name)}${t.pinnedTo === u.name ? ' ✓' : ''}</button>`).join('')}
      ${t.pinnedTo ? '<button data-id="" class="danger">✖ בטל קיבוע</button>' : ''}</div>
      <div class="row"><button id="cancel">ביטול</button></div>`);
    $('#cancel').onclick = closeModal;
    box.querySelectorAll('.pick button').forEach((b) => (b.onclick = async () => {
      try { const r = await api('POST', `/api/tickets/${t.id}/pin`, { userId: b.dataset.id || null }); closeModal(); toast(r.pinnedTo ? `📌 קובע ל${r.pinnedTo} ✓` : 'הקיבוע בוטל'); openTicket(t.id); }
      catch (er) { toast(er.message, true); }
    }));
  };
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
    : m.dir === 'in' && m.senderName ? `<div class="by sender">${m.staff ? '👤 ' : ''}${esc(m.senderName)}</div>` : '';
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
    <label>🔍 חיפוש באנשי הקשר (שם חברה, שם או טלפון)</label>
    <input id="csearch" placeholder="למשל: קי סי, משה, 052..." autocomplete="off">
    <div class="pick" id="cres" style="max-height:220px;overflow-y:auto;margin-top:6px"></div>
    <label>מאיזה מספר לשלוח?</label><select id="ninst">${insts.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select>
    <div class="grid2"><div><label>טלפון הלקוח</label><input id="nphone" dir="ltr" placeholder="0521234567"></div>
    <div><label>שם</label><input id="nname"></div></div>
    <label>הודעה</label><textarea id="ntext" rows="4"></textarea>
    <div class="row"><button class="primary" id="nsend">שלח ופתח קריאה</button><button id="cancel">ביטול</button></div>`);
  $('#cancel').onclick = closeModal;
  const fmt = (p) => (p.startsWith('972') ? '0' + p.slice(3) : p);
  let timer;
  const search = async () => {
    const q = $('#csearch').value.trim();
    if (!q) { $('#cres').innerHTML = ''; return; }
    const r = await api('GET', '/api/contacts?q=' + encodeURIComponent(q)).catch(() => ({ list: [], total: 0 }));
    if (!r.total) { $('#cres').innerHTML = '<div class="hint">אין עדיין אנשי קשר – המנהל מייבא אותם ב"ניהול ← 📇 אנשי קשר"</div>'; return; }
    $('#cres').innerHTML = r.list.length ? r.list.flatMap((c) => c.phones.map((p) => `<button data-p="${p}" data-n="${esc(c.name || c.company)}">
      <span style="flex:1">${c.company ? '🏢 ' + esc(c.company) : ''}${c.company && c.name ? ' · ' : ''}${esc(c.name || '')}</span><span dir="ltr" class="chip">${fmt(p)}</span></button>`)).join('')
      : '<div class="hint">לא נמצא</div>';
    $('#cres').querySelectorAll('button').forEach((b) => (b.onclick = () => {
      $('#nphone').value = fmt(b.dataset.p); $('#nname').value = b.dataset.n; $('#cres').innerHTML = ''; $('#csearch').value = b.dataset.n; $('#ntext').focus();
    }));
  };
  $('#csearch').oninput = () => { clearTimeout(timer); timer = setTimeout(search, 200); };
  $('#csearch').focus();
  $('#nsend').onclick = async () => {
    try {
      const t = await api('POST', '/api/tickets/new', { instanceId: $('#ninst').value, phone: $('#nphone').value, name: $('#nname').value, text: $('#ntext').value });
      closeModal(); S.tickets.set(t.id, t); openTicket(t.id);
    } catch (e) { toast(e.message, true, 6000); }
  };
}

// ---------- דשבורד (מנהל) ----------
let dashTimer = null;
function dur(ms) {
  if (ms == null) return '—';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'פחות מדקה';
  if (m < 60) return `${m} דק׳`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}:${String(m % 60).padStart(2, '0')} שע׳`;
  return `${Math.floor(h / 24)} ימים ${h % 24} שע׳`;
}
async function dashboardDialog(period = localStorage.getItem('hd-dash') || 'today') {
  clearInterval(dashTimer);
  let st;
  try { st = await api('GET', '/api/admin/stats?period=' + period); } catch (e) { return toast(e.message, true); }
  if (modal.classList.contains('on') && !box.querySelector('#dash')) closeModal();
  const n = st.now, p = st.period_;
  const waitCls = (ms) => (ms > 15 * 60000 ? 'late' : ms > 5 * 60000 ? 'mid' : '');
  const periods = [['today', 'היום'], ['week', '7 ימים'], ['month', '30 יום'], ['all', 'הכל']];
  const max = Math.max(1, ...p.byUser.map((u) => u.closed));
  const tile = (label, value, sub = '', cls = '') => `<div class="tile ${cls}"><div class="tl">${label}</div><div class="tv">${value}</div>${sub ? `<div class="ts">${sub}</div>` : ''}</div>`;
  const html = `<div id="dash">
    <div class="row" style="margin:0 0 12px;justify-content:space-between"><h3 style="margin:0">📊 דשבורד</h3>
      <div class="seg">${periods.map(([k, l]) => `<button data-p="${k}" class="${k === period ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <h4 style="margin-top:0">עכשיו</h4>
    <div class="tiles">
      ${tile('קריאות פתוחות', n.open)}
      ${tile('ממתינות לתשובה', n.waiting, n.waiting ? 'לקוחות שמחכים' : 'אף אחד לא מחכה 👍')}
      ${tile('ההמתנה הארוכה ביותר', n.waiting ? dur(n.oldestWaitMs) : '—', '', n.waiting ? 'wt ' + waitCls(n.oldestWaitMs) : '')}
      ${tile('העוזר מברר עם לקוח', n.routing)}
    </div>
    <table class="dtable"><tr><th>עובד</th><th>פתוחות</th><th>ממתינות</th><th>ההמתנה הארוכה</th></tr>
      ${n.byUser.map((u) => `<tr><td>${esc(u.name)}</td><td>${u.open}</td><td>${u.waiting ? `<span class="dot" style="display:inline-block;margin-left:6px;vertical-align:middle"></span>${u.waiting}` : '0'}</td>
        <td>${u.waiting ? `<span class="chip waittime ${waitCls(u.oldestWaitMs)}">⏳ ${dur(u.oldestWaitMs)}</span>` : '—'}</td></tr>`).join('')}
      ${n.unassigned ? `<tr><td>לא משויך</td><td>${n.unassigned}</td><td></td><td></td></tr>` : ''}</table>
    ${n.byDept.length ? `<div class="hint" style="margin-top:6px">לפי מחלקה: ${n.byDept.map((d) => `${esc(d.name)} <b>${d.open}</b>`).join(' · ')}${n.noDept ? ` · בלי מחלקה <b>${n.noDept}</b>` : ''}</div>` : ''}
    <h4>${periods.find((x) => x[0] === period)[1]}</h4>
    <div class="tiles">${tile('קריאות שנפתחו', p.opened)}${tile('קריאות שנסגרו', p.closed)}</div>
    <table class="dtable"><tr><th>עובד</th><th style="width:40%">קריאות שסגר/ה</th><th>זמן טיפול ממוצע</th><th>זמן תגובה ראשונה ממוצע</th></tr>
      ${p.byUser.map((u) => `<tr><td>${esc(u.name)}</td>
        <td><div class="bar" title="${esc(u.name)}: ${u.closed} קריאות נסגרו">${u.closed ? `<i style="width:${(u.closed / max) * 100}%"></i>` : ""}<b>${u.closed}</b></div></td>
        <td>${dur(u.avgHandleMs)}</td><td>${dur(u.avgFirstResponseMs)}</td></tr>`).join('')}</table>
    <div class="hint">זמן טיפול = מפתיחת הקריאה עד הסגירה. תגובה ראשונה = מההודעה הראשונה של הלקוח עד התשובה הראשונה של עובד (בלי העוזר והמענה האוטומטי).<br>מתעדכן לבד כל 20 שניות · ${new Date(st.generatedAt).toLocaleTimeString('he-IL')}</div>
    <div class="row"><span style="flex:1"></span><button id="dclose">סגור</button></div></div>`;
  if (box.querySelector('#dash')) box.innerHTML = html; else openModal(html, true);
  box.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => { localStorage.setItem('hd-dash', b.dataset.p); dashboardDialog(b.dataset.p); }));
  $('#dclose').onclick = () => { clearInterval(dashTimer); closeModal(); };
  dashTimer = setInterval(() => { if (box.querySelector('#dash') && modal.classList.contains('on')) dashboardDialog(period); else clearInterval(dashTimer); }, 20000);
}

async function waHistoryDialog(t, count = 100) {
  openModal(`<h3>📜 היסטוריית וואטסאפ – ${esc(t.customerName)}</h3><div class="hint">טוען מ-Green API...</div>`, true);
  let r;
  try { r = await api('GET', `/api/tickets/${t.id}/wa-history?count=${count}`); }
  catch (e) { box.innerHTML = `<h3>📜 היסטוריית וואטסאפ</h3><div class="err">${esc(e.message)}</div><div class="row"><button id="cancel">סגור</button></div>`; $('#cancel').onclick = closeModal; return; }
  let lastDay = '', html = '';
  for (const m of r.items) {
    const day = new Date(m.ts).toLocaleDateString('he-IL');
    if (day !== lastDay) { html += `<div class="day">${day}</div>`; lastDay = day; }
    html += messageHtml({ ...m, byName: '' });
  }
  box.innerHTML = `<h3>📜 היסטוריית וואטסאפ – ${esc(t.customerName)} <span class="hint">(${r.items.length} הודעות אחרונות)</span></h3>
    ${r.more ? `<div class="row" style="margin:0 0 8px"><button id="more">⬆ טען עוד הודעות ישנות</button></div>` : ''}
    <div class="msgs" id="hmsgs" style="max-height:62vh;padding:10px 3%;background:var(--bg);border-radius:10px">${html || '<div class="empty">אין הודעות</div>'}</div>
    <div class="row"><span style="flex:1" class="hint">צפייה בלבד. כדי לענות – סגור את החלון וכתוב בשיחה.</span><button id="cancel">סגור</button></div>`;
  $('#cancel').onclick = closeModal;
  if ($('#more')) $('#more').onclick = () => waHistoryDialog(t, Math.min(1000, count * 3));
  const hm = $('#hmsgs'); hm.scrollTop = hm.scrollHeight;
}

async function taskDialog() {
  const list = await api('GET', '/api/tasks/targets').catch(() => []);
  const isAdmin = S.me.role === 'admin';
  if (!list.length) {
    openModal(`<h3>📋 ${isAdmin ? 'קריאה לעובד' : 'פנייה למנהל'}</h3><div class="hint">${isAdmin
      ? 'עוד לא הוגדרו קבוצות לעובדים.<br>כדי להגדיר: פותחים במוקד את הקבוצה (למשל "חיים וחני") ← <b>📌 קבע לעובד</b> ← בוחרים את חני.<br>(הקבוצה מופיעה במוקד אחרי שנשלחת בה הודעה כלשהי.)'
      : 'עוד לא הוגדרה קבוצה משותפת שלך עם המנהל. המנהל מגדיר אותה בכפתור 📌 קבע לעובד.'}</div><div class="row"><button id="cancel">סגור</button></div>`);
    $('#cancel').onclick = closeModal;
    return;
  }
  openModal(`<h3>📋 ${isAdmin ? 'קריאה לעובד' : 'פנייה למנהל'}</h3>
    <div class="hint">ההודעה נשלחת לקבוצה המשותפת בוואטסאפ, ונפתחת קריאה עם צלצול אצל ${isAdmin ? 'העובד' : 'הצד השני'} – עד שיענה או יסגור.</div>
    <label>למי?</label><div class="pick" id="tpick">${list.map((x, i) => `<button data-i="${i}"><b>${esc(x.userName)}</b><span class="chip">👥 ${esc(x.group)}</span></button>`).join('')}</div>
    <label>מה לכתוב?</label><textarea id="ttext" rows="4" placeholder="${isAdmin ? 'למשל: להתקשר ללקוח משה כהן לגבי החשבונית מאוקטובר' : 'למשל: לקוח מבקש הנחה – מאשר?'}"></textarea>
    <div class="row"><button class="primary" id="tsend" disabled>שלח</button><button id="cancel">ביטול</button></div>`);
  let sel = list.length === 1 ? list[0] : null;
  const mark = () => { box.querySelectorAll('#tpick button').forEach((x, i) => x.classList.toggle('primary', list[i] === sel)); $('#tsend').disabled = !sel; if (sel) $('#tsend').textContent = `שלח ל${sel.userName}`; };
  box.querySelectorAll('#tpick button').forEach((b) => (b.onclick = () => { sel = list[+b.dataset.i]; mark(); $('#ttext').focus(); }));
  mark();
  $('#cancel').onclick = closeModal;
  $('#tsend').onclick = async () => {
    try { const t = await api('POST', '/api/tasks', { key: sel.key, text: $('#ttext').value }); closeModal(); toast(`נשלח ל${sel.userName} ✓ קריאה #${t.id}`); }
    catch (e) { toast(e.message, true, 6000); }
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
  const tabs = [['deps', '🏷️ מחלקות וניתוב'], ['users', '👥 עובדים'], ['contacts', '📇 אנשי קשר'], ['wa', '📱 מספרי וואטסאפ'], ['ai', '🤖 AI ומענה אוטומטי'], ['general', '⚙️ כללי']];
  openModal(`<h3>🛠️ ניהול המוקד</h3><div class="stabs">${tabs.map(([k, n]) => `<button data-k="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('')}</div><div id="apane"></div>
    <div class="row"><span style="flex:1"></span><button id="aclose">סגור</button></div>`, true);
  box.querySelectorAll('.stabs button').forEach((b) => (b.onclick = () => adminDialog(b.dataset.k)));
  $('#aclose').onclick = closeModal;
  ({ deps: adminDeps, users: adminUsers, contacts: adminContacts, wa: adminWa, ai: adminAi, general: adminGeneral })[tab]();
}
const userOptions = (cur) => `<option value="">— בחר עובד —</option>` + A.users.filter((u) => u.active).map((u) => `<option value="${u.id}" ${u.id === cur ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
async function saveConfig(patch, msg = 'נשמר ✓') {
  try { const r = await api('POST', '/api/admin/config', patch); A.config = r.config; toast(msg); return true; } catch (e) { toast(e.message, true); return false; }
}

function adminDeps() {
  const deps = A.config.departments.map((d) => ({ ...d }));
  const rules = (A.config.personRules || []).map((r) => ({ ...r }));
  const draw = () => {
    $('#apane').innerHTML = `<div class="hint">כל פנייה חדשה מלקוח נקראת על ידי Claude, שמחליט לאיזו מחלקה היא שייכת לפי התיאור – ומעביר לעובד של המחלקה.
      פנייה שלא זוהתה (למשל רק "שלום") עוברת למנהל.</div>
      ${deps.map((d, i) => `<div class="card2"><div class="grid2">
        <div><label>שם המחלקה</label><input data-i="${i}" data-f="name" value="${esc(d.name)}" placeholder="הנהלת חשבונות"></div>
        <div><label>העובד שמקבל את הפניות</label><select data-i="${i}" data-f="userId">${userOptions(d.userId)}</select></div></div>
        <label>במה המחלקה מטפלת? (בשביל ה-AI – כמה שיותר דוגמאות)</label>
        <textarea data-i="${i}" data-f="description" rows="2" placeholder="חשבוניות, קבלות, תשלומים, חובות, החזרים, הצעות מחיר">${esc(d.description)}</textarea>
        <label>שאלות מקדימות שהעוזר ישאל כשיש תקלה (לא חובה)</label>
        <textarea data-i="${i}" data-f="questions" rows="2" placeholder="למשל: איזה מכשיר? מה בדיוק קורה? יש הודעת שגיאה? ממתי?">${esc(d.questions || '')}</textarea>
        <div class="row" style="margin-top:6px"><button class="ghost" data-del="${i}">🗑️ מחק מחלקה</button></div></div>`).join('')}
      <div class="row"><button id="addDep">+ הוסף מחלקה</button></div>
      <h4>👤 ניתוב לפי איש קשר</h4>
      <div class="hint">פנייה מהמספר הזה – או מכל <b>קבוצה שהוא חבר בה</b> – הולכת ישר לעובד שנבחר, בלי AI.</div>
      ${rules.map((r, i) => `<div class="row" style="margin-top:6px">
        <input data-r="${i}" data-rf="name" value="${esc(r.name || '')}" placeholder="שם (למשל דויד)" style="flex:1">
        <input data-r="${i}" data-rf="phone" dir="ltr" value="${esc(r.phone ? (r.phone.startsWith('972') ? '0' + r.phone.slice(3) : r.phone) : '')}" placeholder="05X-XXXXXXX" style="flex:1">
        <select data-r="${i}" data-rf="userId" style="flex:1">${userOptions(r.userId)}</select>
        <button class="ghost" data-rdel="${i}">🗑️</button></div>`).join('')}
      <div class="row"><button id="addRule">+ הוסף כלל</button><span style="flex:1"></span><button class="primary" id="saveDeps">💾 שמור</button></div>`;
    $('#apane').querySelectorAll('[data-rf]').forEach((el) => (el.oninput = el.onchange = () => (rules[el.dataset.r][el.dataset.rf] = el.value)));
    $('#apane').querySelectorAll('[data-rdel]').forEach((b) => (b.onclick = () => { rules.splice(Number(b.dataset.rdel), 1); draw(); }));
    $('#addRule').onclick = () => { rules.push({ name: '', phone: '', userId: '' }); draw(); };
    $('#apane').querySelectorAll('[data-f]').forEach((el) => (el.oninput = el.onchange = () => (deps[el.dataset.i][el.dataset.f] = el.value)));
    $('#apane').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { deps.splice(Number(b.dataset.del), 1); draw(); }));
    $('#addDep').onclick = () => { deps.push({ name: '', description: '', userId: '' }); draw(); };
    $('#saveDeps').onclick = () => saveConfig({ departments: deps, personRules: rules });
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
      <div><label>הטלפון הנייד של העובד (בשביל קבוצות)</label><input id="uphone" dir="ltr" value="${esc(u?.phone ? '0' + u.phone.slice(3) : '')}" placeholder="0521234567"></div>
      <div><label>תפקיד</label><select id="urole"><option value="agent">נציג – רואה רק את הקריאות שלו</option><option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>מנהל – רואה הכל ומנהל</option></select></div></div>
      ${u ? `<label class="check"><input type="checkbox" id="uactive" ${u.active ? 'checked' : ''}> פעיל (אפשר להיכנס ולקבל קריאות)</label>` : ''}
      <div class="row"><button class="primary" id="usave">💾 שמור</button>${u ? '<button id="unew">+ עובד חדש</button>' : ''}</div>`;
    if ($('#unew')) $('#unew').onclick = () => form(null);
    $('#usave').onclick = async () => {
      try {
        await api('POST', '/api/admin/users', { id: u?.id, name: $('#uname').value, username: $('#uuser').value, password: $('#upass').value, phone: $('#uphone').value, role: $('#urole').value, active: u ? $('#uactive').checked : true });
        A = await api('GET', '/api/admin/config'); S.users = await api('GET', '/api/users'); fillUserFilter();
        toast('נשמר ✓'); draw();
      } catch (e) { toast(e.message, true); }
    };
  };
  draw();
}

function adminContacts() {
  const fmt = (p) => (p.startsWith('972') ? '0' + p.slice(3) : p);
  $('#apane').innerHTML = `<div class="card2"><b>📥 ייבוא מ-iCount</b>
      <div class="hint">ב-iCount: <b>לקוחות ← רשימת לקוחות ← ייצוא לאקסל</b>. את הקובץ שירד בוחרים כאן (xlsx או csv).<br>
      ייבוא חדש מחליף את אנשי הקשר מהייבוא הקודם (מי שהוספת ידנית נשאר). אפשר לייבא שוב מתי שרוצים כדי לעדכן.</div>
      <div class="row"><input type="file" id="cfile" accept=".xlsx,.csv,.txt" style="flex:1"></div><div id="cmap"></div></div>
    <div class="card2"><b>🔍 אנשי הקשר</b> <span class="hint" id="ctotal"></span>
      <div class="row"><input id="cq" placeholder="חיפוש לפי חברה, שם או טלפון" style="flex:1"></div>
      <div id="clist"></div></div>
    <div class="card2" id="cform"></div>`;
  const list = async () => {
    const r = await api('GET', '/api/contacts?limit=50&q=' + encodeURIComponent($('#cq').value.trim()));
    $('#ctotal').textContent = `(${r.total} סה"כ)`;
    $('#clist').innerHTML = `<table><tr><th>חברה</th><th>שם</th><th>טלפונים</th><th></th></tr>${r.list.map((c) => `<tr>
      <td>${esc(c.company)}</td><td>${esc(c.name)}</td><td dir="ltr" style="text-align:right">${c.phones.map(fmt).join(', ')}</td>
      <td><button class="ghost" data-e="${c.id}">✏️</button><button class="ghost" data-d="${c.id}">🗑️</button></td></tr>`).join('')}</table>`;
    $('#clist').querySelectorAll('[data-e]').forEach((b) => (b.onclick = () => form(r.list.find((c) => c.id === b.dataset.e))));
    $('#clist').querySelectorAll('[data-d]').forEach((b) => (b.onclick = async () => { await api('DELETE', '/api/admin/contacts/' + b.dataset.d); list(); }));
  };
  const form = (c) => {
    $('#cform').innerHTML = `<b>${c ? '✏️ עריכת איש קשר' : '+ איש קשר חדש (ידני)'}</b>
      <div class="grid2"><div><label>חברה</label><input id="fc" value="${esc(c?.company || '')}"></div><div><label>שם</label><input id="fn" value="${esc(c?.name || '')}"></div></div>
      <label>טלפונים (מופרדים בפסיק)</label><input id="fp" dir="ltr" value="${c ? c.phones.map(fmt).join(', ') : ''}">
      <div class="row"><button class="primary" id="fsave">💾 שמור</button>${c ? '<button id="fnew">+ חדש</button>' : ''}</div>`;
    if ($('#fnew')) $('#fnew').onclick = () => form(null);
    $('#fsave').onclick = async () => {
      try { await api('POST', '/api/admin/contacts', { id: c?.id, company: $('#fc').value, name: $('#fn').value, phones: $('#fp').value }); toast('נשמר ✓'); form(null); list(); }
      catch (e) { toast(e.message, true); }
    };
  };
  let t; $('#cq').oninput = () => { clearTimeout(t); t = setTimeout(list, 250); };
  $('#cfile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    let p;
    try { p = await api('POST', '/api/admin/contacts/parse', f, { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) }); }
    catch (er) { return toast(er.message, true, 7000); }
    const opt = (cur, none = '— אין —') => `<option value="-1">${none}</option>` + p.headers.map((h, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${esc(h || 'עמודה ' + (i + 1))}</option>`).join('');
    $('#cmap').innerHTML = `<div class="hint">נמצאו <b>${p.rows.length}</b> שורות. בדוק שהעמודות נבחרו נכון:</div>
      <div class="grid2"><div><label>שם החברה</label><select id="mc">${opt(p.guess.company)}</select></div>
      <div><label>שם איש הקשר</label><select id="mn">${opt(p.guess.name)}</select></div>
      <div><label>או: שם פרטי</label><select id="mf">${opt(p.guess.first)}</select></div>
      <div><label>ושם משפחה</label><select id="ml">${opt(p.guess.last)}</select></div></div>
      <label>עמודות של טלפון (אפשר כמה)</label>
      <div>${p.headers.map((h, i) => `<label class="check" style="display:inline-flex;margin-left:14px"><input type="checkbox" data-ph="${i}" ${p.guess.phones.includes(i) ? 'checked' : ''}> ${esc(h || 'עמודה ' + (i + 1))}</label>`).join('')}</div>
      <div class="hint" id="mprev"></div>
      <div class="row"><button class="primary" id="mgo">📥 ייבא</button></div>`;
    const getMap = () => ({ company: +$('#mc').value, name: +$('#mn').value, first: +$('#mf').value, last: +$('#ml').value, phones: [...$('#cmap').querySelectorAll('[data-ph]:checked')].map((x) => +x.dataset.ph) });
    const prev = () => {
      const m = getMap(); const c = (r, i) => (i >= 0 ? r[i] || '' : '');
      $('#mprev').innerHTML = 'דוגמה: ' + p.rows.slice(0, 3).map((r) => `🏢 ${esc(c(r, m.company))} · 👤 ${esc(c(r, m.name) || [c(r, m.first), c(r, m.last)].join(' '))} · 📞 ${esc(m.phones.map((i) => c(r, i)).filter(Boolean).join(', '))}`).join('<br>');
    };
    $('#cmap').querySelectorAll('select,input').forEach((el) => (el.onchange = prev)); prev();
    $('#mgo').onclick = async () => {
      const m = getMap();
      if (!m.phones.length) return toast('סמן לפחות עמודת טלפון אחת', true);
      try {
        const r = await api('POST', '/api/admin/contacts/import', { rows: p.rows, map: m });
        toast(`יובאו ${r.imported} אנשי קשר ✓${r.noPhone ? ` (${r.noPhone} בלי טלפון דולגו)` : ''}`, false, 7000);
        $('#cmap').innerHTML = ''; $('#cfile').value = ''; list();
      } catch (er) { toast(er.message, true); }
    };
  };
  form(null); list();
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
    <h4>💬 עוזר AI שמתכתב עם הלקוח</h4>
    <label class="check"><input type="checkbox" id="aiIntake" ${c.ai.intake !== false ? 'checked' : ''}> לפני פתיחת קריאה – העוזר מברר עם הלקוח במה מדובר, ובתקלה שואל שאלות מקדימות</label>
    <div class="grid2"><div><label>מקסימום שאלות לפני ניתוב</label><input id="aiMaxQ" type="number" min="0" max="6" value="${c.ai.maxQuestions ?? 3}"></div>
    <div><label>אם הלקוח לא עונה – לנתב אחרי (דקות)</label><input id="aiWait" type="number" min="1" max="120" value="${c.ai.waitMinutes ?? 10}"></div></div>
    <div class="hint">העוזר כותב בעברית, בקצרה ובטון חברי, לא מזכיר שמות עובדים, ואת השאלות המקדימות לוקח מ"מחלקות וניתוב". בקבוצות הוא לא כותב.<br>
    עובד שעונה ללקוח בזמן שהעוזר מתכתב – לוקח את השיחה, והעוזר מפסיק.</div>
    <div class="row"><input id="aiTest" style="flex:1" placeholder="נסה: 'המרכזייה לא מעבירה שיחות לשלוחה 3'"><button id="aiTestBtn">🧪 בדוק ניתוב</button></div>
    <div class="hint" id="aiRes"></div>
    <h4>🕒 שעות פעילות</h4>
    <label class="check"><input type="checkbox" id="hOn" ${c.hours.enabled ? 'checked' : ''}> מחוץ לשעות הפעילות – לשלוח ללקוח הודעת "המשרד סגור" (במקום שיחה עם העוזר)</label>
    <div class="row" style="margin-top:6px">${['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'].map((d, i) => `<label class="check" style="margin:0 0 0 10px"><input type="checkbox" data-day="${i}" ${c.hours.days.includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
    <div class="grid2"><div><label>משעה</label><input id="hStart" type="time" value="${esc(c.hours.start)}"></div><div><label>עד שעה</label><input id="hEnd" type="time" value="${esc(c.hours.end)}"></div></div>
    <label>ההודעה ללקוח מחוץ לשעות</label><textarea id="hMsg" rows="3">${esc(c.hours.message)}</textarea>
    <div class="hint">נשלחת פעם אחת ב-12 שעות לכל לקוח, לא לקבוצות. הקריאה עדיין נפתחת ומנותבת בשקט – כדי שהעובד יראה אותה בבוקר. (חגים – צריך לכבות ידנית.)</div>
    <h4>🤫 הבוט שותק אחרי תשובה של עובד</h4>
    <div class="grid2"><div><label>כמה דקות אחרי שעובד ענה ללקוח – הבוט לא כותב לו</label><input id="qMin" type="number" min="0" max="600" value="${c.quietMinutes ?? 30}"></div></div>
    <div class="hint">אם הלקוח כותב שוב בזמן הזה (גם אחרי שהקריאה נסגרה) – אין עוזר, אין מענה אוטומטי ואין "המשרד סגור", והקריאה עוברת ישר לעובד שענה לו.</div>
    <h4>💬 הודעה אוטומטית ללקוח</h4>
    <label class="check"><input type="checkbox" id="arOn" ${c.autoReply.enabled ? 'checked' : ''}> לשלוח הודעה אוטומטית כשנפתחת קריאה</label>
    <div class="hint">ההודעות האלה נשלחות רק כשהעוזר כבוי או לא זמין (כשהעוזר פעיל – הוא כותב את ההודעה בעצמו).</div>
    <label>כשזוהתה מחלקה</label><textarea id="arRouted" rows="3">${esc(c.autoReply.routed)}</textarea>
    <label>כשלא זוהתה מחלקה</label><textarea id="arUnknown" rows="3">${esc(c.autoReply.unknown)}</textarea>
    <div class="hint">אפשר להשתמש ב: <code>{name}</code> שם הלקוח · <code>{department}</code> המחלקה · <code>{company}</code> שם החברה</div>
    <div class="row"><span style="flex:1"></span><button class="primary" id="aiSave">💾 שמור</button></div>`;
  $('#aiSave').onclick = () => saveConfig({
    ai: { enabled: $('#aiOn').checked, apiKey: $('#aiKey').value.trim(), model: $('#aiModel').value.trim(), intake: $('#aiIntake').checked, maxQuestions: +$('#aiMaxQ').value, waitMinutes: +$('#aiWait').value, replyDelaySec: c.ai.replyDelaySec ?? 8 },
    autoReply: { enabled: $('#arOn').checked, routed: $('#arRouted').value, unknown: $('#arUnknown').value },
    hours: { enabled: $('#hOn').checked, days: [...$('#apane').querySelectorAll('[data-day]:checked')].map((x) => +x.dataset.day), start: $('#hStart').value, end: $('#hEnd').value, message: $('#hMsg').value },
    quietMinutes: +$('#qMin').value,
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
    <h4>📌 צ'אטים וקבוצות שמקובעים לעובד</h4>
    <div id="ruleList">${c.chatRules.length ? c.chatRules.map((x, i) => `<div class="row" style="margin-top:4px"><span style="flex:1">${x.isGroup ? '👥' : '👤'} ${esc(x.name)} ← <b>${esc(x.userName)}</b></span><button class="ghost" data-unrule="${i}">בטל</button></div>`).join('') : '<div class="hint">אין. (כפתור "📌 קבע לעובד" בראש כל שיחה)</div>'}</div>
    <h4>🔕 קבוצות שמתעלמים מהן לפי שם</h4>
    <label>קבוצה ששמה מכיל אחת מהמילים האלה – לא נפתחת ממנה קריאה בכלל (שורה לכל שם)</label>
    <textarea id="gIgnNames" rows="3">${esc((c.ignoreGroupNames || []).join('\n'))}</textarea>
    <h4>🔕 צ'אטים וקבוצות שמתעלמים מהם</h4>
    <div id="ignList">${c.ignoredChats.length ? c.ignoredChats.map((x, i) => `<div class="row" style="margin-top:4px"><span style="flex:1">${x.isGroup ? '👥' : '👤'} ${esc(x.name || x.chatId)}</span><button class="ghost" data-unign="${i}">החזר</button></div>`).join('') : '<div class="hint">אין. (כפתור "🔕 התעלם" בראש כל שיחה)</div>'}</div>
    <div class="hint">שינוי "מאיפה אפשר להיכנס" או הפורט נכנס לתוקף אחרי הפעלה מחדש של השרת.<br>
    לקוח שכותב "שלום" ואז את הבעיה – ההמתנה נותנת ל-AI את כל ההודעות ביחד, וכך הניתוב מדויק יותר.</div>
    <div class="row"><span style="flex:1"></span><button class="primary" id="gSave">💾 שמור</button></div>`;
  let ign = [...c.ignoredChats];
  let rules = [...c.chatRules];
  $('#apane').querySelectorAll('[data-unrule]').forEach((b) => (b.onclick = () => { rules.splice(Number(b.dataset.unrule), 1); b.parentElement.remove(); }));
  $('#apane').querySelectorAll('[data-unign]').forEach((b) => (b.onclick = () => { ign.splice(Number(b.dataset.unign), 1); b.parentElement.remove(); }));
  $('#gSave').onclick = () => saveConfig({ companyName: $('#gName').value, routeDelaySec: $('#gDelay').value, host: $('#gHost').value, port: $('#gPort').value,
    groups: { enabled: $('#gGroups').checked, autoReply: $('#gGroupsAR').checked }, ignoredChats: ign, chatRules: rules,
    ignoreGroupNames: $('#gIgnNames').value.split('\n').map((x) => x.trim()).filter(Boolean) });
}

boot();

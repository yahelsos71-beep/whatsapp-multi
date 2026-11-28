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
function openModal(html, wide = false) { { const op = document.getElementById('overduePop'); if (op) op.remove(); } box.className = 'box' + (wide ? ' wide' : ''); box.innerHTML = html; modal.classList.add('on'); }
function closeModal() { modal.classList.remove('on'); if (S.svc) S.svc.open = false; }
modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });

const localPhone = (p) => { p = String(p || ''); if (!p.startsWith('972')) return p ? '+' + p : ''; const d = '0' + p.slice(3); return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3) : d.length === 9 ? d.slice(0, 2) + '-' + d.slice(2) : d; };
const normLocal = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); if (d.startsWith('0')) d = '972' + d.slice(1); return d; };
const initials = (n) => String(n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
const avColor = (s) => `hsl(${([...String(s)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0) % 360} 62% 50%)`;
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), n = new Date();
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}
function fmtWhen(ts) {
  const d = new Date(ts), n = new Date();
  const tm = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === n.toDateString()) return 'היום ' + tm;
  const tmr = new Date(n); tmr.setDate(n.getDate() + 1);
  if (d.toDateString() === tmr.toDateString()) return 'מחר ' + tm;
  return d.toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' }) + ' ' + tm;
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
// ערכות תצוגה: tech (ברירת מחדל – טכנולוגי) / light (בהיר) / dark (כהה)
function applyTheme(t) {
  const el = document.documentElement;
  delete el.dataset.theme; delete el.dataset.skin;
  if (t === 'dark' || t === 'tech') el.dataset.theme = 'dark';
  if (t === 'tech') el.dataset.skin = 'tech';
}
const currentTheme = () => { try { return localStorage.getItem('hd-theme') || 'tech'; } catch { return 'tech'; } };
applyTheme(currentTheme());
async function boot() {
  let st;
  try { st = await api('GET', '/api/state'); } catch { app.innerHTML = '<div class="welcome"><h2>אין חיבור לשרת</h2>מנסה שוב...</div>'; return setTimeout(boot, 3000); }
  S.version = st.version; S.company = st.company; S.targets = st.targets || []; S.mondayVcat = !!st.mondayVcat;
  S.testMode = !!st.testMode;
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
      <a id="multiBtn" href="whatsappmulti://open" style="display:none"><button tabindex="-1" title="פתיחת התוכנה WhatsApp Multi (הוואטסאפים הרגילים, כולל הפרטי)">📱<span class="lbl"> WhatsApp Multi</span></button></a>
      ${S.me.waAccess ? '<button id="waBtn" title="כל הצ׳אטים של מספרי המשרד – כמו בוואטסאפ (לא רק קריאות)">💬<span class="lbl"> וואטסאפ</span></button>' : ''}
      <button id="taskBtn" title="הודעה בקבוצה המשותפת – פותחת קריאה אצל הצד השני">📋<span class="lbl"> ${S.me.role === 'admin' ? 'קריאה לעובד' : 'פנייה למנהל'}</span></button>
      <button id="teamBtn" title="משימות צוות – קריאות פנימיות לטל, חני, חיים ונועה (Alt+N = משימה חדשה)">🎫<span class="lbl"> משימות</span><span class="badge on" id="teamBadge" style="display:none"></span></button>
      <button id="teamNewBtn" title="משימה חדשה (Alt+N)">➕</button>
      <button id="staffBtn" title="צ׳אט פנימי עם הצוות">💭<span class="lbl"> צוות</span><span class="badge on" id="staffBadge" style="display:none"></span></button>
      <button id="vendorBtn" title="קריאת שירות לספק (בזק, הוט...) – המוקד מתכתב עם הבוט שלהם עד שמגיע נציג אנושי">🏢<span class="lbl"> ספקים</span></button>
      <button id="newChat" title="שליחת הודעה ללקוח חדש">✉️<span class="lbl"> שיחה חדשה</span></button>
      <button id="mySettings" title="ההגדרות שלי">⚙️</button>
      ${S.me.role === 'admin' ? '<button id="bcastBtn" title="הפצת וואטסאפ ללקוחות לפי מוצר או לרשימת מספרים">📣<span class="lbl"> הפצה</span></button>' : ''}
      ${S.me.role === 'admin' ? '<button id="dashBtn" title="דשבורד">📊<span class="lbl"> דשבורד</span></button><button id="adminBtn" title="ניהול">🛠️<span class="lbl"> ניהול</span></button>' : ''}
      <span class="me">${esc(S.me.name)} · v${S.version}</span>
      <button class="ghost" id="logout">יציאה</button>
    </div>
    <div class="side" id="waSide" style="display:none"></div>
    <div class="side" id="tSide">
      <div class="tabs" id="tabs"></div>
      <div class="search" style="display:flex;gap:6px"><input id="q" placeholder="🔍 חיפוש לפי שם או טלפון" style="flex:2;min-width:130px">
        ${S.me.role === 'admin' ? '<select id="fuser" title="סינון לפי עובד" style="flex:1;min-width:0;width:auto;max-width:110px"></select>' : ''}
        <select id="fdate" title="סינון לפי תאריך" style="flex:1;min-width:0;width:auto;max-width:90px"><option value="">📅 הכל</option><option value="today">היום</option><option value="yesterday">אתמול</option><option value="week">7 ימים אחרונים</option><option value="month">30 ימים אחרונים</option><option value="custom">📅 טווח תאריכים...</option></select>
        <button id="fsort" class="btn ghost" type="button" style="flex:0 0 auto;padding:4px 8px;white-space:nowrap"></button></div>
      <div class="search" id="fdateRange" style="display:none;gap:6px;align-items:center;padding-top:0"><span class="hint">מ-</span><input type="date" id="fdFrom" style="flex:1"><span class="hint">עד</span><input type="date" id="fdTo" style="flex:1"></div>
      <div class="list" id="list"></div>
    </div>
    <div class="chat" id="chat"></div>
  </div>`;
  if ($('#bcastBtn')) $('#bcastBtn').onclick = () => broadcastDialog();
  if (S.me.role === 'admin') { S.tab = localStorage.getItem('hd-tab') || 'all'; $('#adminBtn').onclick = () => adminDialog(); $('#dashBtn').onclick = () => dashboardDialog(); }
  $('#logout').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); location.reload(); };
  $('#mySettings').onclick = mySettingsDialog;
  $('#newChat').onclick = newChatDialog;
  $('#vendorBtn').onclick = vendorDialog;
  try { if (localStorage.getItem('hd-multi') !== '0') $('#multiBtn').style.display = ''; } catch {}
  $('#taskBtn').onclick = taskDialog;
  $('#teamBtn').onclick = svcOpen;
  $('#teamNewBtn').onclick = () => svcNewDialog(false);
  $('#staffBtn').onclick = () => (S.staff.open ? staffClose() : staffOpen(null));
  api('GET', '/api/staff/unread').then((u) => { S.staff.unread = u; staffBadge(); }).catch(() => {});
  if ($('#waBtn')) $('#waBtn').onclick = () => (S.mode === 'wa' ? leaveWa() : enterWa());
  $('#q').oninput = (e) => { S.q = e.target.value.trim(); renderList(); };
  // ⇅ מיון לפי תאריך: רגיל (ממתינים למעלה) → חדש לישן → ישן לחדש
  try { S.fsort = localStorage.getItem('hd-sort') || ''; } catch { S.fsort = ''; }
  const sortLabel = () => { const b = $('#fsort'); b.textContent = { '': '⇅ מיון', new: '⬇ חדש→ישן', old: '⬆ ישן→חדש' }[S.fsort]; b.title = 'מיון לפי תאריך פתיחה (בסגורות – תאריך סגירה). לחיצה מחליפה'; b.classList.toggle('on', !!S.fsort); };
  sortLabel();
  $('#fsort').onclick = () => { S.fsort = { '': 'new', new: 'old', old: '' }[S.fsort]; try { localStorage.setItem('hd-sort', S.fsort); } catch {} sortLabel(); renderList(); };
  const dateChanged = async () => { if (S.tab === 'closed') await loadClosed(); renderList(); };
  $('#fdate').onchange = (e) => { S.fdate = e.target.value; $('#fdateRange').style.display = S.fdate === 'custom' ? 'flex' : 'none'; dateChanged(); };
  $('#fdFrom').onchange = (e) => { S.fdFrom = e.target.value; dateChanged(); };
  $('#fdTo').onchange = (e) => { S.fdTo = e.target.value; dateChanged(); };
  if ($('#fuser')) $('#fuser').onchange = (e) => { S.fuser = e.target.value; try { localStorage.setItem('hd-fuser', S.fuser); } catch {} renderList(); };

  const [list, users, insts] = await Promise.all([api('GET', '/api/tickets'), api('GET', '/api/users'), api('GET', '/api/instances')]);
  S.tickets = new Map(list.map((t) => [t.id, t]));
  S.users = users; S.instances = insts;
  loadTemplates();
  svcLoad();
  fillUserFilter();
  renderInstances(); renderTabs(); renderList(); renderChat();
  connectEvents();
  setTimeout(() => whatsNew(false), 800);
  if (S.testMode && !$('#testBanner')) document.body.insertAdjacentHTML('beforeend', '<div id="testBanner">🧪 מצב ניסיון – השרת הזה לא מקבל ולא שולח הודעות באמת</div>');
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
  if (ev.type && ev.type.startsWith('svc')) return svcOnEvent(ev);
  if (ev.type === 'hello') {
    if (ev.version && S.version && ev.version !== S.version) location.reload();
    S.instances = ev.instances; renderInstances();
    // חיבור מחדש – מרעננים את הרשימה
    api('GET', '/api/tickets').then((list) => { S.tickets = new Map(list.map((t) => [t.id, t])); renderList(); }).catch(() => {});
    svcLoad();
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
  } else if (ev.type === 'vendorbot') {
    if (ev.human) vendorHumanPop(ev); else toast(ev.text, !/^✅|^⏳/.test(ev.text), 15000);
    notify(ev.human ? `✅ נציג של ${ev.vendor || 'הספק'} ענה` : '🏢 קריאה לספק', ev.text);
  } else if (ev.type === 'group-pop') {
    // גרסה 92: בוטל
  } else if (ev.type === 'staffmsg') {
    staffOnMessage(ev.message, ev.fromName);
  } else if (ev.type === 'staffread') {
    if (S.staff.with === ev.by) { S.staff.msgs.forEach((m) => { if (m.from === S.me.id) m.read = true; }); staffRenderMsgs(); }
  } else if (ev.type === 'bcast-job') {
    S.bjob = ev.job; if ($('#bProg')) drawBcastJob();
  } else if (ev.type === 'bcast-progress') {
    if ($('#bLoad')) $('#bLoad').textContent = ev.text;
  } else if (ev.type === 'call') {
    showCall(ev.call);
  } else if (ev.type === 'call-info') {
    callWaInfo(ev.phone, ev.wa);
  } else if (ev.type === 'call-end') {
    endCall(ev);
  } else if (ev.type === 'msgupdate') {
    if (S.view && S.view.ticket.id === ev.ticketId) {
      const i = S.view.messages.findIndex((x) => x.id === ev.message.id);
      if (i >= 0) S.view.messages[i] = ev.message;
      const el = document.querySelector(`#msgs [data-mid="${ev.message.id}"]`); if (el) el.outerHTML = messageHtml(ev.message);
    }
  } else if (ev.type === 'wa-del') {
    const v = S.wa && S.wa.view;
    if (v && v.items && v.chat.key === ev.key) {
      const x = v.items.find((i) => i.id === ev.id);
      if (x) { x.deleted = true; x.deletedBy = ev.by; const el = document.querySelector(`#waMsgs [data-mid="${CSS.escape(ev.id)}"]`); if (el) el.outerHTML = waMsgHtml(x); }
    }
  } else if (ev.type === 'wa') {
    waOnEvent(ev);
  } else if (ev.type === 'templates') {
    loadTemplates();
  } else if (ev.type === 'reminder') {
    reminderPopup(ev.ticket);
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
    ? [['all', 'כל הפתוחות'], ['mine', 'שלי'], ['snoozed', '⏸ מושהות'], ['routing', 'בניתוב'], ['closed', 'סגורות']]
    : [['mine', 'הקריאות שלי'], ['snoozed', '⏸ מושהות'], ['closed', 'סגורות']];
  $('#tabs').innerHTML = tabs.map(([k, n]) => `<button data-k="${k}" class="${S.tab === k ? 'on' : ''}">${n} <span data-cnt="${k}"></span></button>`).join('');
  $('#tabs').querySelectorAll('button').forEach((b) => (b.onclick = async () => {
    S.tab = b.dataset.k; localStorage.setItem('hd-tab', S.tab); renderTabs();
    if (S.tab === 'closed') await loadClosed();
    renderList();
  }));
}

// טווח התאריכים שנבחר בסינון [מ, עד) במילישניות, או null
function dateRange() {
  const day = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const D = 86400000, t0 = day(Date.now());
  switch (S.fdate) {
    case 'today': return [t0, t0 + D];
    case 'yesterday': return [t0 - D, t0];
    case 'week': return [t0 - 6 * D, t0 + D];
    case 'month': return [t0 - 29 * D, t0 + D];
    case 'custom': {
      if (!S.fdFrom && !S.fdTo) return null;
      const f = S.fdFrom ? day(S.fdFrom + 'T00:00') : 0, t = S.fdTo ? day(S.fdTo + 'T00:00') + D : Date.now() + D;
      return [Math.min(f, t), Math.max(f, t)];
    }
  }
  return null;
}
async function loadClosed() {
  const r = dateRange();
  S.closed = await api('GET', '/api/tickets?scope=closed' + (r ? `&from=${r[0]}&to=${r[1]}` : '')).catch(() => []);
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
    if (S.tab === 'snoozed') {
      list = list.filter((t) => t.snoozeUntil && (S.me.role === 'admin' || t.assigneeId === S.me.id)).sort((a, b) => a.snoozeUntil - b.snoozeUntil);
    } else {
      list = list.filter((t) => !t.snoozeUntil);
      if (S.tab === 'mine') list = list.filter((t) => t.assigneeId === S.me.id);
      if (S.tab === 'routing') list = list.filter((t) => t.status === 'routing' || !t.assigneeId);
      sortTickets(list);
    }
  }
  if (S.me.role === 'admin' && S.fuser && S.tab !== 'mine') {
    list = list.filter((t) => (S.fuser === 'none' ? !t.assigneeId : t.assigneeId === S.fuser || (S.tab === 'closed' && t.closedBy === S.fuser)));
  }
  const dr = dateRange();
  if (dr) {
    // פתוחות – לפי פעילות (הודעה אחרונה או פתיחה); סגורות – לפי מועד הסגירה
    const when = (t) => (S.tab === 'closed' ? [t.closedAt || t.updatedAt] : [t.createdAt, t.updatedAt, t.lastInAt, t.lastOutAt]);
    list = list.filter((t) => when(t).some((x) => x && x >= dr[0] && x < dr[1]));
  }
  if (S.q) {
    const q = S.q.toLowerCase();
    list = list.filter((t) => String(t.customerName).toLowerCase().includes(q) || String(t.company || '').toLowerCase().includes(q) || String(t.phone).includes(q.replace(/\D/g, '') || '§') || String(t.id) === q.replace('#', ''));
  }
  if (S.fsort) {
    const d = (t) => (S.tab === 'closed' ? t.closedAt || t.updatedAt : t.createdAt) || 0;
    list.sort((a, b) => (S.fsort === 'new' ? d(b) - d(a) : d(a) - d(b)));
  }
  return list;
}

function renderList() {
  const el = $('#list'); if (!el) return;
  if ($('#fuser')) $('#fuser').style.display = S.tab === 'mine' ? 'none' : '';
  const list = currentList();
  const now = Date.now();
  const myWaiting = [...S.tickets.values()].filter((t) => t.assigneeId === S.me.id && t.awaiting).length;
  const titleCount = myWaiting + staffTotal();
  document.title = (titleCount ? `(${titleCount}) ` : '') + 'מוקד וואטסאפ';
  const act = [...S.tickets.values()].filter((t) => !t.snoozeUntil);
  const counts = { mine: act.filter((t) => t.assigneeId === S.me.id).length, all: act.length, routing: act.filter((t) => t.status === 'routing' || !t.assigneeId).length,
    snoozed: [...S.tickets.values()].filter((t) => t.snoozeUntil && (S.me.role === 'admin' || t.assigneeId === S.me.id)).length };
  for (const [k, n] of Object.entries(counts)) { const c = document.querySelector(`[data-cnt="${k}"]`); if (c) c.textContent = n ? `(${n})` : ''; }
  if (!list.length) {
    el.innerHTML = `<div class="empty">${S.q ? 'לא נמצא' : dateRange() ? 'אין קריאות בתאריכים האלה' : S.fuser && S.tab !== 'mine' ? 'אין קריאות לעובד הזה' : S.tab === 'closed' ? 'אין קריאות סגורות' : S.tab === 'snoozed' ? 'אין קריאות מושהות' : 'אין קריאות פתוחות 🎉'}</div>`;
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
          <span class="chip">#${t.id}</span>${t.isGroup ? '<span class="chip grp">👥 קבוצה</span>' : ''}${t.company ? `<span class="chip dep">🏢 ${esc(t.company)}</span>` : ''}
          ${t.instanceName ? `<span class="chip inst">📱 ${esc(t.instanceName)}</span>` : ''}
          ${t.status === 'routing' ? `<span class="chip">🤖 ${t.aiTurns ? 'העוזר מברר עם הלקוח...' : 'מנתב...'}</span>` : t.departmentName ? `<span class="chip dep">${esc(t.departmentName)}</span>` : ''}
          ${S.me.role === 'admin' && t.assigneeName ? `<span class="chip who">👤 ${esc(t.assigneeName)}</span>` : ''}
          ${t.awaiting ? `<span class="chip waittime">⏳ ${waitText(wait)}</span>` : ''}
          ${t.snoozeUntil ? `<span class="chip who">⏸ עד ${fmtWhen(t.snoozeUntil)}</span>` : ''}
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
  if (S.mode === 'wa') leaveWa(true);
  S.sel = id; renderList();
  try { S.view = await api('GET', '/api/tickets/' + id); } catch (e) { toast(e.message, true); return; }
  renderChat();
}

function renderChat() {
  const el = $('#chat'); if (!el) return;
  if (!S.view) {
    el.innerHTML = `<div class="welcome"><h2>שלום ${esc(S.me.name)} 👋</h2><div>בחר קריאה מהרשימה כדי להתחיל.</div>
      <div class="hint">קריאות שמחכות לתשובה שלך מסומנות בנקודה ירוקה ומופיעות למעלה.<br>כל עוד יש לקוח שמחכה – תקפוץ התראת תזכורת.</div></div>`;
    return;
  }
  el.innerHTML = `<div class="chat-head" id="chead"></div><div id="hist"></div><div class="msgs" id="msgs"></div><div id="comp"></div>`;
  renderChatHead();
  renderHistory();
  renderMessages();
  renderComposer();
  const m = $('#msgs'); if (m) requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
}

// מציגים רק את ההתכתבות של היום (או את ההודעות האחרונות אם היום אין). הקודמות – בלחיצה, או ב"📜 היסטוריה"
function renderMessages() {
  const msgs = $('#msgs'); if (!msgs) return;
  const all = S.view.messages;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let shown = S.view.showAll ? all : all.filter((m) => m.ts >= today.getTime());
  if (!shown.length) shown = all.slice(-8);
  const hidden = all.length - shown.length;
  msgs.innerHTML = hidden > 0 ? `<div class="day" style="cursor:pointer" id="showOlder">⬆ הצג ${hidden} הודעות קודמות בקריאה</div>` : '';
  let lastDay = '';
  for (const m of [...shown].sort((a, b) => a.ts - b.ts)) {
    const day = new Date(m.ts).toLocaleDateString('he-IL');
    if (day !== lastDay) { msgs.insertAdjacentHTML('beforeend', `<div class="day">${day}</div>`); lastDay = day; }
    msgs.insertAdjacentHTML('beforeend', messageHtml(m));
  }
  if ($('#showOlder')) $('#showOlder').onclick = () => { S.view.showAll = true; renderMessages(); $('#msgs').scrollTop = 0; };
  msgs.scrollTop = msgs.scrollHeight;
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
      : `${t.snoozeUntil ? `<span class="chip who">⏸ מושהית עד ${fmtWhen(t.snoozeUntil)}</span><button id="unsnoozeBtn">▶ החזר עכשיו</button>` : '<button id="snoozeBtn" title="עדיין לא סגרנו – מתכתבים עם הלקוח. הקריאה תעבור ל״מושהות״ ותחזור עם תזכורת">⏸ השהה</button>'}<button id="transferBtn">↪️ העבר שיחה</button><button class="primary" id="closeBtn">✅ סגור קריאה</button>`}
    ${S.targets.length && !ro ? `<button id="svcBtn" title="שליחת קריאת שירות בוואטסאפ">🛠 ${S.targets.length === 1 ? 'קריאה ל' + esc(S.targets[0].name) : 'קריאת שירות'}</button>` : ''}
    ${S.mondayVcat && t.isGroup && !ro ? `<button id="vcatBtn" title="משנה במאנדיי את סטטוס הקריאה של הקבוצה ל״העבר ל-VCAT״">🔁 העבר לויקאט</button>` : ''}
    ${!t.isGroup ? `<button class="ghost" id="dialBtn" title="חיוג ללקוח דרך המרכזייה – הטלפון שלך יצלצל קודם">📞 חייג</button>` : ''}
    ${!t.isGroup && !ro ? `<button class="ghost" id="contactBtn" title="שמירת שם וחברה ללקוח הזה">👤 ${t.contact ? 'איש קשר' : 'שמור איש קשר'}</button>` : ''}
    <button class="ghost" id="waHistBtn" title="ההודעות הקודמות עם ${t.isGroup ? 'הקבוצה' : 'הלקוח'} מוואטסאפ – גם מלפני המוקד">📜 היסטוריה</button>
    ${t.pinnedTo ? `<span class="chip who">📌 קבוע: ${esc(t.pinnedTo)}</span>` : ''}
    ${S.me.role === 'admin' && !ro ? `<button class="ghost" id="pinBtn" title="כל הודעה מ${t.isGroup ? 'הקבוצה' : 'הצ׳אט'} הזה תגיע ישר לעובד שתבחר, בלי AI">📌 קבע לעובד</button>` : ''}
    ${S.me.role === 'admin' && !ro ? `<button id="ignoreBtn" title="${t.isGroup ? 'הקבוצה' : 'הצ׳אט'} נשאר בוואטסאפ, אבל לא ייכנס יותר למוקד">🚫 ${t.isGroup ? 'חסום קבוצה' : 'חסום'}</button>` : ''}`;
  if ($('#transferBtn')) $('#transferBtn').onclick = transferDialog;
  if ($('#snoozeBtn')) $('#snoozeBtn').onclick = () => snoozeDialog(t);
  if ($('#unsnoozeBtn')) $('#unsnoozeBtn').onclick = async () => { try { await api('POST', `/api/tickets/${t.id}/snooze`, { until: null }); toast('הקריאה חזרה לרשימה ▶'); } catch (e) { toast(e.message, true); } };
  if ($('#closeBtn')) $('#closeBtn').onclick = closeTicket;
  $('#waHistBtn').onclick = () => waHistoryDialog(t);
  if ($('#dialBtn')) $('#dialBtn').onclick = () => dialPhone(localPhone(t.phone), t.customerName);
  if ($('#svcBtn')) $('#svcBtn').onclick = () => serviceCallDialog(t);
  if ($('#vcatBtn')) $('#vcatBtn').onclick = () => mondayVcat(t);
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
    if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = '⚠️ בטוח? לחץ שוב לחסימה'; return; }
    try {
      await api('POST', `/api/tickets/${t.id}/ignore`);
      S.tickets.delete(t.id); S.sel = null; S.view = null; renderList(); renderChat();
      toast(`🚫 "${t.customerName}" נחסם – נשאר בוואטסאפ, אבל לא ייכנס יותר למוקד. ביטול: ניהול ← כללי`, false, 7000);
    } catch (er) { toast(er.message, true); }
  };
  if ($('#reopenBtn')) $('#reopenBtn').onclick = async () => { try { await api('POST', `/api/tickets/${t.id}/reopen`); openTicket(t.id); } catch (e) { toast(e.message, true); } };
}

function renderHistory() {
  const h = $('#hist'); if (!h) return;
  const list = S.view.history || [];
  if (!list.length) { h.innerHTML = ''; return; }
  const items = [];
  for (const x of list) {
    if (x.resolution) items.push({ id: x.id, ts: x.closedAt || x.createdAt, who: x.closedByName, text: x.resolution, icon: '✅' });
    for (const n of x.notes || []) items.push({ id: x.id, ts: n.ts, who: n.by, text: n.text, icon: '🗒' });
  }
  const done = items.sort((a, b) => b.ts - a.ts).slice(0, 5);
  h.innerHTML = `<div class="history">
    ${done.length ? `<div class="prev-work"><b>🧾 טיפולים קודמים:</b>${done.map((x) => `<a data-id="${x.id}" class="pw" title="${esc(x.text)}">
      <span class="pw-meta">${x.icon} ${new Date(x.ts).toLocaleDateString('he-IL')}${x.who ? ' · ' + esc(x.who) : ''}</span>
      <span class="pw-text">${esc(x.text)}</span></a>`).join('')}</div>` : ''}
    <div>📜 קריאות קודמות: ${list.map((x) => `<a data-id="${x.id}">#${x.id} (${new Date(x.createdAt).toLocaleDateString('he-IL')}${x.assigneeName ? ', ' + esc(x.assigneeName) : ''})</a>`).join(' · ')}</div></div>`;
  h.querySelectorAll('a[data-id]').forEach((a) => (a.onclick = () => openTicket(a.dataset.id)));
}

function ticks(m) {
  if (m.dir !== 'out') return '';
  const s = m.status;
  return `<span class="ticks ${s === 'read' ? 'read' : ''}">${s === 'read' || s === 'delivered' ? '✓✓' : s === 'failed' || s === 'noAccount' ? '⚠️' : '✓'}</span>`;
}

function messageHtml(m) {
  if (m.dir === 'note' && m.internal) return `<div class="msg note internal" data-mid="${m.id}"><div class="by">🗒 הערה פנימית · ${esc(m.byName || '')}</div>${esc(m.text)}<div class="meta">${fmtTime(m.ts)}</div></div>`;
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
    : m.dir === 'in' && m.senderName ? `<div class="by sender">${m.staff ? '👤 ' : ''}${esc(m.senderName)}${m.senderPhone && !m.staff && m.senderName !== localPhone(m.senderPhone) ? ` <span class="sph" dir="ltr" title="לחץ להעתקה" data-copy="${esc(localPhone(m.senderPhone))}">${esc(localPhone(m.senderPhone))}</span>` : ''}</div>` : '';
  if (m.type === 'contact' && Array.isArray(m.contacts) && m.contacts.length) {
    media = m.contacts.map((c, i) => `<div class="vcard"><div class="vc-av">👤</div><div class="vc-body"><b>${esc(c.name || 'איש קשר')}</b>
      ${c.company ? `<span>🏢 ${esc(c.company)}</span>` : ''}${(c.phones || []).map((p) => `<span dir="ltr" class="sph" data-copy="${esc(localPhone(normLocal(p)))}">${esc(localPhone(normLocal(p)))}</span>`).join('')}</div>
      <button class="vc-save" data-vc="${m.id}|${i}">💾 שמור במערכת</button></div>`).join('');
    m = { ...m, text: '' };
  }
  const quote = m.quoted ? `<div class="quote"><b>${esc(m.quoted.from || '')}</b>${esc(m.quoted.text || '')}</div>` : '';
  if (m.deleted) return `<div class="msg ${m.dir} deleted" data-mid="${m.id}">${by}<div class="del-note">🗑 נמחקה אצל הלקוח${m.deletedBy ? ' ע״י ' + esc(m.deletedBy) : ''}</div><div class="del-orig">${media}${waFormat(m.text)}</div><div class="meta">${fmtTime(m.ts)}</div></div>`;
  const ro = S.view && S.view.readOnly && S.mode !== 'wa';
  const rep = m.idMessage && !ro ? `<button class="rep" data-rep="${m.id}" title="להגיב להודעה הזאת">↩</button>` : '';
  const del = m.dir === 'out' && m.idMessage && !ro && Date.now() - m.ts < 2 * 864e5 ? `<button class="del" data-del="${m.id}" title="מחיקת ההודעה אצל כולם (נשלחה בטעות)">🗑</button>` : '';
  const opts = Array.isArray(m.options) && m.options.length ? `<div class="opts">${m.options.map((o, i) => `<button class="opt ${o.kind}" data-opt="${i}" ${ro ? 'disabled' : ''} title="${o.kind === 'url' ? 'פתיחת הקישור' : o.kind === 'call' ? 'חיוג' : 'לחיצה שולחת את האפשרות הזו כתשובה'}">${o.kind === 'url' ? '🔗 ' : o.kind === 'call' ? '📞 ' : ''}${esc(o.text)}</button>`).join('')}</div>` : '';
  return `<div class="msg ${m.dir} ${m.auto ? 'auto' : ''}" data-mid="${m.id}">${rep}${del}${by}${quote}${media}${waFormat(m.text)}${opts}<div class="meta">${fmtTime(m.ts)} ${ticks(m)}</div></div>`;
}

function appendMessage(m, scroll) {
  const msgs = $('#msgs'); if (!msgs) return;
  const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 150;
  msgs.insertAdjacentHTML('beforeend', messageHtml(m));
  if (scroll && (nearBottom || m.byUserId === S.me.id)) msgs.scrollTop = msgs.scrollHeight;
}

// ---------- טיוטות (גרסה 95) ----------
// מה שמוקלד נשמר לכל קריאה / צ'אט – אם תיבת הכתיבה נבנית מחדש (חלון קופץ, פתיחה מחדש, רענון) הטקסט חוזר. נמחק רק אחרי שליחה.
function draftsAll() { try { return JSON.parse(localStorage.getItem('hd-drafts') || '{}'); } catch { return {}; } }
function draftGet(k) { return (draftsAll()[k] || {}).text || ''; }
function draftSet(k, text) {
  const d = draftsAll(); const now = Date.now();
  if (text && text.trim()) d[k] = { text, at: now }; else delete d[k];
  for (const x of Object.keys(d)) if (now - (d[x].at || 0) > 3 * 86400000) delete d[x];
  try { localStorage.setItem('hd-drafts', JSON.stringify(d)); } catch {}
}
function markTyping() { window.__hdTypedAt = Date.now(); }
// באמצע כתיבה: יש טקסט בתיבה, או שהוקלד משהו בדקה האחרונה
function isTyping() {
  const a = document.getElementById('txt'), b = document.getElementById('waTxt');
  return !!((a && a.value.trim()) || (b && b.value.trim()) || Date.now() - (window.__hdTypedAt || 0) < 60000);
}

function renderComposer() {
  const c = $('#comp'); if (!c || !S.view) return;
  const t = S.view.ticket;
  if (S.view.readOnly) { c.innerHTML = '<div class="closed-bar">קריאה קודמת – צפייה בלבד</div>'; return; }
  if (t.status === 'closed') { c.innerHTML = '<div class="closed-bar">הקריאה סגורה. כדי לכתוב ללקוח – "פתח מחדש", או שהלקוח יכתוב ותיפתח קריאה חדשה.</div>'; return; }
  if (c.dataset.for === t.id && $('#txt')) return; // לא מוחקים טקסט שבאמצע הקלדה
  c.dataset.for = t.id;
  c.innerHTML = `<div class="replybar" id="replybar" style="display:none"><div class="rb-body"><b id="rbFrom"></b><span id="rbText"></span></div><button class="ghost" id="rbX" title="ביטול">✕</button></div><div class="composer">
    <button id="noteBtn" title="הערה פנימית – לא נשלחת ללקוח (למשל: עשינו ריסטרט לראוטר)">🗒</button>
    <button id="tplBtn" title="תבנית הודעה">📝</button>
    <button id="boldBtn" title="הדגשה (בוואטסאפ: *טקסט*)"><b>B</b></button>
    <button id="attach" title="שליחת קובץ / תמונה">📎</button>
    <input type="file" id="file" hidden>
    <textarea id="txt" placeholder="כתוב הודעה... (Enter לשליחה, Shift+Enter לשורה חדשה)"></textarea>
    <button class="primary" id="sendBtn" title="שלח">➤</button></div>`;
  const txt = $('#txt');
  const grow = () => { txt.style.height = 'auto'; txt.style.height = Math.min(160, txt.scrollHeight) + 'px'; };
  const dk = 't:' + t.id;
  txt.oninput = () => { grow(); markTyping(); draftSet(dk, txt.value); };
  txt.value = draftGet(dk); if (txt.value) requestAnimationFrame(grow);
  txt.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } };
  $('#sendBtn').onclick = sendText;
  $('#attach').onclick = () => $('#file').click();
  const setNote = (on) => {
    S.noteMode = on;
    $('#comp .composer').classList.toggle('notemode', on);
    $('#noteBtn').classList.toggle('on', on);
    txt.placeholder = on ? '🗒 הערה פנימית – רק לצוות, לא נשלחת ללקוח (Enter לשמירה)' : 'כתוב הודעה... (Enter לשליחה, Shift+Enter לשורה חדשה)';
    txt.focus({ preventScroll: true });
  };
  $('#noteBtn').onclick = () => setNote(!S.noteMode);
  $('#rbX').onclick = () => setReply(null);
  setReply(S.replyTo && S.replyTo.ticketId === t.id ? S.replyTo : null);
  setNote(false);
  $('#boldBtn').onclick = () => waWrap(txt, '*');
  if (t.isGroup) attachMentions(txt, () => api('GET', `/api/tickets/${t.id}/members`));
  $('#tplBtn').onclick = () => templatePicker((text) => {
    const v = S.view && S.view.ticket;
    txt.value = fillTemplate(text, v ? { name: v.customerName, company: v.company } : {});
    txt.dispatchEvent(new Event('input')); txt.focus({ preventScroll: true });
  });
  $('#file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) sendFile(f); };
  txt.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])][0];
    if (f) { e.preventDefault(); sendFile(f); }
  });
  txt.focus({ preventScroll: true });
}

// העתקה ללוח – עובד גם בכתובת לא מאובטחת (http://10.10.10.250)
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}

// שמירת כרטיס איש קשר שנשלח בוואטסאפ
async function saveVcardDialog(c) {
  const phones = (c.phones || []).map(normLocal).filter(Boolean);
  let existing = null;
  for (const p of phones) {
    const r = await api('GET', '/api/contacts?limit=5&q=' + encodeURIComponent(p)).catch(() => ({ list: [] }));
    existing = r.list.find((x) => x.phones.includes(p)); if (existing) break;
  }
  openModal(`<h3>💾 ${existing ? 'איש הקשר כבר שמור – עדכון' : 'שמירת איש קשר במערכת'}</h3>
    ${existing ? `<div class="hint">✓ המספר כבר קיים במערכת בשם "${esc(existing.name || existing.company)}". אפשר לעדכן את הפרטים.</div>` : ''}
    <div class="grid2"><div><label>שם</label><input id="vn" value="${esc(existing ? existing.name || c.name : c.name)}"></div>
    <div><label>חברה</label><input id="vco" value="${esc(existing ? existing.company || c.company : c.company)}"></div></div>
    <label>טלפונים (מופרדים בפסיק)</label><input id="vp" dir="ltr" value="${esc([...new Set([...(existing ? existing.phones : []), ...phones])].map(localPhone).join(', '))}">
    <div class="row"><button class="primary" id="vsave">💾 שמור</button><button id="cancel">ביטול</button></div>`);
  $('#cancel').onclick = closeModal;
  $('#vsave').onclick = async () => {
    try { await api('POST', '/api/contacts', { id: existing ? existing.id : undefined, name: $('#vn').value, company: $('#vco').value, phones: $('#vp').value }); closeModal(); toast('איש הקשר נשמר במערכת ✓'); }
    catch (e) { toast(e.message, true); }
  };
}

// ---------- תגובה להודעה מסוימת ----------
function setReply(m) {
  S.replyTo = m;
  const bar = $('#replybar'); if (!bar) return;
  if (!m) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  $('#rbFrom').textContent = m.dir === 'in' ? (m.senderName || (S.view && S.view.ticket.customerName) || 'לקוח') : (m.byName || 'אנחנו');
  $('#rbText').textContent = m.text || ({ image: '📷 תמונה', video: '🎬 וידאו', file: '📎 קובץ', audio: '🎤 הקלטה' }[m.type] || '');
  if ($('#txt')) $('#txt').focus({ preventScroll: true });
}
document.addEventListener('click', (e) => {
  const vc = e.target.closest('.vc-save');
  if (vc && S.view) {
    const [mid, i] = vc.dataset.vc.split('|');
    const m = S.view.messages.find((x) => x.id === mid);
    if (m && m.contacts && m.contacts[+i]) saveVcardDialog(m.contacts[+i]);
    return;
  }
  const cp = e.target.closest('[data-copy]');
  if (cp) { copyText(cp.dataset.copy).then((ok) => toast(ok ? '📋 הועתק: ' + cp.dataset.copy : 'לא הצלחתי להעתיק', !ok)); return; }
  const b = e.target.closest('.rep'); if (!b || !S.view) return;
  const m = S.view.messages.find((x) => x.id === b.dataset.rep);
  if (m) { if (S.noteMode && $('#noteBtn')) $('#noteBtn').click(); setReply({ ...m, ticketId: S.view.ticket.id }); }
});

async function sendText() {
  const txt = $('#txt'); const text = txt.value.trim();
  if (!text || !S.view) return;
  const id = S.view.ticket.id;
  txt.value = ''; txt.style.height = '42px'; draftSet('t:' + id, '');
  if (S.noteMode) {
    try { await api('POST', `/api/tickets/${id}/note`, { text }); toast('🗒 ההערה נשמרה – לא נשלחה ללקוח'); }
    catch (e) { toast(e.message, true); if ($('#txt')) $('#txt').value = text; draftSet('t:' + id, text); }
    return;
  }
  const replyTo = S.replyTo && S.replyTo.ticketId === id ? S.replyTo.id : null;
  setReply(null);
  try { await api('POST', `/api/tickets/${id}/send`, { text, replyTo }); }
  catch (e) { toast(e.message, true, 6000); if ($('#txt') && !$('#txt').value) $('#txt').value = text; draftSet('t:' + id, text); }
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
    draftSet('t:' + S.view.ticket.id, '');
    toast('נשלח ✓');
  } catch (e) { toast(e.message, true, 6000); }
}

function closeTicket() {
  const t = S.view.ticket;
  openModal(`<h3>✅ סגירת קריאה #${t.id} – ${esc(t.customerName)}</h3>
    <label>מה בוצע? (${S.me.quickClose ? 'לא חובה אצלך' : 'חובה'} – יופיע בפעם הבאה שהלקוח פונה)</label>
    <textarea id="resol" rows="4" placeholder="למשל: אופסה הסיסמה למרכזייה והוגדרה מחדש שלוחה 3. הלקוח אישר שעובד."></textarea>
    <div class="row"><button class="primary" id="rclose">✅ סגור קריאה</button><button id="cancel">ביטול</button></div>`);
  $('#resol').focus();
  $('#cancel').onclick = closeModal;
  $('#rclose').onclick = () => doCloseTicket(t, $('#resol').value.trim());
  // Claude מנסח הצעה לפי השיחה – רק אם עוד לא התחלת לכתוב
  const box = $('#resol'), ph = box.placeholder;
  box.placeholder = '⏳ Claude מנסח הצעה לפי השיחה...';
  api('POST', `/api/tickets/${t.id}/suggest-resolution`, {}).then((r) => {
    if (!document.body.contains(box)) return;
    box.placeholder = ph;
    if (r && r.text && !box.value.trim()) { box.value = r.text; box.select(); }
  }).catch(() => { if (document.body.contains(box)) box.placeholder = ph; });
}
async function doCloseTicket(t, resolution) {
  if (resolution.length < 3 && !S.me.quickClose) { toast('כתוב בקצרה מה בוצע', true); $('#resol').focus(); return; }
  try {
    await api('POST', `/api/tickets/${t.id}/close`, { resolution });
    closeModal();
    S.tickets.delete(t.id); S.sel = null; S.view = null;
    renderList(); renderChat(); toast(`קריאה #${t.id} נסגרה ✅`);
  } catch (e) { toast(e.message, true); }
}

// גרסה 99: נציג אנושי של הספק ענה → חלון גדול למי שפתח את הפנייה (לא modal – לא מוחק חלון/טקסט פתוח)
function vendorHumanPop(ev) {
  const old = document.getElementById('vendorPop'); if (old) old.remove();
  const el = document.createElement('div'); el.id = 'vendorPop'; el.className = 'vendorpop';
  el.innerHTML = `<div class="op-box"><div class="op-title">✅ נציג של ${esc(ev.vendor || 'הספק')} ענה!</div>
    <div class="op-sub">${esc(ev.text || '').replace(/\n/g, '<br>')}</div>
    ${ev.ticketId ? '<button class="primary op-go">💬 כנס לשיחה</button>' : ''}<button class="op-skip">סגור</button></div>`;
  el.querySelector('.op-skip').onclick = () => el.remove();
  if (ev.ticketId) el.querySelector('.op-go').onclick = () => { el.remove(); if (S.mode === 'wa') leaveWa(true); openTicket(ev.ticketId); };
  document.body.appendChild(el);
}

// ---------- 🏢 קריאת שירות לספק (גרסה 98) ----------
// בוחרים ספק + תקלה + פרטים → השרת מתכתב עם הבוט של הספק עד נציג אנושי, ואז מודיע (וואטסאפ + הודעה כאן)
async function vendorDialog() {
  let list;
  try { list = await api('GET', '/api/vendor-bots'); } catch (e) { return toast(e.message, true); }
  if (!list.length) return toast('לא הוגדרו ספקים (data/vendorbots.json בשרת)', true);
  let v = list[0], fault = '';
  const draw = () => {
    openModal(`<h3>🏢 קריאת שירות לספק</h3>
      <div class="hint">המוקד יתכתב עם הבוט של הספק עד שמגיע נציג אנושי, ואז יודיע לך. ההתכתבות תופיע כקריאה רגילה.</div>
      <label>ספק</label><div class="seg" id="vb_v" style="flex-wrap:wrap">${list.map((x, i) => `<button data-i="${i}" class="${x.id === v.id ? 'on' : ''}">${esc(x.icon)} ${esc(x.name)}${x.active ? ' ⏳' : ''}</button>`).join('')}</div>
      ${(v.fields || []).map((f) => `<label>${esc(f.label)}</label><input id="vb_f_${esc(f.key)}" ${f.digits ? 'dir="ltr" inputmode="tel"' : ''}>`).join('')}
      ${v.faults.length ? `<label>מה התקלה?</label><div class="seg" id="vb_fault" style="flex-wrap:wrap">${v.faults.map((x) => `<button data-f="${esc(x)}" class="${x === fault ? 'on' : ''}">${esc(x)}</button>`).join('')}</div>` : ''}
      ${v.active ? '<div class="hint" style="color:#b45309">⏳ כבר יש פנייה פעילה לספק הזה</div>' : ''}
      <div class="row"><button class="primary" id="vb_go">🚀 שלח</button><button id="cancel">ביטול</button></div>`);
    $('#cancel').onclick = closeModal;
    box.querySelectorAll('#vb_v [data-i]').forEach((b) => (b.onclick = () => { v = list[+b.dataset.i]; fault = ''; draw(); }));
    box.querySelectorAll('#vb_fault [data-f]').forEach((b) => (b.onclick = () => { fault = b.dataset.f; box.querySelectorAll('#vb_fault [data-f]').forEach((x) => x.classList.toggle('on', x === b)); }));
    const first = box.querySelector('input'); if (first) first.focus();
    $('#vb_go').onclick = async () => {
      const values = {};
      for (const f of v.fields || []) values[f.key] = $('#vb_f_' + f.key).value.trim();
      const btn = $('#vb_go'); btn.disabled = true; btn.textContent = '⏳ שולח...';
      try { await api('POST', '/api/vendor-bots/start', { vendorId: v.id, fault, values }); closeModal(); toast(`🚀 התחלנו להתכתב עם ${v.name} – אודיע כשמגיע נציג אנושי`, false, 8000); }
      catch (e) { toast(e.message, true, 7000); btn.disabled = false; btn.textContent = '🚀 שלח'; }
    };
  };
  draw();
}

// ---------- קריאת שירות לטכנאי ----------
// "העבר לויקאט" – שינוי הסטטוס במאנדיי (לוקח כחצי דקה)
async function mondayVcat(t, item) {
  const btn = $('#vcatBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ מעביר במאנדיי...'; }
  try {
    const r = await api('POST', `/api/tickets/${t.id}/monday-vcat`, item ? { itemId: item.id, itemName: item.name } : {});
    if (r.ok) return toast(`✅ הועבר לויקאט במאנדיי: ${r.name}`, false, 5000);
    if (!r.items.length) return toast(`לא נמצאה במאנדיי קריאה פתוחה של "${t.customerName}"`, true, 7000);
    openModal(`<h3>🔁 איזו קריאה להעביר לויקאט?</h3>
      <div class="hint">יש כמה קריאות פתוחות של ${esc(t.customerName)} במאנדיי</div>
      ${r.items.map((x, i) => `<div class="row" style="margin-top:6px"><button style="flex:1" data-vi="${i}">${esc(x.name)} <small>(${esc(x.status || 'בלי סטטוס')})</small></button></div>`).join('')}
      <div class="row"><span style="flex:1"></span><button class="ghost" id="vcatCancel">ביטול</button></div>`);
    $('#vcatCancel').onclick = closeModal;
    document.querySelectorAll('[data-vi]').forEach((b) => (b.onclick = () => { closeModal(); mondayVcat(t, r.items[+b.dataset.vi]); }));
  } catch (e) { toast(e.message, true, 7000); }
  finally { const b2 = $('#vcatBtn'); if (b2) { b2.disabled = false; b2.textContent = '🔁 העבר לויקאט'; } }
}
async function serviceCallDialog(t) {
  let d;
  try { d = await api('GET', `/api/tickets/${t.id}/service-call`); } catch (e) { return toast(e.message, true); }
  if (!d.targets.length) return toast('לא הוגדרו יעדים לקריאת שירות (ניהול ← כללי)', true);
  let target = d.targets[0];
  openModal(`<h3>🛠 קריאת שירות</h3>
    <label>למי לשלוח?</label>
    <div class="seg" id="sc_to" style="flex-wrap:wrap;margin-bottom:6px">${d.targets.map((x, i) => `<button data-i="${i}" class="${i ? '' : 'on'}">${x.isGroup ? '👥' : '👤'} ${esc(x.name)}</button>`).join('')}</div>
    <div class="svc">
      <div class="grid2"><div><label>לקוח</label><input id="sc_name" value="${esc(d.customer)}"></div>
      <div><label>חברה</label><input id="sc_co" value="${esc(d.company)}"></div></div>
      <label>טלפון הפונה</label><input id="sc_ph" dir="ltr" value="${esc(d.phone ? localPhone(d.phone) : '')}">
      <label>כתובת (לא חובה)</label><input id="sc_addr">
      <label>תיאור הפנייה</label><textarea id="sc_desc" rows="6">${esc(d.description)}</textarea>
    </div>
    <div class="hint" id="sc_assign" style="margin:8px 0 0;font-size:13px"></div>
    <label id="sc_lbl"></label><div class="tcard" style="white-space:pre-line;font-size:14px" id="sc_prev"></div>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="sc_notify" ${d.isGroup || d.ticketStatus === 'closed' ? '' : 'checked'}> 📩 לשלוח ללקוח הודעה שאנחנו מטפלים</label>
    <textarea id="sc_cmsg" rows="3">${esc(d.customerMsg)}</textarea>
    ${S.me.role === 'admin' ? '<label class="check" style="font-size:12px"><input type="checkbox" id="sc_csave"> לשמור את הנוסח הזה לפעם הבאה (אפשר להשתמש ב-{name} ו-{id})</label>' : ''}
    <div class="row"><button class="primary" id="sc_send"></button><button id="cancel">ביטול</button></div>`, true);
  const syncNotify = () => { $('#sc_cmsg').style.display = $('#sc_notify').checked ? '' : 'none'; };
  $('#sc_notify').onchange = syncNotify; syncNotify();
  const build = () => {
    const name = $('#sc_name').value.trim(), co = $('#sc_co').value.trim(), ph = $('#sc_ph').value.trim(), addr = $('#sc_addr').value.trim();
    return [`🛠 *קריאת שירות* #${t.id}`, `👤 לקוח: ${name}${co ? ` (${co})` : ''}`, ph ? `📞 טלפון: ${ph}` : '', addr ? `📍 כתובת: ${addr}` : '',
      '', '📝 תיאור הפנייה:', $('#sc_desc').value.trim(), '', `נפתח ע״י: ${S.me.name}`]
      .filter((x, i) => x !== '' || i === 4 || i === 7).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  };
  const paint = () => {
    $('#sc_prev').textContent = build();
    $('#sc_lbl').textContent = `כך זה יישלח ל${target.name}:`;
    $('#sc_send').textContent = `📤 שלח ל${target.name}`;
    $('#sc_assign').innerHTML = target.userName
      ? `↪️ הקריאה תועבר במוקד ל<b>${esc(target.userName)}</b>`
      : `↪️ להעביר את הקריאה במוקד ל: <select id="sc_user" style="width:auto;display:inline-block;margin:0 6px"><option value="">— להשאיר אצל ${esc(d.currentAssignee || 'המטפל הנוכחי')} —</option>${S.users.map((u) => `<option value="${u.id}" ${u.name.trim() === target.name.trim() ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
        ${S.me.role === 'admin' ? `<label class="check" style="display:inline-flex;font-size:12px;margin:0"><input type="checkbox" id="sc_remember" checked> לזכור ל"${esc(target.name)}"</label>` : ''}`;
  };
  box.querySelectorAll('#sc_to button').forEach((b) => (b.onclick = () => {
    target = d.targets[+b.dataset.i];
    box.querySelectorAll('#sc_to button').forEach((x) => x.classList.toggle('on', x === b)); paint();
  }));
  box.querySelectorAll('.svc input, .svc textarea').forEach((el) => (el.oninput = paint));
  paint();
  $('#cancel').onclick = closeModal;
  $('#sc_send').onclick = async () => {
    const notify = $('#sc_notify').checked, ctext = $('#sc_cmsg').value.trim();
    const save = $('#sc_csave') && $('#sc_csave').checked;
    // שמירת נוסח: מחזירים את השם/מספר הקריאה למשתנים
    let tpl = save ? ctext.split(String(t.id)).join('{id}') : '';
    const first = String(d.customer || '').trim().split(' ')[0];
    if (tpl && first && !/^[\d+\s-]+$/.test(first)) tpl = tpl.split(' ' + first).join('{name}');
    try {
      const assignUserId = $('#sc_user') ? $('#sc_user').value : '';
      const rememberLink = !!($('#sc_remember') && $('#sc_remember').checked && assignUserId);
      const r = await api('POST', `/api/tickets/${t.id}/service-call`, { targetId: target.id, text: build(), notifyCustomer: notify, customerText: ctext, saveCustomerMsg: save, customerTemplate: tpl, assignUserId, rememberLink });
      closeModal();
      toast(`🛠 הקריאה נשלחה ל${target.name} ✓${r.customerSent ? ' · 📩 הלקוח קיבל הודעה' : r.customerError ? ' · ⚠️ ההודעה ללקוח לא נשלחה' : ''}`, !!r.customerError, 6000);
    }
    catch (e) { toast(e.message, true, 7000); }
  };
}

// ---------- תבניות הודעה ----------
async function loadTemplates() { S.templates = await api('GET', '/api/templates').catch(() => S.templates || []); }
function fillTemplate(text, { name = '', company = '' } = {}) {
  const first = name && !/^[\d+\s-]+$/.test(name) ? name.split(' ')[0] : '';
  return text.replace(/\{name\}/g, first).replace(/\{company\}/g, company || '').replace(/\{agent\}/g, S.me.name).replace(/ {2,}/g, ' ');
}
function templatePicker(onPick, onCancel) {
  const list = S.templates || [];
  const draw = (q = '') => {
    const f = list.filter((t) => !q || (t.title + ' ' + t.text).includes(q));
    $('#tlist').innerHTML = f.length ? f.map((t) => `<button class="tpl" data-id="${t.id}"><b>${esc(t.title)}</b><span>${esc(t.text.slice(0, 140))}${t.text.length > 140 ? '…' : ''}</span></button>`).join('')
      : '<div class="hint">אין תבניות. לחץ "⚙️ ניהול תבניות" כדי להוסיף.</div>';
    $('#tlist').querySelectorAll('.tpl').forEach((b) => (b.onclick = () => { const t = list.find((x) => x.id === b.dataset.id); closeModal(); onPick(t.text); }));
  };
  openModal(`<h3>📝 בחר תבנית</h3><input id="tq" placeholder="🔍 חיפוש תבנית">
    <div class="pick" id="tlist" style="margin-top:8px;max-height:55vh;overflow-y:auto"></div>
    <div class="row"><button id="tman">⚙️ ניהול תבניות</button><span style="flex:1"></span><button id="cancel">ביטול</button></div>`);
  draw();
  $('#tq').oninput = (e) => draw(e.target.value.trim());
  $('#tq').focus();
  $('#tman').onclick = () => templatesManager();
  $('#cancel').onclick = () => { closeModal(); if (onCancel) onCancel(); };
}
function templatesManager() {
  const list = S.templates || [];
  openModal(`<div class="row" style="margin:0 0 10px;justify-content:space-between"><h3 style="margin:0">📝 תבניות הודעה</h3><button class="primary" id="tnew">+ תבנית חדשה</button></div>
    <div class="hint" style="margin-bottom:8px">אפשר לכתוב בתבנית <code>{name}</code> לשם הלקוח, <code>{company}</code> לחברה, <code>{agent}</code> לשם שלך.</div>
    <div id="tcards">${list.map((t) => `<div class="tcard" data-id="${t.id}">
      <div class="tc-head"><b>${esc(t.title)}</b><span class="tc-act">
        <button class="ghost" data-copy title="העתק">⧉</button><button class="ghost" data-edit title="עריכה">✏️</button><button class="ghost" data-del title="מחיקה">🗑️</button></span></div>
      <div class="tc-text">${esc(t.text)}</div>${t.text.split('\n').length > 4 || t.text.length > 220 ? '<a class="tc-more">הצג עוד</a>' : ''}</div>`).join('') || '<div class="hint">אין עדיין תבניות.</div>'}</div>
    <div class="row"><span style="flex:1"></span><button id="cancel">סגור</button></div>`, true);
  $('#cancel').onclick = closeModal;
  $('#tnew').onclick = () => templateForm(null);
  box.querySelectorAll('.tcard').forEach((c) => {
    const t = list.find((x) => x.id === c.dataset.id);
    c.querySelector('[data-copy]').onclick = async (e) => { e.stopPropagation(); toast((await copyText(t.text)) ? 'הועתק ✓' : 'לא הצלחתי להעתיק'); };
    c.querySelector('[data-edit]').onclick = () => templateForm(t);
    const del = c.querySelector('[data-del]');
    del.onclick = async () => {
      if (!del.dataset.sure) { del.dataset.sure = 1; del.textContent = 'בטוח?'; return; }
      await api('DELETE', '/api/templates/' + t.id); await loadTemplates(); templatesManager();
    };
    const more = c.querySelector('.tc-more');
    if (more) more.onclick = () => { c.classList.toggle('open'); more.textContent = c.classList.contains('open') ? 'הצג פחות' : 'הצג עוד'; };
  });
}
function templateForm(t) {
  openModal(`<h3>${t ? '✏️ עריכת תבנית' : '+ תבנית חדשה'}</h3>
    <label>כותרת</label><input id="tft" value="${esc(t ? t.title : '')}" placeholder="למשל: הצעה">
    <label>תוכן ההודעה</label><textarea id="tfx" rows="10">${esc(t ? t.text : '')}</textarea>
    <div class="row"><button class="primary" id="tfs">💾 שמור</button><button id="cancel">ביטול</button></div>`, true);
  $('#tft').focus();
  $('#cancel').onclick = () => templatesManager();
  $('#tfs').onclick = async () => {
    try { await api('POST', '/api/templates', { id: t ? t.id : undefined, title: $('#tft').value, text: $('#tfx').value }); await loadTemplates(); toast('התבנית נשמרה ✓'); templatesManager(); }
    catch (e) { toast(e.message, true); }
  };
}

function snoozeDialog(t) {
  const at = (d, h, m) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, m, 0, 0); return x.getTime(); };
  const opts = [
    ['בעוד שעה', Date.now() + 3600e3],
    ['בעוד 4 שעות', Date.now() + 4 * 3600e3],
    ['מחר ב-8:30', at(1, 8, 30)],
    ['בעוד 3 ימים', Date.now() + 3 * 864e5],
  ];
  const local = new Date(Date.now() + 3600e3 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  openModal(`<h3>⏸ השהיית הקריאה עם ${esc(t.customerName)}</h3>
    <div class="hint">הקריאה עוברת לרשימת "⏸ מושהות" ולא מופיעה בין הפתוחות. כשמגיע הזמן – קופצת תזכורת ${t.assigneeName ? 'ל' + esc(t.assigneeName) : ''}, והקריאה חוזרת לרשימה.<br>אם הלקוח כותב בינתיים – הקריאה חוזרת מיד.</div>
    <div class="pick" style="margin-top:10px">${opts.map(([l, ts], i) => `<button data-i="${i}"><b style="flex:1">⏰ ${l}</b><span class="chip">${fmtWhen(ts)}</span></button>`).join('')}</div>
    <label>או בחר תאריך ושעה</label><div class="row" style="margin:0"><input type="datetime-local" id="sdt" value="${local}" style="flex:1"><button class="primary" id="sgo">השהה עד</button></div>
    <div class="row"><button id="cancel">ביטול</button></div>`);
  const go = async (until) => {
    try { await api('POST', `/api/tickets/${t.id}/snooze`, { until }); closeModal(); toast(`⏸ הקריאה הושהתה עד ${fmtWhen(until)}`); }
    catch (e) { toast(e.message, true); }
  };
  box.querySelectorAll('.pick button').forEach((b) => (b.onclick = () => go(opts[+b.dataset.i][1])));
  $('#sgo').onclick = () => { const v = $('#sdt').value; if (!v) return; go(new Date(v).getTime()); };
  $('#cancel').onclick = closeModal;
}

function reminderPopup(t) {
  Sounds.reminder();
  notify('⏰ תזכורת לקריאה', `${t.customerName}${t.company ? ' (' + t.company + ')' : ''} – #${t.id}`);
  const html = `<h3>⏰ תזכורת</h3>
    <div style="font-size:17px;margin:6px 0 2px"><b>${esc(t.customerName)}</b> ${t.isGroup ? '' : `<span class="ph big" dir="ltr">${localPhone(t.phone)}</span>`}</div>
    <div class="hint">${t.company ? '🏢 ' + esc(t.company) + ' · ' : ''}קריאה #${t.id}${t.lastText ? ' · ' + esc(t.lastText.slice(0, 80)) : ''}</div>
    <div class="row"><button class="primary" id="ropen">פתח את הקריאה</button><button id="rlater">⏸ תזכיר שוב</button><button id="cancel">סגור</button></div>`;
  if (modal.classList.contains('on') && !box.querySelector('#ropen')) { toast(`⏰ תזכורת: ${t.customerName} – #${t.id}`, false, 10000); return; }
  openModal(html);
  $('#ropen').onclick = () => { closeModal(); openTicket(t.id); };
  $('#rlater').onclick = () => snoozeDialog(t);
  $('#cancel').onclick = closeModal;
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
    <div class="row" style="margin:10px 0 4px;justify-content:space-between"><label style="margin:0">הודעה</label><button id="ntpl" type="button">📝 בחר תבנית</button></div>
    <textarea id="ntext" rows="7"></textarea>
    <div class="row"><button class="primary" id="nsend">שלח ופתח קריאה</button><button id="ndial" title="הטלפון שלך יצלצל, וכשתרים – יחייג ללקוח">📞 חייג</button><button id="cancel">ביטול</button></div>`);
  $('#ndial').onclick = () => { if (!$('#nphone').value.trim()) return toast('בחר לקוח או כתוב טלפון', true); dialPhone($('#nphone').value, $('#nname').value); };
  $('#cancel').onclick = closeModal;
  const fmt = (p) => (p.startsWith('972') ? '0' + p.slice(3) : p);
  let timer;
  const search = async () => {
    const q = $('#csearch').value.trim();
    if (!q) { $('#cres').innerHTML = ''; return; }
    const r = await api('GET', '/api/contacts?q=' + encodeURIComponent(q)).catch(() => ({ list: [], total: 0 }));
    if (!r.total) { $('#cres').innerHTML = '<div class="hint">אין עדיין אנשי קשר – המנהל מייבא אותם ב"ניהול ← 📇 אנשי קשר"</div>'; return; }
    $('#cres').innerHTML = r.list.length ? r.list.flatMap((c) => c.phones.map((p) => `<button data-p="${p}" data-n="${esc(c.name || c.company)}">
      <span style="flex:1">${c.company ? '🏢 ' + esc(c.company) : ''}${c.company && c.name ? ' · ' : ''}${esc(c.name || '')}</span><span dir="ltr" class="chip">${fmt(p)}</span><span class="cdial" data-dial="${p}" title="חייג">📞</span></button>`)).join('')
      : '<div class="hint">לא נמצא</div>';
    $('#cres').querySelectorAll('.cdial').forEach((d) => (d.onclick = (e) => { e.stopPropagation(); const b = d.closest('button'); dialPhone(fmt(d.dataset.dial), b.dataset.n); }));
    $('#cres').querySelectorAll('button').forEach((b) => (b.onclick = () => {
      $('#nphone').value = fmt(b.dataset.p); $('#nname').value = b.dataset.n; $('#cres').innerHTML = ''; $('#csearch').value = b.dataset.n; $('#ntext').focus({ preventScroll: true });
    }));
  };
  $('#csearch').oninput = () => { clearTimeout(timer); timer = setTimeout(search, 200); };
  $('#ntpl').onclick = () => {
    // שומרים את מה שכבר מולא, פותחים את בורר התבניות, וחוזרים
    const keep = { inst: $('#ninst').value, phone: $('#nphone').value, name: $('#nname').value, text: $('#ntext').value, q: $('#csearch').value };
    templatePicker((text) => {
      newChatDialog();
      $('#ninst').value = keep.inst; $('#nphone').value = keep.phone; $('#nname').value = keep.name; $('#csearch').value = keep.q;
      $('#ntext').value = fillTemplate(text, { name: keep.name });
    }, () => { newChatDialog(); $('#ninst').value = keep.inst; $('#nphone').value = keep.phone; $('#nname').value = keep.name; $('#ntext').value = keep.text; $('#csearch').value = keep.q; });
  };
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
  const keepEx = $('#exPeriod') ? { p: $('#exPeriod').value, s: $('#exScope').value } : null;
  let st;
  try { st = await api('GET', '/api/admin/stats?period=' + period); } catch (e) { return toast(e.message, true); }
  if (modal.classList.contains('on') && !box.querySelector('#dash')) closeModal();
  const n = st.now, p = st.period_;
  const waitCls = (ms) => (ms > 15 * 60000 ? 'late' : ms > 5 * 60000 ? 'mid' : '');
  const periods = [['today', 'היום'], ['week', '7 ימים'], ['month', '30 יום'], ['all', 'הכל']];
  const max = Math.max(1, ...p.byUser.map((u) => u.closed));
  // יעד סגירה יומי: היום – "X מתוך Y"; 7/30 יום – ממוצע ליום מול היעד
  const goal = (u) => {
    if (!u.target) return '—';
    if (!p.days) return `${u.target} ליום`;
    const v = p.days === 1 ? u.closed : Math.round((u.closed / p.days) * 10) / 10;
    const ok = v >= u.target;
    return `<span class="chip" style="font-weight:600;${ok ? 'background:#dcfce7;color:#166534' : 'background:#fee2e2;color:#991b1b'}">${ok ? '✅' : '🎯'} ${v} / ${u.target}${p.days === 1 ? '' : ' ממוצע ליום'}</span>`;
  };
  const tile = (label, value, sub = '', cls = '') => `<div class="tile ${cls}"><div class="tl">${label}</div><div class="tv">${value}</div>${sub ? `<div class="ts">${sub}</div>` : ''}</div>`;
  const html = `<div id="dash">
    <div class="row" style="margin:0 0 12px;justify-content:space-between"><h3 style="margin:0">📊 דשבורד</h3>
      <div class="seg">${periods.map(([k, l]) => `<button data-p="${k}" class="${k === period ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <h4 style="margin-top:0">עכשיו</h4>
    <div class="tiles">
      ${tile('קריאות פתוחות', n.open)}
      ${tile('ממתינות לתשובה', n.waiting, n.waiting ? 'לקוחות שמחכים' : 'אף אחד לא מחכה 👍')}
      ${tile('ההמתנה הארוכה ביותר', n.waiting ? dur(n.oldestWaitMs) : '—', '', n.waiting ? 'wt ' + waitCls(n.oldestWaitMs) : '')}
      ${tile('⏸ מושהות', n.snoozed ?? 0)}
      ${tile('העוזר מברר עם לקוח', n.routing)}
    </div>
    <table class="dtable"><tr><th>עובד</th><th>פתוחות</th><th>מושהות</th><th>ממתינות</th><th>ההמתנה הארוכה</th></tr>
      ${n.byUser.map((u) => `<tr><td>${esc(u.name)}</td><td>${u.open}</td><td>${u.snoozed || 0}</td><td>${u.waiting ? `<span class="dot" style="display:inline-block;margin-left:6px;vertical-align:middle"></span>${u.waiting}` : '0'}</td>
        <td>${u.waiting ? `<span class="chip waittime ${waitCls(u.oldestWaitMs)}">⏳ ${dur(u.oldestWaitMs)}</span>` : '—'}</td></tr>`).join('')}
      ${n.unassigned ? `<tr><td>לא משויך</td><td>${n.unassigned}</td><td></td><td></td><td></td></tr>` : ''}</table>
    ${n.byDept.length ? `<div class="hint" style="margin-top:6px">לפי מחלקה: ${n.byDept.map((d) => `${esc(d.name)} <b>${d.open}</b>`).join(' · ')}${n.noDept ? ` · בלי מחלקה <b>${n.noDept}</b>` : ''}</div>` : ''}
    <h4>${periods.find((x) => x[0] === period)[1]}</h4>
    <div class="tiles">${tile('קריאות שנפתחו', p.opened)}${tile('קריאות שנסגרו', p.closed)}</div>
    <table class="dtable"><tr><th>עובד</th><th style="width:40%">קריאות שסגר/ה</th><th>יעד יומי</th><th>זמן טיפול ממוצע</th><th>זמן תגובה ראשונה ממוצע</th></tr>
      ${p.byUser.map((u) => `<tr><td>${esc(u.name)}</td>
        <td><div class="bar" title="${esc(u.name)}: ${u.closed} קריאות נסגרו">${u.closed ? `<i style="width:${(u.closed / max) * 100}%"></i>` : ""}<b>${u.closed}</b></div></td>
        <td>${goal(u)}</td><td>${dur(u.avgHandleMs)}</td><td>${dur(u.avgFirstResponseMs)}</td></tr>`).join('')}</table>
    <div class="export-row"><b>⬇ הורדת דוח לאקסל</b>
      <select id="exPeriod"><option value="week">7 ימים אחרונים</option><option value="month" selected>30 יום אחרונים</option><option value="today">היום</option><option value="all">הכל</option></select>
      <select id="exScope"><option value="closed">קריאות שנסגרו</option><option value="all">כל הקריאות שנפתחו</option></select>
      <button class="primary" id="exGo">⬇ הורד</button></div>
    <div class="hint">זמן טיפול = מפתיחת הקריאה עד הסגירה. תגובה ראשונה = מההודעה הראשונה של הלקוח עד התשובה הראשונה של עובד (בלי העוזר והמענה האוטומטי).<br>מתעדכן לבד כל 20 שניות · ${new Date(st.generatedAt).toLocaleTimeString('he-IL')}</div>
    <div class="row"><span style="flex:1"></span><button id="dclose">סגור</button></div></div>`;
  if (box.querySelector('#dash')) box.innerHTML = html; else openModal(html, true);
  box.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => { localStorage.setItem('hd-dash', b.dataset.p); dashboardDialog(b.dataset.p); }));
  $('#dclose').onclick = () => { clearInterval(dashTimer); closeModal(); };
  if (keepEx) { $('#exPeriod').value = keepEx.p; $('#exScope').value = keepEx.s; }
  $('#exGo').onclick = () => {
    const a = document.createElement('a');
    a.href = `/api/admin/export?period=${$('#exPeriod').value}&scope=${$('#exScope').value}`;
    a.download = ''; document.body.appendChild(a); a.click(); a.remove();
    toast('הדוח יורד – נפתח באקסל');
  };
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
    <div class="hint">ההודעה נשלחת לקבוצה המשותפת בוואטסאפ, ונפתחת קריאה אצל ${isAdmin ? 'העובד' : 'הצד השני'} – עד שיענה או יסגור.</div>
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
  openModal(`<h3>⚙️ ההגדרות שלי <a id="newsAll" style="font-size:13px;cursor:pointer;float:left">🆕 מה חדש</a></h3>
    <h4>תצוגה</h4>
    <div class="seg" id="sTheme">${[['tech', '✨ טכנולוגי'], ['light', '☀️ בהיר'], ['dark', '🌙 כהה']].map(([k, n]) => `<button data-t="${k}" class="${currentTheme() === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    <h4>תוכנת WhatsApp Multi</h4>
    <label class="check"><input type="checkbox" id="sMulti" ${(() => { try { return localStorage.getItem('hd-multi') !== '0'; } catch { return true; } })() ? 'checked' : ''}> להציג למעלה כפתור "📱 WhatsApp Multi" (רק במחשב שהתוכנה מותקנת בו)</label>
    <h4>שינוי סיסמה</h4>
    <div class="grid2"><div><label>סיסמה נוכחית</label><input id="pOld" type="password"></div><div><label>סיסמה חדשה</label><input id="pNew" type="password"></div></div>
    <div class="row"><button id="pSave">שנה סיסמה</button><span class="spacer" style="flex:1"></span><button class="primary" id="done">סגור</button></div>`);
  $('#newsAll').onclick = () => whatsNew(true);
  box.querySelectorAll('#sTheme button').forEach((b) => (b.onclick = () => {
    try { localStorage.setItem('hd-theme', b.dataset.t); } catch {}
    applyTheme(b.dataset.t); box.querySelectorAll('#sTheme button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('#sMulti').onchange = (e) => { try { localStorage.setItem('hd-multi', e.target.checked ? '1' : '0'); } catch {} $('#multiBtn').style.display = e.target.checked ? '' : 'none'; };
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
  const tabs = [['deps', '🏷️ מחלקות וניתוב'], ['users', '👥 עובדים'], ['contacts', '📇 אנשי קשר'], ['wa', '📱 מספרי וואטסאפ'], ['pbx', '📞 מרכזייה'], ['ai', '🤖 AI ומענה אוטומטי'], ['general', '⚙️ כללי']];
  openModal(`<h3>🛠️ ניהול המוקד</h3><div class="stabs">${tabs.map(([k, n]) => `<button data-k="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('')}</div><div id="apane"></div>
    <div class="row"><span style="flex:1"></span><button id="aclose">סגור</button></div>`, true);
  box.querySelectorAll('.stabs button').forEach((b) => (b.onclick = () => adminDialog(b.dataset.k)));
  $('#aclose').onclick = closeModal;
  ({ deps: adminDeps, users: adminUsers, contacts: adminContacts, wa: adminWa, pbx: adminPbx, ai: adminAi, general: adminGeneral })[tab]();
}
const userOptions = (cur) => `<option value="">— בחר עובד —</option>` + A.users.filter((u) => u.active).map((u) => `<option value="${u.id}" ${u.id === cur ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
async function saveConfig(patch, msg = 'נשמר ✓') {
  try {
    const r = await api('POST', '/api/admin/config', patch); A.config = r.config; toast(msg);
    if (patch.serviceTargets) { const st = await api('GET', '/api/state'); S.targets = st.targets || []; renderChatHead(); }
    return true;
  } catch (e) { toast(e.message, true); return false; }
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
      <div><label>📞 שלוחה / קו במרכזייה (לחלון "מי מתקשר")</label><input id="uext" dir="ltr" value="${esc(u?.ext || '')}" placeholder="למשל 1094103638"></div>
      <div><label>הטלפון הנייד של העובד (בשביל קבוצות)</label><input id="uphone" dir="ltr" value="${esc(u?.phone ? '0' + u.phone.slice(3) : '')}" placeholder="0521234567"></div>
      <div><label>תפקיד</label><select id="urole"><option value="agent">נציג – רואה רק את הקריאות שלו</option><option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>מנהל – רואה הכל ומנהל</option></select></div></div>
      ${u ? `<label class="check"><input type="checkbox" id="uactive" ${u.active ? 'checked' : ''}> פעיל (אפשר להיכנס ולקבל קריאות)</label>` : ''}
      <label class="check"><input type="checkbox" id="uquick" ${u?.quickClose ? 'checked' : ''}> ✅ יכול לסגור קריאה בלי לכתוב "מה בוצע"</label>
      <label class="check"><input type="checkbox" id="ugpop" ${u?.groupPop ? 'checked' : ''}> 👥 חלון קופץ כשנפתחת קריאה חדשה בקבוצה</label>
      <label class="check"><input type="checkbox" id="ucpop" ${u?.callPopAll ? 'checked' : ''}> 📞 חלון קופץ על כל שיחה נכנסת למשרד (גם כשהשלוחה שלי לא מצלצלת)</label>
      <label class="check"><input type="checkbox" id="uwa" ${u?.waAccess ? 'checked' : ''}> 💬 גישה למסך "וואטסאפ" – רואה את כל הצ׳אטים של המספרים ויכול לכתוב בהם (למנהל תמיד יש)</label>
      <div class="row"><button class="primary" id="usave">💾 שמור</button>${u ? '<button id="unew">+ עובד חדש</button>' : ''}</div>`;
    if ($('#unew')) $('#unew').onclick = () => form(null);
    $('#usave').onclick = async () => {
      try {
        await api('POST', '/api/admin/users', { id: u?.id, name: $('#uname').value, username: $('#uuser').value, password: $('#upass').value, phone: $('#uphone').value, role: $('#urole').value, active: u ? $('#uactive').checked : true, waAccess: $('#uwa').checked, ext: $('#uext').value, quickClose: $('#uquick').checked, groupPop: $('#ugpop').checked, callPopAll: $('#ucpop').checked });
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
      <div><label>שם אמצעי</label><select id="mm">${opt(p.guess.middle ?? -1)}</select></div>
      <div><label>ושם משפחה</label><select id="ml">${opt(p.guess.last)}</select></div></div>
      <label>עמודות של טלפון (אפשר כמה)</label>
      <div>${p.headers.map((h, i) => `<label class="check" style="display:inline-flex;margin-left:14px"><input type="checkbox" data-ph="${i}" ${p.guess.phones.includes(i) ? 'checked' : ''}> ${esc(h || 'עמודה ' + (i + 1))}</label>`).join('')}</div>
      <div class="hint" id="mprev"></div>
      <label>איך לייבא?</label>
      <label class="check"><input type="radio" name="imode" value="merge" checked> ➕ להוסיף רק אנשי קשר חדשים – מספר שכבר קיים במערכת לא ייובא שוב, וכפולים בתוך הקובץ מאוחדים</label>
      <label class="check"><input type="radio" name="imode" value="replace"> 🔄 להחליף את הייבוא הקודם (למשל עדכון רשימה מ-iCount). מי שהוספת ידנית נשאר</label>
      <div class="row"><button class="primary" id="mgo">📥 ייבא</button></div>`;
    const getMap = () => ({ company: +$('#mc').value, name: +$('#mn').value, first: +$('#mf').value, middle: +$('#mm').value, last: +$('#ml').value, phones: [...$('#cmap').querySelectorAll('[data-ph]:checked')].map((x) => +x.dataset.ph) });
    const prev = () => {
      const m = getMap(); const c = (r, i) => (i >= 0 ? r[i] || '' : '');
      $('#mprev').innerHTML = 'דוגמה: ' + p.rows.slice(0, 3).map((r) => `🏢 ${esc(c(r, m.company))} · 👤 ${esc(c(r, m.name) || [c(r, m.first), c(r, m.middle), c(r, m.last)].filter(Boolean).join(' '))} · 📞 ${esc(m.phones.map((i) => c(r, i)).filter(Boolean).join(', '))}`).join('<br>');
    };
    $('#cmap').querySelectorAll('select,input').forEach((el) => (el.onchange = prev)); prev();
    $('#mgo').onclick = async () => {
      const m = getMap();
      if (!m.phones.length) return toast('סמן לפחות עמודת טלפון אחת', true);
      try {
        const mode = box.querySelector('input[name=imode]:checked').value;
        const r = await api('POST', '/api/admin/contacts/import', { rows: p.rows, map: m, mode });
        toast(`נוספו ${r.imported} אנשי קשר ✓` + (r.skippedExisting ? ` · ${r.skippedExisting} כבר היו במערכת` : '') + (r.mergedDupes ? ` · ${r.mergedDupes} כפולים אוחדו` : '') + (r.noPhone ? ` · ${r.noPhone} בלי טלפון` : ''), false, 10000);
        $('#cmap').innerHTML = ''; $('#cfile').value = ''; list();
      } catch (er) { toast(er.message, true); }
    };
  };
  form(null); list();
}

function adminWa() {
  const stateOf = (id) => (A.instances.find((x) => x.id === id) || {}).state || '';
  const dot = (c) => `<span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:${c};vertical-align:middle;margin-left:5px"></span>`;
  const stateText = (s) => s === 'authorized' ? dot('#25d366') + 'מחובר' : s === 'notAuthorized' ? dot('#e53935') + 'לא מחובר – סרוק QR באתר Green API' : s.startsWith('error') ? dot('#e53935') + esc(s) : s === 'unknown' || !s ? dot('#9e9e9e') + 'לא ידוע' : dot('#f9a825') + esc(s);
  const card = (i) => `<div class="card2" data-card="${i.id || 'new'}">
    <div class="grid2"><div><label>שם (למשל: משרד, עסקי)</label><input data-f="name" value="${esc(i.name || '')}"></div>
    <div><label>מצב</label><div style="padding-top:8px">${i.id ? stateText(stateOf(i.id)) : '—'}</div></div>
    <div><label>idInstance</label><input data-f="idInstance" dir="ltr" value="${esc(i.idInstance || '')}"></div>
    <div><label>apiTokenInstance</label><input data-f="token" dir="ltr" value="${esc(i.token || '')}"></div>
    <div><label>apiUrl</label><input data-f="apiUrl" dir="ltr" value="${esc(i.apiUrl || 'https://api.green-api.com')}"></div>
    <div><label>mediaUrl</label><input data-f="mediaUrl" dir="ltr" value="${esc(i.mediaUrl || 'https://media.green-api.com')}"></div></div>
    <label class="check"><input type="checkbox" data-f="enabled" ${i.enabled !== false ? 'checked' : ''}> פעיל</label>
    <div class="row"><button class="primary" data-save>💾 שמור ובדוק חיבור</button>${i.id ? '<button class="ghost" data-del>🗑️ מחק</button>' : ''}</div></div>`;
  $('#apane').innerHTML = `<div class="card2" style="margin-bottom:12px"><b>🔎 הודעה לא נכנסה למוקד? בדיקה</b>
      <div class="row"><input id="dgQ" placeholder="טלפון או שם (למשל: אלעד / 0521234567)" style="flex:1;margin:0"><button id="dgBtn">🔎 בדוק</button></div>
      <div id="dgOut"></div></div>
    <div class="hint">את הפרטים מעתיקים מהאתר של Green API (console.green-api.com) ← בחירת ה-instance.
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
    <h4>👤 אנשי קשר</h4>
    <label class="check"><input type="checkbox" id="gAutoSave" ${c.autoSaveContacts !== false ? 'checked' : ''}> לשמור אוטומטית מי שכותב לנו ועוד לא שמור – לפי השם שלו בוואטסאפ</label>
    <label class="check"><input type="checkbox" id="gGroupsAR" ${c.groups.autoReply ? 'checked' : ''}> לשלוח מענה אוטומטי גם לקבוצות</label>
    <h4>📌 צ'אטים וקבוצות שמקובעים לעובד</h4>
    <div id="ruleList">${c.chatRules.length ? c.chatRules.map((x, i) => `<div class="row" style="margin-top:4px"><span style="flex:1">${x.isGroup ? '👥' : '👤'} ${esc(x.name)} ← <b>${esc(x.userName)}</b></span><button class="ghost" data-unrule="${i}">בטל</button></div>`).join('') : '<div class="hint">אין. (כפתור "📌 קבע לעובד" בראש כל שיחה)</div>'}</div>
    <h4>🔕 קבוצות שמתעלמים מהן לפי שם</h4>
    <label>קבוצה ששמה מכיל אחת מהמילים האלה – לא נפתחת ממנה קריאה בכלל (שורה לכל שם)</label>
    <textarea id="gIgnNames" rows="3">${esc((c.ignoreGroupNames || []).join('\n'))}</textarea>
    <h4>🚫 צ'אטים וקבוצות חסומים</h4>
    <div id="ignList">${c.ignoredChats.length ? c.ignoredChats.map((x, i) => `<div class="row" style="margin-top:4px"><span style="flex:1">${x.isGroup ? '👥' : '👤'} ${esc(x.name || x.chatId)}</span><button class="ghost" data-unign="${i}">✅ בטל חסימה</button></div>`).join('') : '<div class="hint">אין. (כפתור "🚫 חסום" בראש כל שיחה)</div>'}</div>
    <div class="hint">שינוי "מאיפה אפשר להיכנס" או הפורט נכנס לתוקף אחרי הפעלה מחדש של השרת.<br>
    לקוח שכותב "שלום" ואז את הבעיה – ההמתנה נותנת ל-AI את כל ההודעות ביחד, וכך הניתוב מדויק יותר.</div>
    <h4>🛠 יעדים לקריאת שירות</h4>
    <div class="hint">למי אפשר לשלוח "קריאת שירות" מתוך שיחה – טכנאי (טלפון) או קבוצת וואטסאפ.<br>
    "להקצות לעובד" – הקריאה עוברת לעובד הזה במוקד. כשהטכנאי עונה בוואטסאפ <b>"טופל"</b> (בתגובה להודעה, או עם מספר הקריאה) – הקריאה נסגרת לבד.</div>
    <div id="tgList"></div>
    <div class="row"><button id="tgAddP">+ טכנאי (טלפון)</button><button id="tgAddG">+ קבוצה</button></div>
    <h4>⬆ עדכונים</h4>
    <div class="row" style="margin-top:0"><span style="flex:1" id="updStatus">גרסה ${S.version}</span><button id="updNow">⬆ בדוק עדכון עכשיו</button></div>
    <div class="row"><span style="flex:1"></span><button class="primary" id="gSave">💾 שמור</button></div>`;
  api('GET', '/api/admin/update-status').then((r) => { $('#updStatus').textContent = `גרסה ${r.version} · בדיקה אחרונה: ${r.at ? new Date(r.at).toLocaleTimeString('he-IL') + ' – ' + r.result : r.result}`; }).catch(() => {});
  $('#updNow').onclick = async () => {
    $('#updStatus').textContent = 'בודק...';
    try { const r = await api('POST', '/api/admin/update-check'); $('#updStatus').textContent = r.result; if (/עודכן/.test(r.result)) toast('השרת מתעדכן ועולה מחדש – הדף יתרענן לבד', false, 8000); }
    catch (e) { $('#updStatus').textContent = e.message; }
  };
  const targets = (c.serviceTargets || []).map((x) => ({ ...x, userId: x.userId || (A.users.find((u) => u.active && u.name.trim() === String(x.name || '').trim()) || {}).id || '' }));
  let groups = [];
  const drawTargets = () => {
    $('#tgList').innerHTML = targets.map((x, i) => `<div class="row" style="margin-top:6px">
      <input data-t="${i}" data-tf="name" value="${esc(x.name || '')}" placeholder="שם (למשל עידן)" style="flex:1">
      ${x.chatId !== undefined
        ? `<select data-t="${i}" data-tf="chatId" style="flex:2"><option value="">— בחר קבוצה —</option>${groups.map((g) => `<option value="${esc(g.chatId)}" data-inst="${esc(g.instanceId)}" ${g.chatId === x.chatId ? 'selected' : ''}>👥 ${esc(g.name)} (${esc(g.instanceName)})</option>`).join('')}</select>`
        : `<input data-t="${i}" data-tf="phone" dir="ltr" value="${esc(x.phone ? '0' + String(x.phone).slice(3) : '')}" placeholder="05X-XXXXXXX" style="flex:2">`}
      <select data-t="${i}" data-tf="userId" title="הקריאה תוקצה לעובד הזה" style="flex:1"><option value="">— להקצות לעובד? —</option>${A.users.filter((u) => u.active).map((u) => `<option value="${u.id}" ${u.id === x.userId || (!x.userId && u.name.trim() === String(x.name || '').trim()) ? 'selected' : ''}>👤 ${esc(u.name)}</option>`).join('')}</select>
      <button class="ghost" data-tdel="${i}">🗑️</button></div>`).join('') || '<div class="hint">אין יעדים – הכפתור "🛠 קריאת שירות" לא יופיע.</div>';
    $('#tgList').querySelectorAll('[data-tf]').forEach((el) => (el.oninput = el.onchange = () => {
      const x = targets[el.dataset.t]; x[el.dataset.tf] = el.value;
      if (el.dataset.tf === 'chatId') { const o = el.selectedOptions[0]; x.instanceId = o ? o.dataset.inst : null; if (!x.name && o && o.value) x.name = o.text.replace(/^👥 /, '').replace(/ \(.*\)$/, ''); drawTargets(); }
    }));
    $('#tgList').querySelectorAll('[data-tdel]').forEach((b) => (b.onclick = () => { targets.splice(+b.dataset.tdel, 1); drawTargets(); }));
  };
  api('GET', '/api/admin/known-groups').then((g) => { groups = g; drawTargets(); }).catch(drawTargets);
  $('#tgAddP').onclick = () => { targets.push({ name: '', phone: '' }); drawTargets(); };
  $('#tgAddG').onclick = () => { targets.push({ name: '', chatId: '' }); drawTargets(); };
  let ign = [...c.ignoredChats];
  let rules = [...c.chatRules];
  $('#apane').querySelectorAll('[data-unrule]').forEach((b) => (b.onclick = () => { rules.splice(Number(b.dataset.unrule), 1); b.parentElement.remove(); }));
  $('#apane').querySelectorAll('[data-unign]').forEach((b) => (b.onclick = () => { ign.splice(Number(b.dataset.unign), 1); b.parentElement.remove(); }));
  $('#gSave').onclick = () => saveConfig({ companyName: $('#gName').value, routeDelaySec: $('#gDelay').value, host: $('#gHost').value, port: $('#gPort').value,
    groups: { enabled: $('#gGroups').checked, autoReply: $('#gGroupsAR').checked }, autoSaveContacts: $('#gAutoSave').checked, ignoredChats: ign, chatRules: rules,
    ignoreGroupNames: $('#gIgnNames').value.split('\n').map((x) => x.trim()).filter(Boolean),
    serviceTargets: targets });
}


// =====================================================================
// 🎫 משימות צוות: פתיחת משימה לאיש צוות + חלון משימות
// =====================================================================
S.svc = { handlers: [], calls: [], canManage: false, isAdmin: false, whatsapp: false, open: false, tab: null, filter: 'open' };
const SVC_ST = { new: 'חדשה', progress: 'בטיפול', closed: 'סגורה' };
const svcColor = (userId) => (S.svc.handlers.find((h) => h.userId === userId) || {}).color || '#687482';
const svcIsHandler = () => S.svc.handlers.some((h) => h.userId === S.me.id);
async function svcLoad() {
  try { Object.assign(S.svc, await api('GET', '/api/svc')); } catch { return; }
  svcBadge(); if (S.svc.open) svcRender();
}
function svcBadge() {
  const b = $('#teamBadge'); if (!b) return;
  const n = S.svc.calls.filter((c) => c.status === 'new' && c.assigneeId === S.me.id).length;
  b.textContent = n; b.style.display = n ? '' : 'none';
}
function svcOnEvent(ev) {
  if (ev.type === 'svc') {
    const i = S.svc.calls.findIndex((c) => c.id === ev.call.id);
    if (i >= 0) S.svc.calls[i] = ev.call; else S.svc.calls.push(ev.call);
  } else if (ev.type === 'svc-del') S.svc.calls = S.svc.calls.filter((c) => c.id !== ev.id);
  else if (ev.type === 'svc-handlers') S.svc.handlers = ev.handlers;
  else if (ev.type === 'svc-new') {
    const c = ev.call, what = ev.kind === 'transfer' ? 'הועברה אליך משימה' : ev.kind === 'due' ? '⏰ הגיע זמן המשימה' : 'משימה חדשה בשבילך';
    Sounds.newMessage();
    toast(`🎫 ${what} #${c.id}${c.urgent ? ' 🔴 דחוף' : ''}: ${c.subject} (מאת ${ev.byName})`, false, 8000);
    notify(`🎫 ${what} #${c.id}${c.urgent ? ' – דחוף' : ''}`, `${c.subject}${c.customer ? ' · ' + c.customer : ''}`);
    return;
  } else return;
  svcBadge(); if (S.svc.open) svcRender();
}

// ---------- מסך 1: פתיחת משימה ----------
function svcNewDialog(back) {
  if (!S.svc.handlers.length) {
    openModal(`<h3>🎫 משימה חדשה</h3><div class="hint">עוד לא הוגדרו מטפלים.${S.svc.isAdmin ? ' מגדירים ב"🎫 משימות" ← ⚙️ מטפלים.' : ' מנהל צריך להגדיר אותם.'}</div><div class="row"><button id="cancel">סגור</button></div>`);
    $('#cancel').onclick = closeModal; return;
  }
  let who = null;
  openModal(`<h3>🎫 משימה חדשה</h3>
    <label>למי? <b style="color:var(--red)">*</b></label>
    <div class="svc-who" id="svcWho">${S.svc.handlers.map((h) => `<button type="button" data-u="${esc(h.userId)}" style="--hc:${esc(h.color)}">${esc(h.name)}</button>`).join('')}</div>
    <label>נושא <b style="color:var(--red)">*</b></label><input id="svcSubj" maxlength="120" placeholder="למשל: להתקשר ללקוח לגבי החשבונית">
    <div class="grid2"><div><label>לקוח / איש קשר</label><input id="svcCust" maxlength="120"></div>
      <div><label>טלפון</label><input id="svcPhone" maxlength="20" inputmode="tel" dir="ltr" style="text-align:right"></div></div>
    <label>פרטים</label><textarea id="svcDet" rows="3" maxlength="2000"></textarea>
    <label class="check"><input type="checkbox" id="svcUrg"> 🔴 דחוף</label>
    <div class="svc-err" id="svcErr"></div>
    <div class="row"><button class="primary" id="svcSave">פתח קריאה</button><button id="cancel">ביטול</button></div>`);
  const mark = () => box.querySelectorAll('#svcWho button').forEach((b) => b.classList.toggle('on', b.dataset.u === who));
  box.querySelectorAll('#svcWho button').forEach((b) => (b.onclick = () => { who = b.dataset.u; mark(); $('#svcErr').textContent = ''; }));
  $('#svcSubj').focus();
  $('#cancel').onclick = () => (back ? svcOpen() : closeModal());
  $('#svcSave').onclick = async () => {
    const err = (m, el) => { $('#svcErr').textContent = '⚠️ ' + m; if (el) el.focus(); };
    const subject = $('#svcSubj').value.trim();
    if (!who) return err('צריך לבחור למי להעביר את הקריאה');
    if (subject.length < 2) return err('חסר נושא לקריאה', $('#svcSubj'));
    $('#svcSave').disabled = true;
    try {
      const c = await api('POST', '/api/svc/calls', { assigneeId: who, subject, customer: $('#svcCust').value, phone: $('#svcPhone').value, details: $('#svcDet').value, urgent: $('#svcUrg').checked });
      if (!S.svc.calls.some((x) => x.id === c.id)) S.svc.calls.push(c);
      toast(`קריאה #${c.id} הועברה ל${c.assigneeName} ✓`, false, 5000);
      if (back) svcOpen(); else closeModal();
      svcBadge();
    } catch (e) { err(e.message); $('#svcSave').disabled = false; }
  };
}

// ---------- מסך 2: חלון המשימות ----------
function svcOpen() {
  if (S.svc.tab === null) S.svc.tab = svcIsHandler() ? S.me.id : 'all';
  S.svc.open = true;
  openModal('<div id="svcWin"></div>', true);
  svcRender();
  svcLoad();
}
function svcSort(list) {
  return list.sort((a, b) => (a.status === 'closed') - (b.status === 'closed') || (a.status === 'closed' ? (b.closedAt || 0) - (a.closedAt || 0) : (b.urgent - a.urgent) || (b.createdAt - a.createdAt)));
}
function svcCard(c) {
  const others = S.svc.handlers.filter((h) => h.userId !== c.assigneeId);
  const m = S.svc.canManage, closed = c.status === 'closed';
  return `<div class="svc-card ${closed ? 'closed' : ''}" style="--hc:${esc(svcColor(c.assigneeId))}" data-id="${c.id}">
    <div class="svc-h"><b>#${c.id}</b> <span class="svc-subj">${esc(c.subject)}</span>
      ${c.dueAt ? `<span class="chip">⏰ ${fmtWhen(c.dueAt)}</span>` : ''}${c.urgent ? '<span class="chip svc-urg">🔴 דחוף</span>' : ''}<span class="chip svc-st ${c.status}">${SVC_ST[c.status] || ''}</span></div>
    <div class="svc-meta"><span class="svc-who-chip">👤 ${esc(c.assigneeName)}</span>
      ${c.customer ? `<span>🏢 ${esc(c.customer)}</span>` : ''}${c.phone ? `<span>📞 <a href="tel:${esc(c.phone.replace(/[^0-9+]/g, ''))}" dir="ltr">${esc(c.phone)}</a></span>` : ''}
      <span>🕒 ${fmtWhen(c.createdAt)} · ${esc(c.createdByName)}</span>${closed && c.closedAt ? `<span>✅ ${fmtWhen(c.closedAt)}</span>` : ''}</div>
    ${c.details ? `<div class="svc-det">${esc(c.details)}</div>` : ''}
    <div class="svc-acts">
      ${m && c.status === 'new' ? '<button data-a="start">▶ התחלתי לטפל</button>' : ''}
      ${m && !closed ? '<button class="primary" data-a="close">✅ סגור קריאה</button>' : ''}
      ${m && closed ? '<button data-a="reopen">🔄 פתח מחדש</button>' : ''}
      ${m && others.length ? `<select data-a="transfer"><option value="">↪️ העבר ל...</option>${others.map((h) => `<option value="${esc(h.userId)}">${esc(h.name)}</option>`).join('')}</select>` : ''}
      <button class="ghost" data-a="hist">🕘 היסטוריה</button>
      ${S.svc.isAdmin ? '<button class="ghost" data-a="del" title="מחיקה">🗑️</button>' : ''}
    </div>
    <div class="svc-hist" style="display:none">${(c.history || []).map((h) => `<div>${fmtWhen(h.ts)} · ${esc(h.byName)}: ${h.kind === 'open' ? 'פתח/ה את הקריאה' : h.kind === 'assign' ? `העביר/ה מ${esc(h.fromName)} ל${esc(h.toName)}` : `סטטוס ${SVC_ST[h.from] || ''} ← ${SVC_ST[h.to] || ''}`}</div>`).join('')}</div>
  </div>`;
}
function svcRender() {
  const w = $('#svcWin'); if (!w) { S.svc.open = false; return; }
  const all = S.svc.calls, F = S.svc.filter;
  if (S.svc.tab !== 'all' && !S.svc.handlers.some((h) => h.userId === S.svc.tab)) S.svc.tab = 'all';
  const openOf = (id) => all.filter((c) => c.status !== 'closed' && (id === 'all' || c.assigneeId === id)).length;
  let list = all.filter((c) => S.svc.tab === 'all' || c.assigneeId === S.svc.tab);
  list = list.filter((c) => F === 'all' || (F === 'open' ? c.status !== 'closed' : c.status === F));
  svcSort(list);
  const tabs = [...S.svc.handlers.map((h) => ({ id: h.userId, name: h.userId === S.me.id ? 'הקריאות שלי' : h.name, color: h.color })), { id: 'all', name: 'כולם', color: '' }];
  w.innerHTML = `<div class="svc-top"><h3>🎫 משימות צוות</h3><span class="spacer"></span>
      <button class="primary" id="svcAdd" title="Alt+N">➕ משימה חדשה</button>${S.svc.isAdmin ? '<button id="svcCfg">⚙️ מטפלים</button>' : ''}<button class="ghost" id="svcX">✕</button></div>
    <div class="svc-tabs">${tabs.map((t) => `<button data-t="${esc(t.id)}" class="${S.svc.tab === t.id ? 'on' : ''}" ${t.color ? `style="--hc:${esc(t.color)}"` : ''}>${esc(t.name)} <span class="chip">${openOf(t.id)}</span></button>`).join('')}</div>
    <div class="svc-filter">${[['open', 'פתוחות'], ['new', 'חדשות'], ['progress', 'בטיפול'], ['closed', 'סגורות'], ['all', 'הכול']].map(([k, n]) => `<button data-f="${k}" class="${F === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    <div class="svc-list">${list.map(svcCard).join('') || '<div class="empty">אין משימות כאן 🎉</div>'}</div>`;
  $('#svcX').onclick = () => { S.svc.open = false; closeModal(); };
  $('#svcAdd').onclick = () => svcNewDialog(true);
  if ($('#svcCfg')) $('#svcCfg').onclick = svcHandlersDialog;
  w.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { S.svc.tab = b.dataset.t; svcRender(); }));
  w.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { S.svc.filter = b.dataset.f; svcRender(); }));
  w.querySelectorAll('.svc-card').forEach((card) => {
    const id = Number(card.dataset.id);
    const run = async (body) => {
      try { const c = await api('POST', `/api/svc/calls/${id}`, body); const i = S.svc.calls.findIndex((x) => x.id === id); if (i >= 0) S.svc.calls[i] = c; svcRender(); svcBadge(); return c; }
      catch (e) { toast(e.message, true); }
    };
    card.querySelectorAll('button[data-a]').forEach((b) => (b.onclick = async () => {
      const a = b.dataset.a;
      if (a === 'hist') { const h = card.querySelector('.svc-hist'); h.style.display = h.style.display === 'none' ? '' : 'none'; return; }
      if (a === 'del') {
        if (!confirm(`למחוק את קריאה #${id}? אי אפשר לבטל.`)) return;
        try { await api('DELETE', `/api/svc/calls/${id}`); S.svc.calls = S.svc.calls.filter((x) => x.id !== id); svcRender(); svcBadge(); toast(`קריאה #${id} נמחקה`); } catch (e) { toast(e.message, true); }
        return;
      }
      b.disabled = true; await run({ action: a });
    }));
    const sel = card.querySelector('select[data-a="transfer"]');
    if (sel) sel.onchange = async () => { if (!sel.value) return; const c = await run({ action: 'transfer', to: sel.value }); if (c) toast(`קריאה #${id} הועברה ל${c.assigneeName} ✓`); };
  });
}

// ---------- ⚙️ עריכת רשימת המטפלים (מנהל) ----------
function svcHandlersDialog() {
  const COLORS = ['#2b7de9', '#d6336c', '#2f9e44', '#f08c00', '#7048e8', '#0c8599', '#e8590c', '#5c940d'];
  const cur = new Map(S.svc.handlers.map((h) => [h.userId, h.color]));
  const order = [...S.svc.handlers.map((h) => h.userId), ...S.users.filter((u) => !cur.has(u.id)).map((u) => u.id)];
  openModal(`<h3>⚙️ מטפלים במשימות צוות</h3><div class="hint">מסמנים מי מקבל משימות ובוחרים לו צבע.</div>
    <div id="svcHl">${order.map((id, i) => { const u = S.users.find((x) => x.id === id); if (!u) return ''; return `<div class="row svc-hrow" style="margin-top:6px">
      <label class="check" style="flex:1;margin:0"><input type="checkbox" data-u="${esc(id)}" ${cur.has(id) ? 'checked' : ''}> ${esc(u.name)}</label>
      <input type="color" data-c="${esc(id)}" value="${esc(cur.get(id) || COLORS[i % COLORS.length])}" style="width:48px;padding:2px"></div>`; }).join('')}</div>
    <label class="check"><input type="checkbox" id="svcWa" ${S.svc.whatsapp ? 'checked' : ''}> לשלוח למטפל גם הודעת וואטסאפ לטלפון שמוגדר אצלו (ניהול ← משתמשים)</label>
    <div class="row"><button class="primary" id="svcHSave">שמור</button><button id="cancel">ביטול</button></div>`);
  $('#cancel').onclick = svcOpen;
  $('#svcHSave').onclick = async () => {
    const handlers = [...box.querySelectorAll('#svcHl input[type=checkbox]')].filter((x) => x.checked).map((x) => ({ userId: x.dataset.u, color: box.querySelector(`[data-c="${x.dataset.u}"]`).value }));
    try { const r = await api('PUT', '/api/svc/handlers', { handlers, whatsapp: $('#svcWa').checked }); S.svc.handlers = r.handlers; S.svc.whatsapp = r.whatsapp; toast('נשמר ✓'); svcOpen(); }
    catch (e) { toast(e.message, true); }
  };
}

// Alt+N – משימה חדשה מכל מקום בתוכנה
document.addEventListener('keydown', (e) => {
  if (!S.me || !$('#teamBtn') || !e.altKey || e.ctrlKey || e.metaKey || e.code !== 'KeyN') return;
  e.preventDefault(); svcNewDialog(S.svc.open);
});

boot();


// =====================================================================
// 💬 מסך "וואטסאפ": כל הצ'אטים של מספרי המשרד, כמו בוואטסאפ ווב
// =====================================================================
S.wa = { inst: null, chats: [], q: '', sel: null, view: null, replyTo: null, count: 60 };
// שעה להיום, "אתמול", אחרת תאריך
function waWhen(ts) {
  const d = new Date(ts), t = new Date(); t.setHours(0, 0, 0, 0);
  if (ts >= t.getTime()) return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  if (ts >= t.getTime() - 864e5) return 'אתמול';
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
}
const waPreview = { image: '📷 תמונה', video: '🎬 וידאו', file: '📎 קובץ', audio: '🎤 הקלטה', location: '📍 מיקום' };
function enterWa() {
  S.mode = 'wa'; S.sel = null; S.view = null; renderList();
  $('#tSide').style.display = 'none'; $('#waSide').style.display = '';
  $('#waBtn').classList.add('on'); $('#waBtn').innerHTML = '🎫<span class="lbl"> חזרה לקריאות</span>';
  try { S.wa.inst = S.wa.inst || localStorage.getItem('hd-wa-inst'); } catch {}
  if (!S.instances.some((i) => i.id === S.wa.inst)) S.wa.inst = S.instances[0] && S.instances[0].id;
  renderWaSide(); renderWaChat(); loadWaChats();
}
function leaveWa(keepChat) {
  S.mode = null;
  $('#waSide').style.display = 'none'; $('#tSide').style.display = '';
  if ($('#waBtn')) { $('#waBtn').classList.remove('on'); $('#waBtn').innerHTML = '💬<span class="lbl"> וואטסאפ</span>'; }
  if (!keepChat) renderChat();
}
function renderWaSide() {
  const el = $('#waSide');
  el.innerHTML = `<div class="tabs">${S.instances.map((i) => `<button class="${i.id === S.wa.inst ? 'on' : ''}" data-inst="${i.id}">📱 ${esc(i.name)}</button>`).join('')}</div>
    <div class="search"><input id="waQ" placeholder="🔍 חיפוש שם, טלפון או מלל בהודעות" value="${esc(S.wa.q)}"></div>
    <div class="list" id="waList"><div class="empty">טוען צ׳אטים...</div></div>`;
  el.querySelectorAll('[data-inst]').forEach((b) => (b.onclick = () => {
    S.wa.inst = b.dataset.inst; S.wa.sel = null; S.wa.view = null;
    try { localStorage.setItem('hd-wa-inst', S.wa.inst); } catch {}
    renderWaSide(); renderWaChat(); loadWaChats();
  }));
  let tm;
  $('#waQ').oninput = (e) => { S.wa.q = e.target.value.trim(); clearTimeout(tm); tm = setTimeout(loadWaChats, 300); };
}
async function loadWaChats() {
  if (!S.wa.inst) { $('#waList').innerHTML = '<div class="empty">אין מספרי וואטסאפ מוגדרים</div>'; return; }
  try { S.wa.chats = await api('GET', `/api/wa/chats?inst=${encodeURIComponent(S.wa.inst)}&q=${encodeURIComponent(S.wa.q)}`); }
  catch (e) { $('#waList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  renderWaList();
}
// גרסה 100: הדגשת המילה שנמצאה בחיפוש מלל
function waHit(text) {
  const q = S.wa.q; const s = esc(text);
  if (!q) return s;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  return i < 0 ? s : esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}
function renderWaList() {
  const el = $('#waList'); if (!el) return;
  if (!S.wa.chats.length) { el.innerHTML = `<div class="empty">${S.wa.q ? 'לא נמצא' : 'אין עדיין צ׳אטים – הם יופיעו כאן עם כל הודעה'}</div>`; return; }
  el.innerHTML = S.wa.chats.map((c) => {
    const title = c.name || localPhone(c.phone) || c.chatId;
    return `<div class="item ${c.key === S.wa.sel ? 'sel' : ''}" data-key="${esc(c.key)}">
      <div class="av" style="background:${avColor(c.phone || c.chatId)}">${c.isGroup ? '👥' : esc(initials(title))}</div>
      <div class="body"><div class="row1"><span class="name">${esc(title)}${c.name && c.phone ? ` <span class="ph" dir="ltr">${localPhone(c.phone)}</span>` : ''}</span><span class="time">${c.ts ? waWhen(c.ts) : ''}</span></div>
        <div class="row2"><span class="last">${c.hit ? `🔎 ${waHit(c.hit)}` : `${c.dir === 'out' ? '↩ ' : ''}${c.sender ? esc(c.sender) + ': ' : ''}${esc((c.text || '').slice(0, 100))}`}</span>${c.dir === 'in' ? '<span class="dot" title="ההודעה האחרונה מהלקוח"></span>' : ''}</div>
        ${c.ticketId || c.isGroup ? `<div class="row3">${c.isGroup ? '<span class="chip grp">👥 קבוצה</span>' : ''}${c.ticketId ? `<span class="chip who">🎫 #${c.ticketId}${c.ticketAssignee ? ' · ' + esc(c.ticketAssignee) : ''}</span>` : ''}</div>` : ''}</div></div>`;
  }).join('');
  el.querySelectorAll('[data-key]').forEach((d) => (d.onclick = () => openWaChat(d.dataset.key)));
}
async function openWaChat(key, count = 60) {
  const c = S.wa.chats.find((x) => x.key === key) || (S.wa.view && S.wa.view.chat.key === key && S.wa.view.chat);
  if (!c) return;
  if (S.wa.sel !== key) S.wa.replyTo = null;
  S.wa.sel = key; S.wa.count = count; renderWaList();
  S.wa.view = { chat: c, items: null };
  renderWaChat();
  try {
    const r = await api('GET', `/api/wa/history?inst=${encodeURIComponent(c.instanceId)}&chat=${encodeURIComponent(c.chatId)}&count=${count}`);
    if (S.wa.sel !== key) return;
    S.wa.view = { chat: { ...c, ...r.chat, name: r.chat.name || c.name }, items: r.items, more: r.more };
  } catch (e) { if (S.wa.sel === key) S.wa.view.error = e.message; }
  renderWaChat();
}
function renderWaChat() {
  if (S.mode !== 'wa') return;
  const el = $('#chat'); if (!el) return;
  const v = S.wa.view;
  if (!v) { el.innerHTML = `<div class="welcome"><h2>💬 וואטסאפ</h2><div>כל הצ׳אטים של מספרי המשרד – בחר צ׳אט מהרשימה.</div>
    <div class="hint">אפשר לקרוא ולכתוב בכל צ׳אט, גם בלי קריאה. אם יש לצ׳אט קריאה פתוחה – ההודעה נרשמת גם בקריאה.</div></div>`; return; }
  const c = v.chat; const title = c.name || localPhone(c.phone) || c.chatId;
  const canOpenTicket = c.ticketId && (S.me.role === 'admin' || c.ticketAssignee === S.me.name);
  el.innerHTML = `<div class="chat-head"><div class="av" style="background:${avColor(c.phone || c.chatId)}">${c.isGroup ? '👥' : esc(initials(title))}</div>
      <div class="who"><b>${esc(title)}${c.phone ? ` <span class="ph big" dir="ltr" data-copy="${esc(localPhone(c.phone))}" title="לחץ להעתקה">${localPhone(c.phone)}</span>` : ''}</b>
      <small>📱 ${esc(c.instanceName || '')}${c.isGroup ? ' · 👥 קבוצה' : ''}${c.ticketId ? ` · 🎫 קריאה #${c.ticketId}${c.ticketAssignee ? ' אצל ' + esc(c.ticketAssignee) : ''}` : ''}</small></div>
      ${canOpenTicket ? `<button id="waTicket">🎫 פתח את הקריאה</button>` : ''}
      <button class="ghost" id="waReload" title="רענון ההודעות">🔄</button></div>
    <div class="msgs" id="waMsgs"></div><div id="waComp"></div>`;
  if ($('#waTicket')) $('#waTicket').onclick = () => openTicket(c.ticketId);
  $('#waReload').onclick = () => openWaChat(S.wa.sel, S.wa.count);
  renderWaMsgs();
  renderWaComposer();
}
function waMsgHtml(x) { const g = S.wa.view && S.wa.view.chat.isGroup; return messageHtml({ ...x, id: x.id || '', idMessage: x.id || '', ...(g ? {} : { senderName: '' }) }); }
function renderWaMsgs() {
  const box = $('#waMsgs'); if (!box) return;
  const v = S.wa.view;
  if (v.error) { box.innerHTML = `<div class="day">⚠️ ${esc(v.error)}</div>`; return; }
  if (!v.items) { box.innerHTML = '<div class="day">טוען הודעות...</div>'; return; }
  box.innerHTML = v.more ? '<div class="day" style="cursor:pointer" id="waMore">⬆ טען הודעות קודמות</div>' : '';
  let lastDay = '';
  for (const x of v.items) {
    const day = new Date(x.ts).toLocaleDateString('he-IL');
    if (day !== lastDay) { box.insertAdjacentHTML('beforeend', `<div class="day">${day}</div>`); lastDay = day; }
    box.insertAdjacentHTML('beforeend', waMsgHtml(x));
  }
  if (!v.items.length) box.insertAdjacentHTML('beforeend', '<div class="day">אין הודעות</div>');
  if ($('#waMore')) $('#waMore').onclick = () => openWaChat(S.wa.sel, S.wa.count + 100);
  box.scrollTop = box.scrollHeight;
}
function renderWaComposer() {
  const c = $('#waComp'); if (!c) return;
  c.innerHTML = `<div class="replybar" id="waReplybar" style="display:none"><div class="rb-body"><b id="waRbFrom"></b><span id="waRbText"></span></div><button class="ghost" id="waRbX" title="ביטול">✕</button></div>
    <div class="composer"><button id="waTpl" title="תבנית הודעה">📝</button><button id="waBold" title="הדגשה (בוואטסאפ: *טקסט*)"><b>B</b></button><button id="waAttach" title="שליחת קובץ / תמונה">📎</button><input type="file" id="waFile" hidden>
    <textarea id="waTxt" placeholder="כתוב הודעה... (Enter לשליחה, Shift+Enter לשורה חדשה)"></textarea><button class="primary" id="waSend" title="שלח">➤</button></div>`;
  const txt = $('#waTxt');
  const wdk = 'w:' + (S.wa.view && S.wa.view.chat ? S.wa.view.chat.key : '');
  const wgrow = () => { txt.style.height = 'auto'; txt.style.height = Math.min(160, txt.scrollHeight) + 'px'; };
  txt.oninput = () => { wgrow(); markTyping(); draftSet(wdk, txt.value); };
  txt.value = draftGet(wdk); if (txt.value) requestAnimationFrame(wgrow);
  txt.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); waSendText(); } };
  $('#waSend').onclick = waSendText;
  $('#waBold').onclick = () => waWrap(txt, '*');
  { const v = S.wa.view && S.wa.view.chat; if (v && v.isGroup) attachMentions(txt, () => api('GET', `/api/wa/members?inst=${encodeURIComponent(v.instanceId)}&chat=${encodeURIComponent(v.chatId)}`)); }
  $('#waAttach').onclick = () => $('#waFile').click();
  $('#waFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) waSendFile(f); };
  txt.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])][0]; if (f) { e.preventDefault(); waSendFile(f); } });
  $('#waTpl').onclick = () => templatePicker((text) => { const v = S.wa.view && S.wa.view.chat; txt.value = fillTemplate(text, { name: v && v.name ? v.name.split(' · ')[0] : '' }); txt.dispatchEvent(new Event('input')); txt.focus(); });
  $('#waRbX').onclick = () => waSetReply(null);
  waSetReply(S.wa.replyTo);
  txt.focus({ preventScroll: true });
}
function waSetReply(x) {
  S.wa.replyTo = x;
  const bar = $('#waReplybar'); if (!bar) return;
  if (!x) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  $('#waRbFrom').textContent = x.dir === 'in' ? (x.senderName || (S.wa.view && S.wa.view.chat.name) || 'לקוח') : (x.byName || 'אנחנו');
  $('#waRbText').textContent = x.text || waPreview[x.type] || '';
  $('#waTxt') && $('#waTxt').focus({ preventScroll: true });
}
document.addEventListener('click', (e) => {
  if (S.mode !== 'wa' || !S.wa.view || !S.wa.view.items) return;
  const b = e.target.closest('#waMsgs .rep'); if (!b) return;
  const x = S.wa.view.items.find((i) => i.id === b.dataset.rep);
  if (x) waSetReply(x);
});
async function waSendText() {
  const txt = $('#waTxt'); const text = txt.value.trim();
  const v = S.wa.view; if (!text || !v) return;
  const q = S.wa.replyTo;
  txt.value = ''; txt.style.height = '42px'; waSetReply(null); draftSet('w:' + v.chat.key, '');
  try {
    const item = await api('POST', '/api/wa/send', { inst: v.chat.instanceId, chat: v.chat.chatId, text,
      ...(q ? { quotedId: q.id, quotedText: q.text || waPreview[q.type] || '', quotedFrom: q.dir === 'in' ? (q.senderName || v.chat.name || '') : (q.byName || 'אנחנו') } : {}) });
    waAddItem(v.chat.key, item);
  } catch (e) { toast(e.message, true, 6000); if ($('#waTxt') && !$('#waTxt').value) $('#waTxt').value = text; draftSet('w:' + v.chat.key, text); }
}
async function waSendFile(file) {
  const v = S.wa.view; if (!v) return;
  const caption = $('#waTxt') ? $('#waTxt').value.trim() : '';
  toast('שולח את ' + file.name + '...');
  try {
    const item = await api('POST', `/api/wa/upload?inst=${encodeURIComponent(v.chat.instanceId)}&chat=${encodeURIComponent(v.chat.chatId)}`, file, {
      'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Caption': encodeURIComponent(caption) });
    if ($('#waTxt')) $('#waTxt').value = '';
    draftSet('w:' + v.chat.key, '');
    waAddItem(v.chat.key, item); toast('נשלח ✓');
  } catch (e) { toast(e.message, true, 6000); }
}
function waAddItem(key, item) {
  const v = S.wa.view;
  if (!v || v.chat.key !== key || !v.items) return;
  if (item.id && v.items.some((x) => x.id === item.id)) return;
  v.items.push(item);
  const box = $('#waMsgs'); if (!box) return;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 150;
  box.insertAdjacentHTML('beforeend', waMsgHtml(item));
  if (near || item.dir === 'out') box.scrollTop = box.scrollHeight;
}
function waOnEvent(ev) {
  const c = ev.chat; if (!c) return;
  if (c.instanceId === S.wa.inst) {
    const i = S.wa.chats.findIndex((x) => x.key === c.key);
    if (i >= 0) S.wa.chats.splice(i, 1);
    if (!S.wa.q || i >= 0) S.wa.chats.unshift(c);
    if (S.mode === 'wa') renderWaList();
  }
  if (S.mode === 'wa' && S.wa.view && S.wa.view.chat.key === c.key) {
    S.wa.view.chat = { ...S.wa.view.chat, ...c, name: c.name || S.wa.view.chat.name };
    if (ev.message) waAddItem(c.key, ev.message);
  }
}

// 🗑 מחיקת הודעה שנשלחה בטעות – אצל כולם
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.msg .del'); if (!b) return;
  if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = '⚠️'; b.title = 'לחץ שוב כדי למחוק אצל כולם'; b.classList.add('sure'); setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = '🗑'; b.classList.remove('sure'); } }, 4000); toast('לחץ שוב על ⚠️ כדי למחוק את ההודעה אצל הלקוח'); return; }
  b.disabled = true;
  try {
    if (S.mode === 'wa' && b.closest('#waMsgs')) {
      const v = S.wa.view; const x = v && v.items.find((i) => i.id === b.dataset.del); if (!x) return;
      await api('POST', '/api/wa/delete', { inst: v.chat.instanceId, chat: v.chat.chatId, id: x.id, ts: x.ts });
    } else if (S.view) {
      await api('POST', `/api/tickets/${S.view.ticket.id}/messages/${b.dataset.del}/delete`);
    }
    toast('🗑 ההודעה נמחקה אצל הלקוח');
  } catch (er) { toast(er.message, true, 6000); b.disabled = false; }
});


// =====================================================================
// 📞 "מי מתקשר" – חלון קופץ כשהמרכזייה מדווחת על שיחה נכנסת
// =====================================================================
const calls = new Map(); // phone -> element
function showCall(c, quiet) {
  let wrap = $('#calls');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'calls'; document.body.appendChild(wrap); }
  if (calls.has(c.phone)) { clearTimeout(calls.get(c.phone)._t); calls.get(c.phone).remove(); }
  const el = document.createElement('div');
  el.className = 'callpop';
  const title = c.name || localPhone(c.phone);
  const mine = (o) => S.me.role === 'admin' || o.assigneeId === S.me.id;
  el.innerHTML = `<div class="cp-head"><span class="cp-ring">📞</span><div class="cp-who"><small>שיחה נכנסת${c.to ? ' · קו ' + esc(c.to) : ''}</small>
      <b>${esc(title)}</b>${c.company ? `<span>🏢 ${esc(c.company)}</span>` : ''}${c.name ? `<span class="sph" dir="ltr" data-copy="${esc(localPhone(c.phone))}" title="לחץ להעתקה">${esc(localPhone(c.phone))}</span>` : ''}</div>
      <button class="ghost cp-x" title="סגור">✕</button></div>
    ${!c.known ? '<div class="cp-line">🆕 לקוח לא מוכר – אין קריאות קודמות</div>' : ''}
    ${c.open.map((o) => `<div class="cp-line">🎫 קריאה פתוחה #${o.id}${o.assignee ? ' אצל ' + esc(o.assignee) : ''}${o.last ? ` – <i>${esc(o.last.slice(0, 60))}</i>` : ''} ${mine(o) ? `<a data-open="${o.id}">פתח</a>` : ''}</div>`).join('')}
    ${c.lastDone ? `<div class="cp-line">✅ טיפול אחרון${c.lastDone.at ? ' (' + new Date(c.lastDone.at).toLocaleDateString('he-IL') + (c.lastDone.by ? ', ' + esc(c.lastDone.by) : '') + ')' : ''}: ${esc(c.lastDone.text.slice(0, 120))}</div>` : ''}
    ${c.ticketsCount ? `<div class="cp-line muted">סה״כ ${c.ticketsCount} קריאות בעבר</div>` : ''}
    <div class="row cp-act">${!c.name && !c.company ? '<button data-act="save">👤 שמור איש קשר</button>' : ''}${S.me.waAccess ? '<button data-act="wa">💬 וואטסאפ</button>' : ''}<button data-act="new">✉️ שלח הודעה</button>${S.me.role === 'admin' ? '<button class="ghost" data-act="mute" title="שיחות מהמספר הזה לא יקפיצו יותר חלון">📵 לא להקפיץ</button>' : ''}</div>`;
  wrap.prepend(el);
  calls.set(c.phone, el);
  el._c = c;
  if (c.wa) callWaInfo(c.phone, c.wa);
  el.querySelector('.cp-x').onclick = () => { el.remove(); calls.delete(c.phone); };
  el.querySelectorAll('[data-open]').forEach((a) => (a.onclick = () => openTicket(a.dataset.open)));
  el.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
    if (b.dataset.act === 'mute') {
      if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = '⚠️ בטוח? לחץ שוב'; return; }
      try { await api('POST', '/api/admin/pbx-ignore', { add: c.phone }); el.remove(); calls.delete(c.phone); toast('📵 שיחות מ-' + localPhone(c.phone) + ' לא יקפיצו יותר חלון (ביטול: ניהול ← 📞 מרכזייה)', false, 6000); }
      catch (er) { toast(er.message, true); }
      return;
    }
    if (b.dataset.act === 'save') {
      const w = el._c.wa || {};
      openModal(`<h3>👤 שמירת איש קשר</h3>
        <div class="grid2"><div><label>שם</label><input id="kn" value="${esc(c.name || (!w.business ? w.name || '' : ''))}"></div><div><label>חברה</label><input id="kc" value="${esc(c.company || (w.business ? w.name || '' : ''))}"></div></div>
        ${w.name ? `<div class="hint">📱 מולא לפי הפרופיל בוואטסאפ – אפשר לתקן</div>` : ''}
        <label>טלפונים (מופרדים בפסיק)</label><input id="kp" dir="ltr" value="${esc(localPhone(c.phone))}">
        <div class="hint">השם והחברה יופיעו במוקד אצל כל העובדים – גם בשיחה הבאה מהמספר הזה.</div>
        <div class="row"><button class="primary" id="ksave">💾 שמור</button><button id="cancel">ביטול</button></div>`);
      $('#cancel').onclick = closeModal; $('#kn').focus();
      $('#ksave').onclick = async () => {
        try {
          const name = $('#kn').value.trim(), company = $('#kc').value.trim();
          await api('POST', '/api/contacts', { name, company, phones: $('#kp').value });
          closeModal(); toast('איש הקשר נשמר ✓');
          if (el.isConnected) showCall({ ...c, name: name || company, company, known: true, wa: null }, true);
        } catch (e) { toast(e.message, true); }
      };
      return;
    }
    if (b.dataset.act === 'new') { newChatDialog(); setTimeout(() => { const ph = document.querySelector('#box input[dir=ltr]'); if (ph && !ph.value) ph.value = localPhone(c.phone).replace(/-/g, ''); }, 50); return; }
    if (S.mode !== 'wa') enterWa();
    S.wa.q = c.phone.slice(3); if ($('#waQ')) $('#waQ').value = '0' + S.wa.q; await loadWaChats();
    const hit = S.wa.chats.find((x) => x.phone === c.phone); if (hit) openWaChat(hit.key);
  }));
  clearTimeout(el._t); el._t = setTimeout(() => { el.remove(); if (calls.get(c.phone) === el) calls.delete(c.phone); }, 3 * 60000);
  if (quiet) return;
  Sounds.newMessage();
  notify('📞 ' + title, (c.company ? c.company + ' · ' : '') + localPhone(c.phone));
}
function endCall(ev) {
  const el = calls.get(ev.phone); if (!el) return;
  el.classList.add('ended');
  const h = el.querySelector('.cp-who small'); if (h) h.textContent = ev.answered ? '✅ השיחה נענתה' : '📴 השיחה הסתיימה';
  clearTimeout(el._t); el._t = setTimeout(() => { el.remove(); calls.delete(ev.phone); }, 45000);
}

function adminPbx() {
  const url = `${location.protocol}//${location.hostname}:${location.port || 80}/api/pbx/webhook?key=${A.config.pbxKey}`;
  $('#apane').innerHTML = `<h4>📞 חלון "מי מתקשר"</h4>
    <div class="hint">כשהמרכזייה שולחת הודעה (webhook) על שיחה נכנסת – קופץ חלון עם שם הלקוח, החברה, קריאות פתוחות והטיפול האחרון.<br>
    את השיחה מקבל העובד שהשלוחה/הקו שלו רשומים אצלו (👥 עובדים ← עריכה ← "שלוחה / קו"). אם לא רשום לאף אחד – כולם מקבלים.</div>
    <h4>🔌 חיבור ישיר למרכזייה (מומלץ)</h4>
    <label>סוג המרכזייה</label>
    <select id="xType"><option value="015">015 (015pbx.net)</option><option value="fusion" ${A.config.pbx.type === 'fusion' ? 'selected' : ''}>FusionPBX / FreeSWITCH</option></select>
    <div id="x015">
      <div class="hint">השרת בודק במרכזייה כל 2 שניות אם יש שיחה נכנסת. משתמש וסיסמה של המרכזייה (כמו בתוסף של כרום). נשמרים רק בשרת.</div>
      <div class="grid2"><div><label>שם משתמש במרכזייה</label><input id="xUser" dir="ltr" value="${esc(A.config.pbx.user)}"></div>
        <div><label>סיסמה</label><input id="xPass" type="password" dir="ltr" placeholder="${A.config.pbx.pass ? '•••• (שמורה)' : ''}"></div></div>
    </div>
    <div id="xFusion">
      <div class="hint">חיבור ל-Event Socket של FreeSWITCH: חלון "מי מתקשר" ברגע שהשלוחה מצלצלת, וחיוג בלחיצה (השלוחה עונה לבד ומחייגת).
        הגדרות ב-FusionPBX: Advanced ← Settings / קובץ event_socket.conf.xml (כתובת, פורט 8021, סיסמה).</div>
      <div class="grid2"><div><label>כתובת שרת ה-FusionPBX</label><input id="xEHost" dir="ltr" placeholder="127.0.0.1 אם על אותו שרת" value="${esc(A.config.pbx.eslHost)}"></div>
        <div><label>פורט Event Socket</label><input id="xEPort" dir="ltr" value="${esc(A.config.pbx.eslPort || 8021)}"></div>
        <div><label>סיסמת Event Socket</label><input id="xEPass" type="password" dir="ltr" placeholder="${A.config.pbx.eslPass ? '•••• (שמורה)' : 'ClueCon'}"></div>
        <div><label>הדומיין (Domain) של המשרד ב-FusionPBX</label><input id="xDomain" dir="ltr" placeholder="pbx.example.co.il" value="${esc(A.config.pbx.domain)}"></div></div>
      <div class="hint">לכל עובד רושמים את מספר השלוחה שלו (👥 עובדים ← עריכה ← "שלוחה / קו") – החלון קופץ למי שהשלוחה שלו מצלצלת, והחיוג יוצא מהשלוחה שלו.</div>
    </div>
    <label class="check"><input type="checkbox" id="xOn" ${A.config.pbx.enabled ? 'checked' : ''}> פעיל – להקפיץ חלון בכל שיחה נכנסת</label>
    <div class="row"><button class="primary" id="xSave">💾 שמור והתחבר</button><span id="xStat" class="hint" style="flex:1">${esc(A.config.pbxStatus ? A.config.pbxStatus.text : '')}</span></div>
    <h4>📵 מספרים שלא יקפיצו חלון</h4>
    <div class="hint">מספר בכל שורה (טלפון של מתקשר, או קו/מספר שמחייגים אליו). שיחות מהם/אליהם לא יקפיצו חלון. נשמר רק בשרת.</div>
    <textarea id="xIgn" dir="ltr" rows="4" placeholder="0521234567">${esc((A.config.pbxIgnore || []).map((p) => (p.startsWith('972') ? '0' + p.slice(3) : p)).join('\n'))}</textarea>
    <div class="row"><button id="xIgnSave">💾 שמור רשימה</button></div>
    <h4>🌐 או: Webhook מהמרכזייה</h4>
    <label>כתובת ה-Webhook להדבקה במרכזייה</label>
    <div class="row"><input id="pUrl" dir="ltr" readonly value="${esc(url)}" style="flex:1;margin:0"><button id="pCopy">📋 העתק</button><button class="ghost" id="pNew" title="מפתח חדש – הכתובת הישנה תפסיק לעבוד">🔑 מפתח חדש</button></div>
    <div class="hint">⚠️ המרכזייה של 015 נמצאת באינטרנט, ולכן היא צריכה להגיע לשרת מבחוץ: במקום <b dir="ltr">${esc(location.hostname)}</b> צריך את הכתובת החיצונית של המשרד (IP קבוע / דומיין),
    ובראוטר להפנות את הפורט ${esc(location.port || '80')} לשרת. אפשר לבקש מאיש המחשוב. שיטות: POST (JSON או טופס) או GET – הכל עובד.</div>
    <div class="row"><input id="pTest" dir="ltr" placeholder="מספר לבדיקה (למשל לקוח קיים)" style="flex:1;margin:0"><button id="pTestBtn">🧪 הקפץ חלון בדיקה</button></div>
    <h4>📥 מה התקבל מהמרכזייה לאחרונה</h4><div id="pLog" class="hint">טוען...</div>`;
  const syncType = () => { const f = $('#xType').value === 'fusion'; $('#x015').style.display = f ? 'none' : ''; $('#xFusion').style.display = f ? '' : 'none'; };
  $('#xType').onchange = syncType; syncType();
  $('#xSave').onclick = async () => {
    $('#xStat').textContent = 'מתחבר...';
    try { const r = await api('POST', '/api/admin/pbx', { type: $('#xType').value, enabled: $('#xOn').checked, user: $('#xUser').value, pass: $('#xPass').value || A.config.pbx.pass, host: A.config.pbx.host,
        eslHost: $('#xEHost').value, eslPort: $('#xEPort').value, eslPass: $('#xEPass').value || A.config.pbx.eslPass, domain: $('#xDomain').value });
      $('#xStat').textContent = (r.state === 'error' ? '⚠️ ' : '') + r.text; A = await api('GET', '/api/admin/config'); setTimeout(() => api('GET', '/api/admin/pbx-log').then(drawLog), 2500); }
    catch (e) { $('#xStat').textContent = e.message; }
  };
  $('#xIgnSave').onclick = async () => { try { const r = await api('POST', '/api/admin/pbx-ignore', { list: $('#xIgn').value }); A.config.pbxIgnore = r.list; toast(`נשמר ✓ (${r.list.length} מספרים)`); } catch (e) { toast(e.message, true); } };
  $('#pCopy').onclick = () => copyText($('#pUrl').value).then((ok) => toast(ok ? 'הכתובת הועתקה ✓' : 'לא הצלחתי להעתיק', !ok));
  $('#pNew').onclick = async () => { try { const r = await api('POST', '/api/admin/pbx-key'); A.config.pbxKey = r.key; adminPbx(); toast('נוצר מפתח חדש – עדכן את הכתובת במרכזייה'); } catch (e) { toast(e.message, true); } };
  $('#pTestBtn').onclick = async () => { try { await api('POST', '/api/admin/pbx-test', { phone: $('#pTest').value }); closeModal(); } catch (e) { toast(e.message, true); } };
  const drawLog = (list) => {
    if (!$('#pLog')) return;
    $('#pLog').innerHTML = list.length ? list.map((x) => `<div class="card2" style="margin:6px 0;font-size:12px"><b>${new Date(x.at).toLocaleString('he-IL')}</b>${x.ip ? ` <span class="chip" dir="ltr" title="הכתובת שממנה הגיעה ההודעה">${esc(x.ip)}</span>` : x.source === '015' ? ' <span class="chip">015 (חיבור ישיר)</span>' : ''} –
      מתקשר: <b dir="ltr">${esc(x.parsed.from || '?')}</b> · קו: <b dir="ltr">${esc(x.parsed.to || '?')}</b> · אירוע: <b>${esc(x.parsed.event || '?')}</b>
      <pre dir="ltr" style="white-space:pre-wrap;margin:4px 0 0">${esc(JSON.stringify(x.fields, null, 1)).slice(0, 1500)}</pre></div>`).join('') : 'עוד לא התקבל כלום מהמרכזייה.';
  };
  api('GET', '/api/admin/pbx-log').then(drawLog).catch((e) => { $('#pLog').textContent = e.message; });
}

// 📞 חיוג דרך המרכזייה (015): הטלפון של העובד מצלצל, וכשהוא עונה – מחובר ללקוח
async function dialPhone(phone, name) {
  const p = String(phone || '').replace(/[^\d+]/g, '');
  if (!p) return;
  toast(`📞 מחייג ל${name ? name + ' ' : ''}${p}... הטלפון שלך יצלצל – הרם`, false, 6000);
  try { await api('POST', '/api/dial', { phone: p, name: name || '' }); }
  catch (e) { toast(e.message, true, 8000); }
}

// 🤖 לחיצה על אפשרות בהודעה של בוט: שולחים את האפשרות כתשובה (מצוטטת), פותחים קישור, או מחייגים
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.msg .opt'); if (!b || b.disabled) return;
  const box = b.closest('.msg'); const mid = box && box.dataset.mid;
  const inWa = S.mode === 'wa' && b.closest('#waMsgs');
  const m = inWa ? S.wa.view && S.wa.view.items.find((x) => x.id === mid) : S.view && S.view.messages.find((x) => x.id === mid);
  const o = m && m.options && m.options[+b.dataset.opt]; if (!o) return;
  if (o.kind === 'url') { window.open(o.value, '_blank'); return; }
  if (o.kind === 'call') { dialPhone(o.value); return; }
  b.disabled = true;
  try {
    if (inWa) {
      const v = S.wa.view;
      const item = await api('POST', '/api/wa/send', { inst: v.chat.instanceId, chat: v.chat.chatId, text: o.value, quotedId: m.id, quotedText: (m.text || '').slice(0, 200), quotedFrom: m.senderName || v.chat.name || '' });
      waAddItem(v.chat.key, item);
    } else {
      if (S.view.ticket.status === 'closed') throw new Error('הקריאה סגורה – פתח אותה מחדש כדי לענות');
      await api('POST', `/api/tickets/${S.view.ticket.id}/send`, { text: o.value, replyTo: m.idMessage ? m.id : null });
    }
    toast('👆 נשלח: ' + o.value);
  } catch (er) { toast(er.message, true, 6000); }
  b.disabled = false;
});

// =====================================================================
// 🆕 "מה חדש" – אחרי כל עדכון קופץ פעם אחת לכל עובד, עד שהוא מסמן "קראתי"
// =====================================================================
async function whatsNew(all) {
  let list = [];
  try { list = await (await fetch('changelog.json?v=' + S.version, { cache: 'no-store' })).json(); } catch { return; }
  const seen = S.me.seenVersion || (S.version - 1);
  const show = all ? list : list.filter((e) => e.v > seen && e.v <= S.version);
  if (!show.length) { if (all) toast('אין עדכונים להצגה'); return; }
  if (!all && modal.classList.contains('on')) { setTimeout(() => whatsNew(false), 5000); return; }
  openModal(`<h3>🆕 מה חדש במוקד</h3>
    <div class="news">${show.slice(0, all ? 40 : 15).map((e) => `<div class="news-v"><b>גרסה ${e.v}</b><ul>${e.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}</div>
    <div class="row"><button class="primary" id="newsOk">✔ קראתי, סגור</button></div>`);
  $('#newsOk').onclick = async () => {
    closeModal();
    if (!all) { S.me.seenVersion = S.version; api('POST', '/api/me/seen', { version: S.version }).catch(() => {}); }
  };
}


// =====================================================================
// 💭 צ'אט פנימי בין העובדים – חלונית קטנה בפינה + פופאפ כשמגיעה הודעה
// =====================================================================
S.staff = { open: false, with: null, msgs: [], unread: {} };
const staffTotal = () => Object.values(S.staff.unread || {}).reduce((a, b) => a + b, 0);
const userName = (id) => (S.users.find((u) => u.id === id) || {}).name || 'עובד';
function staffBadge() {
  const n = staffTotal(); const b = $('#staffBadge');
  if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; }
  renderList();
}
function staffPanel() {
  let p = $('#staffPanel');
  if (!p) { p = document.createElement('div'); p.id = 'staffPanel'; document.body.appendChild(p); }
  return p;
}
function staffClose() { S.staff.open = false; S.staff.with = null; const p = $('#staffPanel'); if (p) p.remove(); }
async function staffOpen(withId) {
  S.staff.open = true; S.staff.with = withId || null;
  const p = staffPanel();
  if (!withId) {
    const others = S.users.filter((u) => u.id !== S.me.id);
    p.innerHTML = `<div class="sp-head"><b>💭 צ׳אט צוות</b><span class="spacer"></span><button class="ghost sp-x" title="סגור">✕</button></div>
      <div class="sp-list">${others.map((u) => `<div class="sp-user" data-u="${u.id}"><div class="av" style="background:${avColor(u.id)}">${esc(initials(u.name))}</div>
        <b>${esc(u.name)}</b><span class="spacer"></span>${S.staff.unread[u.id] ? `<span class="badge on">${S.staff.unread[u.id]}</span>` : ''}</div>`).join('') || '<div class="empty">אין עובדים נוספים</div>'}</div>`;
    p.querySelector('.sp-x').onclick = staffClose;
    p.querySelectorAll('[data-u]').forEach((d) => (d.onclick = () => staffOpen(d.dataset.u)));
    return;
  }
  const t = S.view && !S.view.readOnly ? S.view.ticket : null;
  p.innerHTML = `<div class="sp-head"><button class="ghost sp-back" title="חזרה">➜</button><b>💭 ${esc(userName(withId))}</b><span class="spacer"></span><button class="ghost sp-x" title="סגור">✕</button></div>
    <div class="sp-msgs" id="spMsgs"><div class="day">טוען...</div></div>
    ${t ? `<label class="sp-share"><input type="checkbox" id="spShare"> 📎 לצרף את הקריאה הפתוחה #${t.id} (${esc(t.customerName)})</label>` : ''}
    <div class="sp-comp"><textarea id="spTxt" rows="1" placeholder="כתוב ל${esc(userName(withId))}... (Enter לשליחה)"></textarea><button class="primary" id="spSend">➤</button></div>`;
  p.querySelector('.sp-x').onclick = staffClose;
  p.querySelector('.sp-back').onclick = () => staffOpen(null);
  const txt = $('#spTxt');
  txt.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); staffSend(); } };
  $('#spSend').onclick = staffSend;
  txt.focus();
  try { S.staff.msgs = await api('GET', '/api/staff/chat?with=' + encodeURIComponent(withId)); } catch (e) { toast(e.message, true); return; }
  delete S.staff.unread[withId]; staffBadge();
  staffRenderMsgs();
}
function staffMsgHtml(m) {
  const mine = m.from === S.me.id;
  const tk = m.ticketId ? `<a class="sp-tk" data-tk="${esc(m.ticketId)}">🎫 קריאה #${esc(m.ticketId)}${m.ticketName ? ' – ' + esc(m.ticketName) : ''}</a>` : '';
  return `<div class="sp-m ${mine ? 'out' : 'in'}">${waFormat(m.text)}${tk}<div class="meta">${fmtTime(m.ts)}${mine ? ` <span class="ticks ${m.read ? 'read' : ''}">${m.read ? '✓✓' : '✓'}</span>` : ''}</div></div>`;
}
function staffRenderMsgs() {
  const box = $('#spMsgs'); if (!box) return;
  let lastDay = '';
  box.innerHTML = S.staff.msgs.map((m) => { const d = new Date(m.ts).toLocaleDateString('he-IL'); const sep = d !== lastDay ? `<div class="day">${d}</div>` : ''; lastDay = d; return sep + staffMsgHtml(m); }).join('') || '<div class="day">עוד אין הודעות – כתוב משהו 🙂</div>';
  box.querySelectorAll('[data-tk]').forEach((a) => (a.onclick = () => openTicket(a.dataset.tk)));
  box.scrollTop = box.scrollHeight;
}
async function staffSend() {
  const txt = $('#spTxt'); const text = txt.value.trim(); if (!text || !S.staff.with) return;
  const share = $('#spShare') && $('#spShare').checked && S.view ? S.view.ticket.id : null;
  txt.value = '';
  try { await api('POST', '/api/staff/chat', { to: S.staff.with, text, ticketId: share }); if ($('#spShare')) $('#spShare').checked = false; }
  catch (e) { toast(e.message, true); txt.value = text; }
}
function staffOnMessage(m, fromName) {
  const other = m.from === S.me.id ? m.to : m.from;
  if (S.staff.open && S.staff.with === other) {
    if (!S.staff.msgs.some((x) => x.id === m.id)) { S.staff.msgs.push(m); staffRenderMsgs(); }
    if (m.to === S.me.id) api('POST', '/api/staff/read', { with: other }).catch(() => {});
    return;
  }
  if (m.from === S.me.id) return;
  try { console.log('__HD_STAFF__:' + JSON.stringify({ from: fromName || userName(m.from), text: m.text.slice(0, 120) })); } catch {}
  // החלון של השיחה נפתח מעצמו (אם לא באמצע שיחה אחרת בצ'אט הצוות)
  if (!S.staff.open) {
    staffOpen(m.from);
    Sounds.newMessage();
    notify('💭 ' + (fromName || userName(m.from)), m.text.slice(0, 120));
    flashTitle('💭 הודעה מ' + (fromName || userName(m.from)));
    return;
  }
  S.staff.unread[m.from] = (S.staff.unread[m.from] || 0) + 1; staffBadge();
  if (S.staff.open && !S.staff.with) staffOpen(null);
  // פופאפ קטן
  let wrap = $('#staffPops');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'staffPops'; document.body.appendChild(wrap); }
  const old = wrap.querySelector(`[data-from="${m.from}"]`); if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'staffpop'; el.dataset.from = m.from;
  el.innerHTML = `<div class="sp-pop-head"><b>💭 ${esc(fromName || userName(m.from))}</b><span class="spacer"></span><button class="ghost sp-x">✕</button></div>
    <div class="sp-pop-text">${esc(m.text.slice(0, 200))}${m.ticketId ? `<br><small>🎫 קריאה #${esc(m.ticketId)}</small>` : ''}</div>
    <div class="row"><button class="primary sp-reply">↩ השב</button></div>`;
  wrap.prepend(el);
  el.querySelector('.sp-x').onclick = () => el.remove();
  el.querySelector('.sp-reply').onclick = () => { el.remove(); staffOpen(m.from); };
  setTimeout(() => el.remove(), 20000);
  Sounds.newMessage();
  notify('💭 ' + (fromName || userName(m.from)), m.text.slice(0, 120));
}

// 📱 פרטים מוואטסאפ על מספר לא מוכר – נכנסים לחלון השיחה
function callWaInfo(phone, wa) {
  const el = calls.get(phone); if (!el || !wa || !wa.exists) return;
  el._c.wa = wa;
  let line = el.querySelector('.cp-wa');
  if (!line) { line = document.createElement('div'); line.className = 'cp-line cp-wa'; el.querySelector('.cp-head').after(line); }
  line.innerHTML = `${wa.avatar ? `<img src="${esc(wa.avatar)}" alt="" referrerpolicy="no-referrer">` : '<span class="cp-wa-ic">📱</span>'}
    <div><small>בוואטסאפ${wa.business ? ' עסקי' : ''}:</small> <b>${esc(wa.name || 'ללא שם')}</b>${wa.category ? ` · ${esc(wa.category)}` : ''}
    ${wa.description ? `<div class="muted" style="font-size:12px">${esc(wa.description.slice(0, 100))}</div>` : ''}</div>`;
}

// 🔎 בדיקה: למה צ'אט לא נכנס למוקד
document.addEventListener('click', async (e) => {
  if (!e.target.closest('#dgBtn')) return;
  const q = $('#dgQ').value.trim(); if (!q) return;
  $('#dgOut').innerHTML = '<div class="hint">בודק מול Green API...</div>';
  let res; try { res = await api('GET', '/api/admin/diagnose?q=' + encodeURIComponent(q)); } catch (er) { $('#dgOut').innerHTML = `<div class="hint">⚠️ ${esc(er.message)}</div>`; return; }
  const when = (ts) => (ts ? new Date(ts).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  $('#dgOut').innerHTML = res.map((r) => {
    const inst = [];
    if (!r.enabled) inst.push('⚪ המספר כבוי במוקד');
    if (r.state !== 'authorized') inst.push(`🔴 המספר לא מחובר (${esc(r.state)}) – צריך לסרוק QR באתר Green API`);
    if (r.webhookUrl) inst.push(`⚠️ באתר Green API מוגדרת כתובת Webhook (<span dir="ltr">${esc(r.webhookUrl)}</span>) – ההודעות הולכות לשם ולא למוקד. לתיקון: "💾 שמור ובדוק חיבור" במספר הזה למטה`);
    if (r.incomingWebhook && r.incomingWebhook !== 'yes') inst.push('⚠️ קבלת הודעות נכנסות כבויה ב-Green API. לתיקון: "💾 שמור ובדוק חיבור" למטה');
    if (r.settingsError) inst.push('⚠️ לא הצלחתי לקרוא הגדרות מ-Green API: ' + esc(r.settingsError));
    const chats = r.chats.map((c) => {
      const L = [];
      const g = Array.isArray(c.green) ? c.green : [];
      const lastIn = g.find((x) => x.dir === 'in');
      if (c.ignored) L.push('🚫 הצ׳אט <b>חסום</b> – לא נכנס למוקד. ביטול: ניהול ← כללי ← חסומים');
      if (c.ignoredByName) L.push('🔕 קבוצה שמתעלמים ממנה לפי שם (ניהול ← כללי)');
      if (c.staff) L.push(`👤 זה המספר של העובד ${esc(c.staff)} – הודעות ממנו לא פותחות קריאה`);
      if (c.tech) L.push('🛠 זה יעד קריאת שירות (טכנאי) – הודעות ממנו נכנסות כהערה בקריאה, לא כקריאה חדשה');
      if (c.open) L.push(`✅ יש קריאה פתוחה <a data-open="${c.open.id}">#${c.open.id}</a>${c.open.assignee ? ' אצל <b>' + esc(c.open.assignee) + '</b>' : ' (בניתוב)'}${c.open.snoozed ? ' – <b>מושהית</b> (בלשונית "מושהות")' : ''}`);
      else if (c.last) L.push(`📁 הקריאה האחרונה #${c.last.id} סגורה (${when(c.last.closedAt)})`);
      if (lastIn && (!c.seen || lastIn.ts > c.seen.ts + 60000)) L.push(`❌ בוואטסאפ יש הודעה מ-${when(lastIn.ts)} ("${esc(lastIn.text)}") ש<b>לא הגיעה למוקד</b> – בדוק את החיבור של המספר למעלה`);
      else if (c.seen) L.push(`📥 הודעה אחרונה שהמוקד קיבל: ${when(c.seen.ts)} ${c.seen.dir === 'in' ? 'מהלקוח' : 'מאיתנו'} – "${esc(c.seen.text)}"`);
      else if (!g.length) L.push('— אין התכתבות עם המספר הזה במספר הזה');
      if (c.green && c.green.error) L.push('⚠️ לא הצלחתי למשוך היסטוריה: ' + esc(c.green.error));
      return `<div style="margin:6px 0;padding:8px;border-radius:8px;background:var(--bg)"><b>${esc(c.name || c.chatId.split('@')[0])}</b> <span dir="ltr" class="chip">${esc(c.chatId.split('@')[0])}</span><br>${L.join('<br>')}</div>`;
    }).join('');
    return `<div style="margin-top:10px"><b>📱 ${esc(r.instance)}</b> ${r.lastNotif ? `<span class="hint">· הודעה אחרונה מ-Green API: ${when(r.lastNotif.at)}</span>` : '<span class="hint">· עוד לא הגיעו הודעות מאז שהשרת עלה</span>'}
      ${inst.length ? '<div>' + inst.join('<br>') + '</div>' : ''}${chats || '<div class="hint">לא נמצא צ׳אט מתאים במספר הזה</div>'}</div>`;
  }).join('');
  $('#dgOut').querySelectorAll('[data-open]').forEach((a) => (a.onclick = () => { closeModal(); openTicket(a.dataset.open); }));
});

// כותרת הלשונית מהבהבת עד שחוזרים לחלון – כדי שיראו גם כשהדפדפן ברקע
let flashT = null;
function flashTitle(text) {
  if (document.hasFocus()) return;
  clearInterval(flashT);
  const base = document.title; let on = false;
  flashT = setInterval(() => { document.title = (on = !on) ? text : base; }, 1000);
  const stop = () => { clearInterval(flashT); flashT = null; renderList(); window.removeEventListener('focus', stop); };
  window.addEventListener('focus', stop);
}

// 📞 לחיצה כפולה על מספר טלפון בכל מקום במוקד → "לחייג?" → חיוג דרך המרכזייה (FusionPBX / 015)
document.addEventListener('dblclick', (e) => {
  if (!S.me || e.target.closest('input, textarea, [contenteditable]')) return;
  const sel = window.getSelection(); const node = sel && sel.anchorNode; if (!node) return;
  const text = node.textContent || ''; const off = sel.anchorOffset || 0;
  const RE = /(?:\+?972[\s-]?|0)(?:[\s-]?\d){8,9}(?!\d)/g;
  let hit = null, m;
  while ((m = RE.exec(text))) { if (off >= m.index && off <= m.index + m[0].length) { hit = m[0]; break; } }
  if (!hit) return;
  let d = hit.replace(/\D/g, ''); if (d.startsWith('972')) d = '0' + d.slice(3);
  if (d.length < 9) return;
  sel.removeAllRanges();
  if (confirm('📞 לחייג ל-' + d + '?\n(הטלפון בשלוחה שלך יענה לבד ויחייג)')) dialPhone(d);
}, true);


// =====================================================================
// ✍️ עיצוב טקסט כמו בוואטסאפ: *מודגש*  _נטוי_  ~קו חוצה~  ```קוד```  ותיוג @טלפון
// =====================================================================
function waFormat(text) {
  let h = esc(text || '');
  h = h.replace(/```([\s\S]+?)```/g, '<code>$1</code>');
  const B = '(^|[\\s(>"\'\\u05be-])', E = '(?=$|[\\s.,!?:;)<"\'\\u05be-])';
  h = h.replace(new RegExp(B + '\\*([^*\\n]+?)\\*' + E, 'g'), '$1<b>$2</b>');
  h = h.replace(new RegExp(B + '_([^_\\n]+?)_' + E, 'g'), '$1<i>$2</i>');
  h = h.replace(new RegExp(B + '~([^~\\n]+?)~' + E, 'g'), '$1<s>$2</s>');
  h = h.replace(/@(\d{9,15})\b/g, (m0, d) => `<span class="mention" dir="ltr">@${esc(mentionName(d))}</span>`);
  return h;
}
const mentionNames = new Map(); // phone -> name (מהקבוצות שנטענו)
const mentionName = (d) => mentionNames.get(d) || localPhone(d);
// עוטף את הטקסט המסומן (או מוסיף זוג סימנים) – למשל *מודגש*
function waWrap(txt, mark) {
  const a = txt.selectionStart, b = txt.selectionEnd, v = txt.value;
  txt.value = v.slice(0, a) + mark + v.slice(a, b) + mark + v.slice(b);
  txt.focus(); txt.selectionStart = a + 1; txt.selectionEnd = b + 1;
  txt.dispatchEvent(new Event('input'));
}
// @ בקבוצה → רשימת המשתתפים לבחירה; נכנס כ-@972... (כמו שוואטסאפ שולח תיוג)
function attachMentions(txt, load) {
  let list = null, box = null;
  const close = () => { if (box) { box.remove(); box = null; } };
  const show = async () => {
    const pos = txt.selectionStart, before = txt.value.slice(0, pos);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!m) return close();
    if (!list) { try { list = await load(); list.forEach((x) => x.name && mentionNames.set(x.phone, x.name)); } catch { list = []; } }
    const q = m[2].toLowerCase();
    const items = list.filter((x) => !q || (x.name || '').toLowerCase().includes(q) || x.phone.includes(q.replace(/^0/, ''))).slice(0, 8);
    if (!items.length) return close();
    if (!box) { box = document.createElement('div'); box.className = 'mentions'; txt.parentElement.style.position = 'relative'; txt.parentElement.appendChild(box); }
    box.innerHTML = items.map((x) => `<div data-p="${x.phone}"><b>${esc(x.name || localPhone(x.phone))}</b>${x.name ? ` <small dir="ltr">${esc(localPhone(x.phone))}</small>` : ''}</div>`).join('');
    box.querySelectorAll('[data-p]').forEach((d) => (d.onmousedown = (e) => {
      e.preventDefault();
      const p = d.dataset.p; const start = pos - m[2].length - 1;
      txt.value = txt.value.slice(0, start) + '@' + p + ' ' + txt.value.slice(pos);
      const c = start + p.length + 2; txt.selectionStart = txt.selectionEnd = c; txt.focus(); close();
      txt.dispatchEvent(new Event('input'));
    }));
  };
  txt.addEventListener('input', show);
  txt.addEventListener('blur', () => setTimeout(close, 150));
}


// =====================================================================
// 📣 הפצה – וואטסאפ לכל לקוחות המוצר (מה-CRM) או לרשימת מספרים
// =====================================================================
const BC = { mode: 'seg', seg: '', exclude: new Set(), text: '', optOut: true, delay: 3, inst: '', numbers: '', groups: null, gOff: new Set(), file: null };
async function broadcastDialog(refresh) {
  openModal(`<h3>📣 הפצת וואטסאפ</h3><div id="bLoad" class="hint">טוען נתונים מה-CRM...</div>`, true);
  let d; try { d = await api('GET', '/api/admin/broadcast/segments' + (refresh ? '?refresh=1' : '')); } catch (e) { $('#bLoad').textContent = e.message; return; }
  S.bjob = d.job;
  const insts = S.instances.filter((i) => i.enabled !== false);
  if (!BC.inst && insts[0]) BC.inst = insts[0].id;
  const when = d.at ? new Date(d.at).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  box.innerHTML = `<h3>📣 הפצת וואטסאפ</h3>
    <details class="card2" ${d.connected ? '' : 'open'} style="margin-bottom:10px"><summary><b>🔗 חיבור ל-CRM (SmartSale)</b> ${d.connected ? `<span class="chip">מחובר · ${d.total} לקוחות פעילים${when ? ' · עודכן ' + when : ''}</span>` : '<span class="chip">לא מחובר</span>'}</summary>
      <div class="hint">מדביקים את <b>מפתח ה-API</b> של SmartSale (ב-SmartSale: חיבור למערכות חיצוניות ← מפתח API). נשמר רק בשרת.</div>
      <div class="row"><input id="bKey" dir="ltr" placeholder="${d.apiKey ? esc(d.apiKey) + ' (שמור)' : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}" style="flex:1;margin:0"><button class="primary" id="bUrlSave">💾 שמור ובדוק</button></div>
      <details style="margin-top:6px"><summary class="hint" style="cursor:pointer">או: כתובת חיבור MCP (מתקדם)</summary><input id="bUrl" dir="ltr" placeholder="${d.mcpUrl ? esc(d.mcpUrl) + ' (שמור)' : 'https://...?token=...'}"></details>
      ${d.debug ? `<div class="hint" style="color:var(--yellow)">ℹ️ ${esc(d.debug)}</div>` : ''}
      <label>חתימה בסוף ההודעות</label><input id="bSig" value="${esc(d.broadcastSig)}" placeholder="KC Group">
      ${d.error ? `<div class="hint" style="color:var(--red)">⚠️ ${esc(d.error)}</div>` : ''}</details>
    <div class="seg" id="bMode" style="margin-bottom:8px"><button data-m="seg" class="${BC.mode === 'seg' ? 'on' : ''}">🏷️ לפי מוצר (לקוחות פעילים)</button><button data-m="nums" class="${BC.mode === 'nums' ? 'on' : ''}">📋 רשימת מספרים</button><button data-m="groups" class="${BC.mode === 'groups' ? 'on' : ''}">👥 קבוצות</button></div>
    <div id="bGrpBox" style="${BC.mode === 'groups' ? '' : 'display:none'}">
      <div class="row" style="margin-top:0"><span class="hint">מספר הבוט (רק הקבוצות שהוא חבר בהן):</span><input id="bBot" dir="ltr" style="width:150px;margin:0" placeholder="05XXXXXXXX"><button id="bBotSave" class="ghost">💾</button></div>
      <div class="card2" style="margin:6px 0;padding:8px"><b>🚀 הכי פשוט:</b> כתוב הודעה / צרף תמונה למטה ולחץ <b>"🚀 שלח ברקע לכל הקבוצות של הבוט"</b>. השרת ימצא לבד את כל הקבוצות וישלח – אפשר לסגור את החלון.
        <div class="hint">או: בחר קבוצות ידנית מהרשימה ולחץ "שלח".</div></div>
      <label class="check" style="margin:6px 0"><input type="checkbox" id="bGAll"> <b>כל הקבוצות</b> <span class="chip" id="bGCnt"></span></label>
      <div id="bGList" style="max-height:200px;overflow-y:auto"><div class="hint">בודק את כל הקבוצות (עד דקה)...</div></div>
    </div>
    <div id="bSegBox" style="${BC.mode === 'seg' ? '' : 'display:none'}">
      <div class="pick" id="bSegs">${d.segments.map((g) => `<button data-k="${g.k}" class="${BC.seg === g.k ? 'on' : ''}">${esc(g.label)} <span class="chip">${g.count}</span></button>`).join('')}</div>
      <div class="hint">${d.connected ? `<a id="bRefresh" style="cursor:pointer">🔄 משוך מחדש מה-CRM</a>` : ''}${d.unknownPbx ? ` · ⚠️ ${d.unknownPbx} לקוחות מרכזייה בלי "סוג מרכזיה" ב-CRM – לא ייכללו ב-015/פיוזן` : ''}${d.noService ? ` · ${d.noService} לקוחות פעילים בלי "סוג שירות" ב-CRM` : ''}${d.optOutCount ? ` · ${d.optOutCount} ביקשו הסרה – לא יקבלו` : ''}</div>
      <div id="bList" style="max-height:200px;overflow-y:auto;margin-top:6px"></div>
    </div>
    <div id="bNumBox" style="${BC.mode === 'nums' ? '' : 'display:none'}">
      <label>מדביקים מספרים (בכל שורה, או מופרדים בפסיק/רווח)</label><textarea id="bNums" rows="4" dir="ltr" placeholder="0521234567, 0547654321">${esc(BC.numbers)}</textarea>
      <div class="hint" id="bNumCnt"></div>
    </div>
    <div class="row" style="margin-top:8px"><button id="bFileBtn">📎 צרף תמונה / קובץ</button><input type="file" id="bFile" hidden><span id="bFileName" class="hint">${BC.file ? '📎 ' + esc(BC.file.name) + ' <a id="bFileX" style="cursor:pointer">✕</a>' : ''}</span></div>
    <label>נוסח ההודעה <span class="hint">(אפשר {name} לשם הפרטי; פתיח, ברכה וחתימה מתווספים ומשתנים אוטומטית – אין שתי הודעות זהות)</span></label>
    <textarea id="bText" rows="5" placeholder="רצינו לעדכן ש...">${esc(BC.text)}</textarea>
    <div class="row" style="align-items:center">
      <label class="check" style="margin:0"><input type="checkbox" id="bOpt" ${BC.optOut ? 'checked' : ''}> שורת "להסרה השיבו הסר"</label>
      <span class="spacer" style="flex:1"></span>
      <span class="hint">מ:</span><select id="bInst" style="width:auto">${insts.map((i) => `<option value="${i.id}" ${i.id === BC.inst ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select>
      <span class="hint">הפסקה:</span><select id="bDelay" style="width:auto">${[3, 5, 8, 15, 30].map((x) => `<option value="${x}" ${x === BC.delay ? 'selected' : ''}>${x} שנ׳</option>`).join('')}</select>
    </div>
    <div class="row"><button id="bSample">👁 דוגמאות</button><button class="primary" id="bSend">📤 שלח</button><span class="spacer" style="flex:1"></span><button id="cancel">סגור</button></div>
    <div id="bSamples"></div><div id="bProg"></div>`;
  $('#cancel').onclick = closeModal;
  const keep = () => { BC.text = $('#bText').value; BC.optOut = $('#bOpt').checked; BC.inst = $('#bInst').value; BC.delay = Number($('#bDelay').value); if ($('#bNums')) BC.numbers = $('#bNums').value; };
  ['#bText', '#bOpt', '#bInst', '#bDelay'].forEach((q) => ($(q).oninput = $(q).onchange = keep));
  box.querySelectorAll('#bMode button').forEach((b) => (b.onclick = () => { keep(); BC.mode = b.dataset.m; broadcastDialog(); }));
  $('#bUrlSave').onclick = async () => {
    $('#bUrlSave').disabled = true; $('#bUrlSave').textContent = 'בודק...';
    const key = $('#bKey').value.trim(), url = $('#bUrl').value.trim();
    const r = await api('POST', '/api/admin/crm', { apiKey: key || (url ? '' : d.apiKey), mcpUrl: url || (key ? '' : d.mcpUrl), broadcastSig: $('#bSig').value }).catch((e) => ({ ok: false, error: e.message }));
    toast(r.ok ? `✓ מחובר – ${r.count} לקוחות פעילים` : '⚠️ ' + r.error, !r.ok, 7000); keep(); broadcastDialog();
  };
  $('#bSig').onchange = () => api('POST', '/api/admin/crm', { mcpUrl: d.mcpUrl, apiKey: d.apiKey, broadcastSig: $('#bSig').value }).catch(() => {});
  if ($('#bRefresh')) $('#bRefresh').onclick = () => { keep(); broadcastDialog(true); };
  const countNums = () => {
    const out = new Set(); let buf = '';
    const need = (d) => (/^972[57]/.test(d) ? 12 : /^972/.test(d) ? 11 : /^0[57]/.test(d) ? 10 : 9);
    for (const t of $('#bNums').value.split(/[\s,;]+/)) { const d = t.replace(/\D/g, ''); if (!d) continue; buf += d; if (buf.length >= need(buf)) { out.add(buf.replace(/^972/, '0')); buf = ''; } }
    $('#bNumCnt').textContent = out.size ? `${out.size} מספרים` : '';
  };
  if ($('#bNums')) { $('#bNums').oninput = () => { keep(); countNums(); }; countNums(); }
  const drawList = async () => {
    if (!BC.seg) { $('#bList').innerHTML = '<div class="hint">בחר מוצר כדי לראות למי תישלח ההודעה</div>'; return; }
    const list = await api('GET', '/api/admin/broadcast/preview?segment=' + BC.seg).catch(() => []);
    const ok = list.filter((r) => !r.optedOut);
    $('#bList').innerHTML = `<div class="hint">${ok.length - [...BC.exclude].filter((p) => ok.some((r) => r.phone === p)).length} נמענים (בטל סימון כדי לא לשלוח):</div>` + ok.map((r) => `<label class="check" style="margin:2px 0"><input type="checkbox" data-p="${r.phone}" ${BC.exclude.has(r.phone) ? '' : 'checked'}> ${esc(r.name || r.company || '')} <span dir="ltr" class="chip">${esc(localPhone(r.phone))}</span></label>`).join('');
    $('#bList').querySelectorAll('[data-p]').forEach((c) => (c.onchange = () => { if (c.checked) BC.exclude.delete(c.dataset.p); else BC.exclude.add(c.dataset.p); }));
  };
  box.querySelectorAll('#bSegs button').forEach((b) => (b.onclick = () => { BC.seg = b.dataset.k; BC.exclude.clear(); box.querySelectorAll('#bSegs button').forEach((x) => x.classList.toggle('on', x === b)); drawList(); }));
  if (BC.mode === 'seg') drawList();
  if (BC.mode === 'groups' && $('#bSend')) {
    const bg = document.createElement('button'); bg.id = 'bSendBg'; bg.className = 'primary'; bg.style.marginInlineStart = '6px'; bg.textContent = '🚀 שלח ברקע לכל הקבוצות של הבוט';
    $('#bSend').after(bg);
    let armed = false;
    bg.onclick = async () => {
      keep();
      if (BC.text.trim().length < 3 && !BC.file) return toast('כתוב את נוסח ההודעה או צרף תמונה', true);
      if (!armed) { armed = true; bg.textContent = '⚠️ לחץ שוב לאישור'; setTimeout(() => { armed = false; bg.textContent = '🚀 שלח ברקע לכל הקבוצות של הבוט'; }, 5000); return; }
      try {
        const body = { text: BC.text, delaySec: BC.delay, instanceId: BC.inst, vary: true, botGroups: true };
        if (BC.file) { toast('מעלה את הקובץ...'); const up = await api('POST', '/api/admin/broadcast/upload', BC.file, { 'Content-Type': BC.file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(BC.file.name) }); body.fileId = up.fileId; }
        S.bjob = await api('POST', '/api/admin/broadcast/send', body); drawBcastJob(); toast('🚀 רץ ברקע – אפשר לסגור את החלון');
      } catch (e) { toast(e.message, true, 7000); }
    };
  }
  $('#bFileBtn').onclick = () => $('#bFile').click();
  $('#bFile').onchange = (e) => { const f = e.target.files[0]; if (f) { keep(); BC.file = f; $('#bFileName').innerHTML = '📎 ' + esc(f.name) + ' <a id="bFileX" style="cursor:pointer">✕</a>'; $('#bFileX').onclick = () => { BC.file = null; $('#bFileName').textContent = ''; }; } };
  if ($('#bFileX')) $('#bFileX').onclick = () => { BC.file = null; $('#bFileName').textContent = ''; };
  if (BC.mode === 'groups') {
    const drawGroups = () => {
      const gs = BC.groups || [];
      const on = gs.filter((g) => !BC.gOff.has(g.chatId)).length;
      $('#bGAll').checked = gs.length && on === gs.length; $('#bGCnt').textContent = `${on} מתוך ${gs.length}`;
      $('#bGList').innerHTML = (gs.length && BC.gNotes && BC.gNotes.length ? `<div class="hint" style="color:#b45309;margin-bottom:4px">⚠️ ${esc(BC.gNotes.join(' · '))}</div>` : '') + (gs.length ? gs.map((g) => `<label class="check" style="margin:2px 0"><input type="checkbox" data-g="${esc(g.chatId)}" ${BC.gOff.has(g.chatId) ? '' : 'checked'}> 👥 ${esc(g.name)} <span class="chip">${esc(g.instanceName)}</span></label>`).join('') : `<div class="hint">${esc((BC.gNotes || []).join(' · ') || 'לא נמצאו קבוצות. בדוק את מספר הבוט.')}</div>`);
      $('#bGList').querySelectorAll('[data-g]').forEach((c) => (c.onchange = () => { if (c.checked) BC.gOff.delete(c.dataset.g); else BC.gOff.add(c.dataset.g); drawGroups(); }));
    };
    $('#bGAll').onchange = (e) => { if (e.target.checked) BC.gOff.clear(); else (BC.groups || []).forEach((g) => BC.gOff.add(g.chatId)); drawGroups(); };
    const load = async () => {
      const r = await api('GET', '/api/admin/broadcast/groups').catch((e) => ({ groups: [], notes: [e.message], bot: '' }));
      BC.groups = r.groups; BC.gNotes = r.notes; if (r.fallback && !BC.gTouched) r.groups.forEach((g) => BC.gOff.add(g.chatId)); if ($('#bBot')) $('#bBot').value = r.bot ? localPhone(normLocal(r.bot)).replace(/-/g, '') : '';
      drawGroups(); if (r.notes && r.notes.length) toast(r.notes.join(' · '), true, 7000);
    };
    $('#bBotSave').onclick = async () => { await api('POST', '/api/admin/broadcast/bot', { phone: $('#bBot').value }); BC.groups = null; BC.gOff.clear(); $('#bGList').innerHTML = '<div class="hint">בודק את כל הקבוצות (עד דקה)...</div>'; load(); };
    if (BC.groups) { drawGroups(); api('GET', '/api/admin/broadcast/groups').then((r) => { if ($('#bBot')) $('#bBot').value = r.bot ? localPhone(normLocal(r.bot)).replace(/-/g, '') : ''; }).catch(() => {}); } else load();
  }
  $('#bSample').onclick = async () => {
    keep(); if (BC.text.trim().length < 3) return toast('כתוב קודם את נוסח ההודעה', true);
    const ex = await api('POST', '/api/admin/broadcast/sample', { text: BC.text, optOutLine: BC.optOut && BC.mode !== 'groups', group: BC.mode === 'groups' }).catch(() => []);
    $('#bSamples').innerHTML = `<div class="hint" style="margin-top:8px">כך זה ייראה אצל 3 לקוחות שונים:</div>` + ex.map((t) => `<div class="msg out" style="max-width:none;margin:6px 0;white-space:pre-wrap">${waFormat(t)}</div>`).join('');
  };
  $('#bSend').onclick = async () => {
    keep();
    if (BC.text.trim().length < 3 && !BC.file) return toast('כתוב את נוסח ההודעה או צרף תמונה', true);
    const body = { text: BC.text, optOutLine: BC.optOut, delaySec: BC.delay, instanceId: BC.inst, vary: true };
    if (BC.mode === 'groups') { const gs = (BC.groups || []).filter((g) => !BC.gOff.has(g.chatId)); if (!gs.length) return toast('לא נבחרו קבוצות', true); body.groups = gs; }
    else if (BC.mode === 'seg') { if (!BC.seg) return toast('בחר מוצר', true); body.segment = BC.seg; body.exclude = [...BC.exclude]; }
    else { if (!BC.numbers.trim()) return toast('הדבק מספרים', true); body.numbers = BC.numbers; }
    const b = $('#bSend');
    if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = '⚠️ בטוח? לחץ שוב לשליחה'; setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = '📤 שלח'; } }, 5000); return; }
    try {
      if (BC.file) { toast('מעלה את הקובץ...'); const up = await api('POST', '/api/admin/broadcast/upload', BC.file, { 'Content-Type': BC.file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(BC.file.name) }); body.fileId = up.fileId; }
      S.bjob = await api('POST', '/api/admin/broadcast/send', body); drawBcastJob(); toast('📣 ההפצה התחילה');
    } catch (e) { toast(e.message, true, 7000); }
  };
  drawBcastJob();
}
function drawBcastJob() {
  const el = $('#bProg'); if (!el) return;
  const j = S.bjob; if (!j) { el.innerHTML = ''; return; }
  const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
  el.innerHTML = `<div class="card2" style="margin-top:10px"><b>${j.running ? '📤 שולח' : j.cancel ? '⏹ נעצר' : '✅ הסתיים'}: ${esc(j.title)}</b>
    <div style="height:8px;background:var(--bg);border-radius:8px;margin:8px 0;overflow:hidden"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#00c6d8,#6d5cf6)"></div></div>
    ${j.phase ? `<div class="hint">${esc(j.phase)}</div>` : ''}
    ${!j.running && !j.total ? '<div class="hint">⚠️ לא נמצאו קבוצות שהבוט חבר בהן</div>' : ''}
    <div class="hint">${j.done} מתוך ${j.total} · נשלחו ${j.sent}${j.failed ? ` · ⚠️ נכשלו ${j.failed}` : ''}</div>
    ${j.failures && j.failures.length ? `<div class="hint">${j.failures.map((f) => `${esc(f.name || '')} ${esc(localPhone(f.phone))}: ${esc(f.error || '')}`).join('<br>')}</div>` : ''}
    ${j.running ? '<button id="bStop" class="danger" style="margin-top:6px">⏹ עצור</button>' : ''}</div>`;
  if ($('#bStop')) $('#bStop').onclick = async () => { S.bjob = await api('POST', '/api/admin/broadcast/cancel'); drawBcastJob(); };
}

// 👥 קריאה חדשה בקבוצה – חלון קופץ (גם בתוך WhatsApp Multi)
function groupPop(ev) {
  try { console.log('__HD_STAFF__:' + JSON.stringify({ from: '👥 קריאה חדשה בקבוצה: ' + ev.group, text: (ev.sender ? ev.sender + ': ' : '') + ev.text })); } catch {}
  Sounds.newMessage();
  notify('👥 ' + ev.group, (ev.sender ? ev.sender + ': ' : '') + ev.text);
  flashTitle('👥 קריאה חדשה בקבוצה');
  let el = document.getElementById('grpPop');
  if (!el) { el = document.createElement('div'); el.id = 'grpPop'; el.className = 'grppop'; document.body.appendChild(el); }
  el.innerHTML = `<div class="gp-h">👥 קריאה חדשה בקבוצה <span class="chip">${esc(ev.inst || '')}</span><a class="gp-x" title="סגור">✕</a></div>
    <div class="gp-g">${esc(ev.group)}</div>
    <div class="gp-t">${ev.sender ? `<b>${esc(ev.sender)}:</b> ` : ''}${esc(ev.text || '')}</div>
    <button class="primary gp-open">פתח את הקריאה #${ev.ticketId}</button>`;
  el.querySelector('.gp-x').onclick = (e) => { e.stopPropagation(); el.remove(); };
  el.querySelector('.gp-open').onclick = () => { el.remove(); if (S.mode === 'wa' && typeof leaveWa === 'function') leaveWa(); openTicket(ev.ticketId); };
  clearTimeout(el._t); el._t = setTimeout(() => el.remove(), 60000);
}

// ---------- ⏰ קריאות חורגות (גרסה 90) ----------
// קריאה שלי (assigneeId = אני) פתוחה יותר מ-30 דק׳ מפתיחתה ולא מושהית → חלון גדול באמצע המסך, קריאה אחת בכל פעם (הוותיקה קודם).
// רק למטפל עצמו. קריאה שלא שויכה – לא קופצת לאף אחד (גרסה 92). "כנס לסגירה" → פותח את הצ'אט + חלון הסגירה והתיעוד. "התעלם" (או כניסה בלי סגירה) → חוזר אחרי שעה (גרסה 96; קודם 5 דק׳).
// לא קופץ כשחלון אחר פתוח (למשל באמצע כתיבת תיעוד), וגם לא באמצע כתיבת הודעה (גרסה 95).
// גרסה 94: אם העובד כבר ענה ללקוח (lastOutAt) → קופץ רק שעה אחרי התשובה האחרונה; לא ענה בכלל → 30 דק׳ מפתיחה. לא קופץ לפני 09:00 (שעון ישראל).
const OVERDUE_MIN = 30, OVERDUE_AGAIN_MIN = 60, OVERDUE_AFTER_REPLY_MIN = 60, OVERDUE_FROM_HOUR = 9;
const ilHour = () => { try { return +new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(new Date()); } catch { return new Date().getHours(); } };
const overdueDue = (t, now) => (t.lastOutAt ? now - t.lastOutAt >= OVERDUE_AFTER_REPLY_MIN * 60000 : now - t.createdAt >= OVERDUE_MIN * 60000);
const overdueAck = (() => { try { return JSON.parse(localStorage.getItem('hd-overdue-ack') || '{}'); } catch { return {}; } })();
const saveOverdueAck = () => { try { localStorage.setItem('hd-overdue-ack', JSON.stringify(overdueAck)); } catch {} };
function overdueCheck() {
  if (!S.me || !S.tickets) return;
  const now = Date.now();
  for (const id of Object.keys(overdueAck)) if (!S.tickets.has(id)) delete overdueAck[id];
  const mine = [...S.tickets.values()].filter((t) => t.status !== 'closed' && t.assigneeId === S.me.id
    && !(t.snoozeUntil && t.snoozeUntil > now) && t.createdAt && overdueDue(t, now));
  const el = document.getElementById('overduePop');
  if (ilHour() < OVERDUE_FROM_HOUR) { if (el) el.remove(); return; }
  if (el) { if (!mine.some((t) => t.id === el.dataset.id)) el.remove(); return; }
  if (modal.classList.contains('on') || isTyping() || document.querySelector('#vcatBtn[disabled]')) return; // לא באמצע חלון / כתיבה / העברה לויקאט
  const next = mine.filter((t) => !overdueAck[t.id] || now - overdueAck[t.id] >= OVERDUE_AGAIN_MIN * 60000).sort((a, b) => a.createdAt - b.createdAt)[0];
  if (next) showOverdue(next, mine.length);
}
function showOverdue(t, total) {
  const el = document.createElement('div');
  el.id = 'overduePop'; el.dataset.id = t.id;
  const m = Math.floor((Date.now() - t.createdAt) / 60000);
  const age = m < 120 ? m + ' דקות' : Math.floor(m / 60) + ' שעות ו-' + (m % 60) + ' דקות';
  el.innerHTML = `<div class="op-box"><div class="op-title">⏰ קריאה פתוחה ${age}</div>
    <div class="op-name">${t.isGroup ? '👥 ' : ''}${esc(t.customerName || '')}</div>
    <div class="op-sub">${t.assigneeId ? '' : '⚠️ לא שויכה לאף עובד · '}קריאה #${t.id}${t.lastText ? ' · ' + esc(String(t.lastText).slice(0, 80)) : ''}</div>
    ${total > 1 ? `<div class="op-sub">יש לך עוד ${total === 2 ? 'קריאה אחת שחרגה – תקפוץ אחרי זו' : (total - 1) + ' קריאות שחרגו – יקפצו אחת אחרי השנייה'}</div>` : ''}
    <button class="primary op-go">💬 כנס לסגירה ותיעוד</button>
    <button class="op-skip">התעלם – הזכר לי בעוד שעה</button></div>`;
  const ack = () => { overdueAck[t.id] = Date.now(); saveOverdueAck(); el.remove(); };
  el.querySelector('.op-skip').onclick = ack;
  el.querySelector('.op-go').onclick = async () => {
    ack(); await openTicket(t.id);
    if (S.view && S.view.ticket && S.view.ticket.id === t.id && S.view.ticket.status !== 'closed') closeTicket();
  };
  document.body.appendChild(el);
  notify(t.lastOutAt ? '⏰ קריאה פתוחה – עברה שעה מהתשובה שלך' : '⏰ קריאה פתוחה יותר מחצי שעה', t.customerName || '');
}
setInterval(overdueCheck, 20000);
setTimeout(overdueCheck, 5000);

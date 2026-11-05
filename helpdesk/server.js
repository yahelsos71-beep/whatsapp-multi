// מוקד וואטסאפ – שרת
// כל ההודעות מכל מספרי המשרד מגיעות לכאן דרך Green API, נפתחות כקריאות,
// מנותבות לנציג בעזרת Claude, וכל נציג רואה ועונה רק לקריאות שלו.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');
const ga = require('./lib/greenapi');
const { routeTicket } = require('./lib/ai');
const { parseSheet } = require('./lib/sheet');

const { db } = store;
const APP_DIR = __dirname;
const PUBLIC = path.join(APP_DIR, 'public');
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'version.json'), 'utf8')).version || 0; } catch { return 0; } })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

// =====================================================================
// משתמשים והתחברות
// =====================================================================
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}
function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}
const publicUser = (u) => u && { id: u.id, name: u.name, username: u.username, role: u.role, active: u.active !== false, phone: u.phone || '' };
const userById = (id) => db.users.find((u) => u.id === id);
const admins = () => db.users.filter((u) => u.role === 'admin' && u.active !== false);

function getSessionUser(req) {
  const m = /(?:^|;\s*)hd_s=([a-f0-9]+)/.exec(req.headers.cookie || '');
  const s = m && db.sessions[m[1]];
  if (!s || s.exp < now()) return null;
  const u = userById(s.userId);
  return u && u.active !== false ? u : null;
}

// =====================================================================
// קריאות
// =====================================================================
const instById = (id) => db.config.instances.find((i) => i.id === id);
const depById = (id) => db.config.departments.find((d) => d.id === id);
const ticketById = (id) => db.tickets.find((t) => t.id === String(id));
const openTicketFor = (instanceId, chatId) =>
  db.tickets.find((t) => t.instanceId === instanceId && t.chatId === chatId && t.status !== 'closed');
const ruleFor = (instanceId, chatId) => (db.config.chatRules || []).find((x) => x.instanceId === instanceId && x.chatId === chatId);
const staffByPhone = (phone) => phone && db.users.find((u) => u.active !== false && u.phone && u.phone === phone);
const isIgnored = (instanceId, chatId) => (db.config.ignoredChats || []).some((x) => x.instanceId === instanceId && x.chatId === chatId);
const canSee = (user, t) => user.role === 'admin' || t.assigneeId === user.id;

// =====================================================================
// אנשי קשר (מ-iCount / ידני)
// =====================================================================
function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '972' + d.slice(1);
  else if (/^5\d{8}$/.test(d) || /^[2-9]\d{7}$/.test(d)) d = '972' + d;
  return d.length >= 9 ? d : '';
}
let contactByPhone = new Map();
function reindexContacts() {
  contactByPhone = new Map();
  for (const c of db.contacts) for (const p of c.phones || []) if (!contactByPhone.has(p)) contactByPhone.set(p, c);
}
reindexContacts();
const contactFor = (phone) => contactByPhone.get(phone) || null;
function displayName(t) {
  const c = !t.isGroup && contactFor(t.phone);
  return c ? (c.name || c.company || t.customerName) : t.customerName;
}

function summary(t) {
  const msgs = store.messages(t.id);
  const last = [...msgs].reverse().find((m) => m.dir !== 'note' && !m.auto);
  const a = userById(t.assigneeId);
  const d = depById(t.departmentId);
  const inst = instById(t.instanceId);
  const c = !t.isGroup && contactFor(t.phone);
  return {
    ...t,
    waName: t.customerName,
    pinnedTo: (ruleFor(t.instanceId, t.chatId) && userById(ruleFor(t.instanceId, t.chatId).userId)?.name) || '',
    customerName: c ? (c.name || c.company || t.customerName) : t.customerName,
    company: c && c.name ? c.company || '' : '',
    assigneeName: a ? a.name : '',
    departmentName: d ? d.name : '',
    instanceName: inst ? inst.name : '',
    lastText: last ? (last.text || { image: '📷 תמונה', video: '🎬 וידאו', file: '📎 קובץ', audio: '🎤 הקלטה', location: '📍 מיקום' }[last.type] || '') : '',
    lastDir: last ? last.dir : '',
    count: msgs.length,
  };
}

function nextTicketId() {
  db.config.seq = (db.config.seq || 1000) + 1;
  store.saveConfig();
  return String(db.config.seq);
}

function addMessage(t, m) {
  const msg = { id: store.newId(), ts: now(), ...m };
  store.messages(t.id).push(msg);
  store.saveMessages(t.id);
  t.updatedAt = now();
  emitToTicket(t, { type: 'message', ticketId: t.id, message: msg });
  return msg;
}
function note(t, text) { return addMessage(t, { dir: 'note', type: 'text', text }); }

function createTicket(inst, chatId, name, { status = 'routing', assigneeId = null } = {}) {
  const t = {
    id: nextTicketId(),
    instanceId: inst.id,
    chatId,
    phone: chatId.split('@')[0],
    customerName: name || chatId.split('@')[0],
    isGroup: chatId.endsWith('@g.us'),
    status,
    departmentId: null,
    assigneeId,
    createdAt: now(),
    updatedAt: now(),
    lastInAt: 0,
    lastOutAt: 0,
    awaiting: false,
  };
  db.tickets.push(t);
  store.saveTickets();
  return t;
}

// =====================================================================
// אירועים חיים (SSE) לדפדפנים
// =====================================================================
const clients = new Map(); // userId -> Set(res)
function sendTo(userId, ev) {
  for (const res of clients.get(userId) || []) { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {} }
}
function audience(t) {
  const ids = new Set(admins().map((u) => u.id));
  if (t.assigneeId) ids.add(t.assigneeId);
  return ids;
}
function emitTicket(t, extra = {}) {
  const s = summary(t);
  for (const id of audience(t)) sendTo(id, { type: 'ticket', ticket: s, ...extra, sound: id === t.assigneeId || (!t.assigneeId) ? extra.sound : null });
  store.saveTickets();
}
function emitToTicket(t, ev) { for (const id of audience(t)) sendTo(id, ev); }
function emitAll(ev) { for (const id of clients.keys()) sendTo(id, ev); }

// =====================================================================
// ניתוב בעזרת AI + מענה אוטומטי
// =====================================================================
const routingTimers = new Map();
function scheduleRouting(t) {
  if (routingTimers.has(t.id)) return;
  const delay = Math.max(0, (db.config.routeDelaySec ?? 15) * 1000 - (now() - t.createdAt));
  routingTimers.set(t.id, setTimeout(() => { routingTimers.delete(t.id); doRouting(t).catch((e) => log('routing error', e.message)); }, delay));
}

async function doRouting(t) {
  if (t.status !== 'routing') return;
  const texts = store.messages(t.id).filter((m) => m.dir === 'in').map((m) => (m.senderName ? m.senderName + ': ' : '') + (m.text || `[${m.type}]`)).slice(0, 10);
  const ct = !t.isGroup && contactFor(t.phone);
  const who = t.isGroup ? 'WhatsApp group: ' + t.customerName : ct ? `${ct.name || t.customerName}${ct.company ? ' (company: ' + ct.company + ')' : ''}` : t.customerName;
  const r = await routeTicket(db.config, { customerName: who, texts });
  const dep = r.departmentId ? depById(r.departmentId) : null;
  let assignee = dep && userById(dep.userId);
  if (!assignee || assignee.active === false) assignee = admins()[0] || null;
  t.departmentId = dep ? dep.id : null;
  t.assigneeId = assignee ? assignee.id : null;
  t.aiReason = r.reason;
  t.status = 'open';
  note(t, dep ? `🤖 נותב ל${assignee ? assignee.name : '?'} (${dep.name}) – ${r.reason}` : `🤖 לא זוהתה מחלקה – הועבר ל${assignee ? assignee.name : 'מנהל'}. ${r.reason}`);
  emitTicket(t, { sound: 'new' });
  log(`ticket #${t.id} routed -> ${assignee && assignee.name} (${dep ? dep.name : 'unknown'})`);

  const ar = db.config.autoReply;
  if (ar.enabled && (!t.isGroup || db.config.groups.autoReply)) {
    const tpl = dep ? ar.routed : ar.unknown;
    const dn = displayName(t);
    const name = dn && !/^[\d+\s-]+$/.test(dn) && !t.isGroup ? ' ' + dn.split(' ')[0] : '';
    const text = tpl
      .replace(/\{name\}/g, name)
      .replace(/\{agent\}/g, assignee ? assignee.name : '')
      .replace(/\{department\}/g, dep ? dep.name : '')
      .replace(/\{company\}/g, db.config.companyName || '');
    try { await sendText(t, text, null, { auto: true }); } catch (e) { note(t, '⚠️ המענה האוטומטי לא נשלח: ' + e.message); }
  }
}

// =====================================================================
// שליחה
// =====================================================================
const sentIds = new Set();
async function sendText(t, text, user, { auto = false } = {}) {
  const inst = instById(t.instanceId);
  if (!inst) throw new Error('המספר של הקריאה לא מוגדר');
  const r = await ga.sendMessage(inst, t.chatId, text);
  if (r && r.idMessage) sentIds.add(r.idMessage);
  const msg = addMessage(t, { dir: 'out', type: 'text', text, idMessage: r && r.idMessage, byUserId: user ? user.id : null, byName: user ? user.name : 'מענה אוטומטי', auto, status: 'sent' });
  if (!auto) { t.awaiting = false; t.lastOutAt = now(); }
  emitTicket(t);
  return msg;
}

// =====================================================================
// קבלת הודעות מ-Green API
// =====================================================================
const instState = {}; // instId -> 'authorized' / 'notAuthorized' / 'error: ...'
function findMessageByIdMessage(idMessage) {
  for (const t of db.tickets.slice(-300).reverse()) {
    const m = store.messages(t.id).find((x) => x.idMessage === idMessage);
    if (m) return { t, m };
  }
  return null;
}

async function handleNotification(inst, body) {
  const type = body && body.typeWebhook;
  if (type === 'stateInstanceChanged') { instState[inst.id] = body.stateInstance; emitAll({ type: 'instances', list: instancesStatus() }); return; }
  if (type === 'outgoingMessageStatus') {
    const f = findMessageByIdMessage(body.idMessage);
    if (f) { f.m.status = body.status; store.saveMessages(f.t.id); emitToTicket(f.t, { type: 'status', ticketId: f.t.id, msgId: f.m.id, status: body.status }); }
    return;
  }
  if (!['incomingMessageReceived', 'outgoingMessageReceived', 'outgoingAPIMessageReceived'].includes(type)) return;
  const sd = body.senderData || {};
  const chatId = sd.chatId || '';
  if (!chatId || /broadcast|newsletter/.test(chatId)) return; // סטטוסים וערוצים – לא קריאות
  const isGroup = chatId.endsWith('@g.us');
  if (isGroup && !db.config.groups.enabled) return;
  if (isIgnored(inst.id, chatId)) return;
  const m = ga.parseMessage(body.messageData);
  if (m.type === 'reaction' || m.type === 'deleted') return;
  if (m.type === 'edited') { m.type = 'text'; m.text = '✏️ (נערכה) ' + m.text; }
  const ts = body.timestamp ? body.timestamp * 1000 : now();

  if (type !== 'incomingMessageReceived') {
    // הודעה יוצאת: נשלחה מהטלפון או מה-API
    if (sentIds.has(body.idMessage) || findMessageByIdMessage(body.idMessage)) return;
    const t = openTicketFor(inst.id, chatId);
    if (!t) return; // אין קריאה פתוחה – לא פותחים קריאה על הודעה יוצאת
    addMessage(t, { ...m, dir: 'out', ts, idMessage: body.idMessage, byName: type === 'outgoingMessageReceived' ? 'מהטלפון' : 'API' });
    t.awaiting = false; t.lastOutAt = ts;
    emitTicket(t);
    return;
  }

  let t = openTicketFor(inst.id, chatId);
  const isNew = !t;
  const rule = ruleFor(inst.id, chatId);
  const pinned = rule && userById(rule.userId);
  if (!t) {
    const name = isGroup ? (sd.chatName || 'קבוצה') : (sd.senderContactName || sd.senderName || sd.chatName);
    if (pinned && pinned.active !== false) {
      // צ'אט/קבוצה שמשויכים קבוע לעובד – בלי AI ובלי מענה אוטומטי
      t = createTicket(inst, chatId, name, { status: 'open', assigneeId: pinned.id });
      const dep = db.config.departments.find((d) => d.userId === pinned.id);
      if (dep) t.departmentId = dep.id;
      note(t, `📌 משויך קבוע ל${pinned.name}`);
    } else t = createTicket(inst, chatId, name);
    log(`new ticket #${t.id} from ${t.phone} (${inst.name})`);
  }
  if (isGroup && sd.chatName && t.customerName !== sd.chatName) t.customerName = sd.chatName;
  const senderPhone = String(sd.sender || '').split('@')[0];
  const staff = isGroup && staffByPhone(senderPhone);
  addMessage(t, { ...m, dir: 'in', ts, idMessage: body.idMessage, ...(isGroup ? { senderName: staff ? staff.name : sd.senderContactName || sd.senderName || senderPhone, staff: !!staff } : {}) });
  if (staff && staff.id === t.assigneeId) {
    // העובד עצמו ענה בקבוצה מהטלפון שלו – נחשב כתשובה
    t.awaiting = false; t.lastOutAt = ts;
    emitTicket(t);
    return;
  }
  t.awaiting = true;
  t.lastInAt = ts;
  emitTicket(t, { sound: isNew ? null : 'msg' });
  if (t.status === 'routing') scheduleRouting(t);
}

const pollers = new Map(); // instId -> { stop }
function startPollers() {
  const active = new Set();
  for (const inst of db.config.instances) {
    if (inst.enabled === false || !inst.idInstance || !inst.token) continue;
    active.add(inst.id);
    if (pollers.has(inst.id)) continue;
    const ctl = { stop: false };
    pollers.set(inst.id, ctl);
    pollLoop(inst.id, ctl);
  }
  for (const [id, ctl] of pollers) if (!active.has(id)) { ctl.stop = true; pollers.delete(id); }
}
async function pollLoop(instId, ctl) {
  log('polling started', instId);
  while (!ctl.stop) {
    const inst = instById(instId);
    if (!inst) break;
    try {
      const n = await ga.receiveNotification(inst);
      if (instState[inst.id] && String(instState[inst.id]).startsWith('error')) { instState[inst.id] = 'authorized'; }
      if (!n || !n.receiptId) continue;
      try { await handleNotification(inst, n.body); } catch (e) { log('handle error', e.message); }
      await ga.deleteNotification(inst, n.receiptId);
    } catch (e) {
      instState[instId] = 'error: ' + e.message.slice(0, 120);
      await sleep(5000);
    }
  }
  log('polling stopped', instId);
}
function instancesStatus() {
  return db.config.instances.map((i) => ({ id: i.id, name: i.name, enabled: i.enabled !== false, state: instState[i.id] || 'unknown' }));
}
async function refreshStates() {
  for (const inst of db.config.instances) {
    if (inst.enabled === false || !inst.idInstance || !inst.token) continue;
    try { const s = await ga.getStateInstance(inst); instState[inst.id] = s && s.stateInstance || 'unknown'; }
    catch (e) { instState[inst.id] = 'error: ' + e.message.slice(0, 120); }
  }
  emitAll({ type: 'instances', list: instancesStatus() });
}

// =====================================================================
// HTTP
// =====================================================================
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) { const b = await readBody(req, 2 * 1024 * 1024); return b.length ? JSON.parse(b.toString('utf8')) : {}; }
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg' };
function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}
const mask = (s) => (s ? '••••' + String(s).slice(-4) : '');
const unmask = (incoming, old) => (typeof incoming === 'string' && incoming.startsWith('••••') ? old : incoming);

function adminConfigView() {
  const c = db.config;
  return {
    companyName: c.companyName, host: c.host, port: c.port, routeDelaySec: c.routeDelaySec,
    departments: c.departments,
    ai: { enabled: c.ai.enabled, model: c.ai.model, apiKey: mask(c.ai.apiKey) },
    autoReply: c.autoReply,
    groups: c.groups,
    ignoredChats: c.ignoredChats,
    chatRules: c.chatRules.map((r) => ({ ...r, userName: userById(r.userId)?.name || '' })),
    instances: c.instances.map((i) => ({ ...i, token: mask(i.token) })),
  };
}

const routes = [];
const route = (method, pattern, handler, { auth = 'user' } = {}) => routes.push({ method, pattern, handler, auth });

// ---------- התקנה ראשונה / התחברות ----------
route('GET', /^\/api\/state$/, (req, res, { user }) =>
  send(res, 200, { setupNeeded: db.users.length === 0, user: publicUser(user), version: VERSION, company: db.config.companyName }), { auth: 'none' });

route('POST', /^\/api\/setup$/, async (req, res) => {
  if (db.users.length) return send(res, 400, { error: 'כבר הוגדר' });
  const b = await readJson(req);
  if (!b.username || !b.password || String(b.password).length < 4) return send(res, 400, { error: 'שם משתמש וסיסמה (4 תווים לפחות)' });
  db.users.push({ id: store.newId(), name: b.name || b.username, username: String(b.username).trim().toLowerCase(), role: 'admin', active: true, ...hashPassword(b.password) });
  store.saveUsers();
  send(res, 200, { ok: true });
}, { auth: 'none' });

route('POST', /^\/api\/login$/, async (req, res) => {
  const b = await readJson(req);
  const u = db.users.find((x) => x.username === String(b.username || '').trim().toLowerCase() && x.active !== false);
  if (!u || !checkPassword(u, b.password || '')) { await sleep(600); return send(res, 401, { error: 'שם משתמש או סיסמה שגויים' }); }
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { userId: u.id, exp: now() + 30 * 864e5 };
  for (const [k, s] of Object.entries(db.sessions)) if (s.exp < now()) delete db.sessions[k];
  store.saveSessions();
  send(res, 200, { user: publicUser(u) }, { 'Set-Cookie': `hd_s=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}` });
}, { auth: 'none' });

route('POST', /^\/api\/logout$/, (req, res) => {
  const m = /(?:^|;\s*)hd_s=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (m) { delete db.sessions[m[1]]; store.saveSessions(); }
  send(res, 200, { ok: true }, { 'Set-Cookie': 'hd_s=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
});

route('POST', /^\/api\/me\/password$/, async (req, res, { user }) => {
  const b = await readJson(req);
  if (!checkPassword(user, b.old || '')) return send(res, 400, { error: 'הסיסמה הנוכחית שגויה' });
  if (!b.password || String(b.password).length < 4) return send(res, 400, { error: 'סיסמה של 4 תווים לפחות' });
  Object.assign(user, hashPassword(b.password));
  store.saveUsers();
  send(res, 200, { ok: true });
});

// ---------- אירועים חיים ----------
route('GET', /^\/api\/events$/, (req, res, { user }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ type: 'hello', version: VERSION, instances: instancesStatus() })}\n\n`);
  if (!clients.has(user.id)) clients.set(user.id, new Set());
  clients.get(user.id).add(res);
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ka); clients.get(user.id)?.delete(res); });
});

// ---------- קריאות ----------
route('GET', /^\/api\/users$/, (req, res) => send(res, 200, db.users.filter((u) => u.active !== false).map(publicUser)));
route('GET', /^\/api\/instances$/, (req, res) => send(res, 200, instancesStatus()));

route('GET', /^\/api\/tickets$/, (req, res, { user, query }) => {
  const closed = query.get('scope') === 'closed';
  let list = db.tickets.filter((t) => (closed ? t.status === 'closed' : t.status !== 'closed') && canSee(user, t));
  if (closed) list = list.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 200);
  send(res, 200, list.map(summary));
});

function visibleTicket(user, id) {
  const t = ticketById(id);
  if (!t) return null;
  if (canSee(user, t)) return t;
  // היסטוריה: מותר לראות קריאה קודמת של לקוח שיש לך קריאה פתוחה שלו
  const mine = db.tickets.find((x) => x.chatId === t.chatId && x.instanceId === t.instanceId && canSee(user, x));
  return mine ? t : null;
}

route('GET', /^\/api\/tickets\/(\d+)$/, (req, res, { user, params }) => {
  const t = visibleTicket(user, params[0]);
  if (!t) return send(res, 404, { error: 'לא נמצא' });
  const history = db.tickets
    .filter((x) => x.chatId === t.chatId && x.instanceId === t.instanceId && x.id !== t.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((x) => ({ id: x.id, createdAt: x.createdAt, closedAt: x.closedAt, status: x.status, assigneeName: userById(x.assigneeId)?.name || '', departmentName: depById(x.departmentId)?.name || '' }));
  send(res, 200, { ticket: summary(t), messages: store.messages(t.id), history, readOnly: !canSee(user, t) });
});

function myTicket(user, id, res) {
  const t = ticketById(id);
  if (!t || !canSee(user, t)) { send(res, 404, { error: 'לא נמצא' }); return null; }
  return t;
}

route('POST', /^\/api\/tickets\/(\d+)\/send$/, async (req, res, { user, params }) => {
  const t = myTicket(user, params[0], res); if (!t) return;
  if (t.status === 'closed') return send(res, 400, { error: 'הקריאה סגורה – פתח אותה מחדש כדי לשלוח' });
  const b = await readJson(req);
  const text = String(b.text || '').trim();
  if (!text) return send(res, 400, { error: 'הודעה ריקה' });
  try { send(res, 200, await sendText(t, text, user)); }
  catch (e) { send(res, 502, { error: 'השליחה נכשלה: ' + e.message }); }
});

route('POST', /^\/api\/tickets\/(\d+)\/upload$/, async (req, res, { user, params }) => {
  const t = myTicket(user, params[0], res); if (!t) return;
  if (t.status === 'closed') return send(res, 400, { error: 'הקריאה סגורה' });
  const inst = instById(t.instanceId);
  const fileName = decodeURIComponent(req.headers['x-file-name'] || 'file');
  const caption = decodeURIComponent(req.headers['x-caption'] || '');
  const mime = req.headers['content-type'] || 'application/octet-stream';
  let buf;
  try { buf = await readBody(req, 60 * 1024 * 1024); } catch { return send(res, 413, { error: 'הקובץ גדול מדי (עד 60MB)' }); }
  try {
    const r = await ga.sendFile(inst, t.chatId, buf, fileName, mime, caption);
    if (r && r.idMessage) sentIds.add(r.idMessage);
    const type = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';
    const msg = addMessage(t, { dir: 'out', type, text: caption, fileName, mime, url: r && r.urlFile || '', idMessage: r && r.idMessage, byUserId: user.id, byName: user.name, status: 'sent' });
    t.awaiting = false; t.lastOutAt = now();
    emitTicket(t);
    send(res, 200, msg);
  } catch (e) { send(res, 502, { error: 'השליחה נכשלה: ' + e.message }); }
});

route('POST', /^\/api\/tickets\/(\d+)\/transfer$/, async (req, res, { user, params }) => {
  const t = myTicket(user, params[0], res); if (!t) return;
  const b = await readJson(req);
  const to = userById(b.userId);
  if (!to || to.active === false) return send(res, 400, { error: 'עובד לא קיים' });
  const from = userById(t.assigneeId);
  const oldAssignee = t.assigneeId;
  t.assigneeId = to.id;
  const dep = db.config.departments.find((d) => d.userId === to.id);
  if (dep) t.departmentId = dep.id;
  if (t.status === 'routing') { t.status = 'open'; clearTimeout(routingTimers.get(t.id)); routingTimers.delete(t.id); }
  note(t, `↪️ ${user.name} העביר/ה את השיחה ${from ? 'מ' + from.name + ' ' : ''}ל${to.name}${b.note ? ': ' + b.note : ''}`);
  if (oldAssignee && oldAssignee !== to.id && userById(oldAssignee)?.role !== 'admin') sendTo(oldAssignee, { type: 'remove', id: t.id });
  emitTicket(t, { sound: 'new' });
  send(res, 200, summary(t));
});

route('POST', /^\/api\/tickets\/(\d+)\/close$/, (req, res, { user, params }) => {
  const t = myTicket(user, params[0], res); if (!t) return;
  t.status = 'closed'; t.closedAt = now(); t.closedBy = user.id; t.awaiting = false;
  note(t, `✅ הקריאה נסגרה על ידי ${user.name}`);
  emitTicket(t);
  send(res, 200, summary(t));
});

route('POST', /^\/api\/tickets\/(\d+)\/reopen$/, (req, res, { user, params }) => {
  const t = ticketById(params[0]);
  if (!t || !canSee(user, t)) return send(res, 404, { error: 'לא נמצא' });
  if (openTicketFor(t.instanceId, t.chatId)) return send(res, 400, { error: 'כבר יש קריאה פתוחה ללקוח הזה' });
  t.status = 'open'; t.closedAt = null;
  if (user.role !== 'admin') t.assigneeId = user.id;
  note(t, `🔄 הקריאה נפתחה מחדש על ידי ${user.name}`);
  emitTicket(t);
  send(res, 200, summary(t));
});

// קיבוע צ'אט/קבוצה לעובד (מנהל בלבד). userId ריק = ביטול הקיבוע
route('POST', /^\/api\/tickets\/(\d+)\/pin$/, async (req, res, { user, params }) => {
  const t = ticketById(params[0]);
  if (!t) return send(res, 404, { error: 'לא נמצא' });
  const b = await readJson(req);
  db.config.chatRules = db.config.chatRules.filter((x) => !(x.instanceId === t.instanceId && x.chatId === t.chatId));
  const to = b.userId && userById(b.userId);
  if (to) {
    db.config.chatRules.push({ instanceId: t.instanceId, chatId: t.chatId, name: t.customerName, isGroup: !!t.isGroup, userId: to.id });
    note(t, `📌 ${user.name} קיבע/ה את ${t.isGroup ? 'הקבוצה' : 'הצ\'אט'} ל${to.name}`);
    if (t.status !== 'closed' && t.assigneeId !== to.id) {
      const old = t.assigneeId;
      t.assigneeId = to.id;
      if (t.status === 'routing') { t.status = 'open'; clearTimeout(routingTimers.get(t.id)); routingTimers.delete(t.id); }
      const dep = db.config.departments.find((d) => d.userId === to.id);
      if (dep) t.departmentId = dep.id;
      if (old && userById(old)?.role !== 'admin') sendTo(old, { type: 'remove', id: t.id });
    }
  } else note(t, `📌 ${user.name} ביטל/ה את הקיבוע`);
  store.saveConfig();
  emitTicket(t, { sound: to ? 'new' : null });
  send(res, 200, summary(t));
}, { auth: 'admin' });

// "קריאה לעובד": שולח משימה לקבוצה המשויכת לעובד ופותח לו קריאה
route('GET', /^\/api\/tasks\/targets$/, (req, res) => {
  send(res, 200, db.config.chatRules.filter((r) => r.isGroup && userById(r.userId)?.active !== false)
    .map((r) => ({ userId: r.userId, userName: userById(r.userId)?.name || '', group: r.name, instanceName: instById(r.instanceId)?.name || '' })));
});
route('POST', /^\/api\/tasks$/, async (req, res, { user }) => {
  const b = await readJson(req);
  const text = String(b.text || '').trim();
  if (!text) return send(res, 400, { error: 'כתוב מה המשימה' });
  const r = db.config.chatRules.find((x) => x.isGroup && x.userId === b.userId);
  const emp = r && userById(r.userId);
  const inst = r && instById(r.instanceId);
  if (!r || !emp || !inst) return send(res, 400, { error: 'לא הוגדרה קבוצה לעובד הזה' });
  let t = openTicketFor(inst.id, r.chatId);
  if (!t) t = createTicket(inst, r.chatId, r.name, { status: 'open', assigneeId: emp.id });
  t.isGroup = true;
  if (t.assigneeId !== emp.id) t.assigneeId = emp.id;
  note(t, `📋 ${user.name} פתח/ה קריאה ל${emp.name}`);
  try { await sendText(t, text, user); } catch (e) { return send(res, 502, { error: 'השליחה לקבוצה נכשלה: ' + e.message }); }
  t.awaiting = true; t.lastInAt = now(); // מחכה לטיפול של העובד
  emitTicket(t, { sound: 'new' });
  send(res, 200, summary(t));
});

// התעלמות מצ'אט/קבוצה: לא ייפתחו ממנו קריאות (מנהל בלבד)
route('POST', /^\/api\/tickets\/(\d+)\/ignore$/, (req, res, { user, params }) => {
  const t = ticketById(params[0]);
  if (!t) return send(res, 404, { error: 'לא נמצא' });
  if (!isIgnored(t.instanceId, t.chatId)) db.config.ignoredChats.push({ instanceId: t.instanceId, chatId: t.chatId, name: t.customerName, isGroup: !!t.isGroup });
  store.saveConfig();
  if (t.status !== 'closed') { t.status = 'closed'; t.closedAt = now(); t.closedBy = user.id; t.awaiting = false; }
  note(t, `🔕 ${user.name} סימן/ה להתעלם מ${t.isGroup ? 'הקבוצה' : 'הצ\'אט'} – לא ייפתחו ממנו קריאות`);
  emitTicket(t);
  send(res, 200, { ok: true });
}, { auth: 'admin' });

// פתיחת שיחה חדשה ללקוח (יוזמה של העובד)
route('POST', /^\/api\/tickets\/new$/, async (req, res, { user }) => {
  const b = await readJson(req);
  const inst = instById(b.instanceId);
  if (!inst) return send(res, 400, { error: 'בחר מספר וואטסאפ' });
  const phone = normPhone(b.phone);
  if (!phone) return send(res, 400, { error: 'מספר טלפון לא תקין' });
  const chatId = phone + '@c.us';
  let t = openTicketFor(inst.id, chatId);
  if (t && !canSee(user, t)) return send(res, 400, { error: `יש כבר קריאה פתוחה ללקוח הזה אצל ${userById(t.assigneeId)?.name || 'עובד אחר'}` });
  if (!t) {
    t = createTicket(inst, chatId, b.name || phone, { status: 'open', assigneeId: user.id });
    const dep = db.config.departments.find((d) => d.userId === user.id);
    if (dep) t.departmentId = dep.id;
    note(t, `✉️ ${user.name} פתח/ה שיחה חדשה`);
  }
  if (b.text) { try { await sendText(t, String(b.text), user); } catch (e) { return send(res, 502, { error: 'השליחה נכשלה: ' + e.message, ticket: summary(t) }); } }
  emitTicket(t);
  send(res, 200, summary(t));
});

// ---------- אנשי קשר ----------
route('GET', /^\/api\/contacts$/, (req, res, { query }) => {
  const q = String(query.get('q') || '').trim().toLowerCase();
  const qd = q.replace(/\D/g, '');
  const qn = qd.length >= 3 ? (qd.startsWith('0') ? qd.slice(1) : qd.startsWith('972') ? qd.slice(3) : qd) : '';
  let list = db.contacts;
  if (q) list = list.filter((c) => String(c.company || '').toLowerCase().includes(q) || String(c.name || '').toLowerCase().includes(q) || (qn && (c.phones || []).some((p) => p.includes(qn))));
  send(res, 200, { total: db.contacts.length, list: list.slice(0, Number(query.get('limit')) || 30) });
});

// ייבוא: שלב 1 – קריאת הקובץ והצגת העמודות
route('POST', /^\/api\/admin\/contacts\/parse$/, async (req, res) => {
  let buf;
  try { buf = await readBody(req, 30 * 1024 * 1024); } catch { return send(res, 413, { error: 'הקובץ גדול מדי' }); }
  let rows;
  try { rows = parseSheet(buf, decodeURIComponent(req.headers['x-file-name'] || '')); } catch (e) { return send(res, 400, { error: e.message }); }
  if (rows.length < 2) return send(res, 400, { error: 'לא נמצאו שורות בקובץ' });
  // שורת הכותרות = השורה הראשונה מתוך 10 הראשונות שיש בה הכי הרבה תאים מלאים
  let h = 0;
  rows.slice(0, 10).forEach((r, i) => { if (r.filter((c) => String(c).trim()).length > rows[h].filter((c) => String(c).trim()).length) h = i; });
  const headers = rows[h].map((c) => String(c).trim());
  const data = rows.slice(h + 1);
  const find = (re) => headers.findIndex((x) => re.test(x));
  const guess = {
    company: find(/חברה|שם לקוח|^לקוח|שם העסק|עסק|company|client/i),
    name: find(/איש קשר|contact/i),
    first: find(/שם פרטי|first/i),
    last: find(/שם משפחה|last/i),
    phones: headers.map((x, i) => (/טלפון|נייד|פלאפון|סלולר|mobile|phone|tel/i.test(x) ? i : -1)).filter((i) => i >= 0),
  };
  if (guess.company < 0) guess.company = find(/שם/);
  send(res, 200, { headers, rows: data, guess });
}, { auth: 'admin' });

// ייבוא: שלב 2 – שמירת אנשי הקשר לפי מיפוי העמודות
route('POST', /^\/api\/admin\/contacts\/import$/, async (req, res) => {
  const b = await readBody(req, 40 * 1024 * 1024).then((x) => JSON.parse(x.toString('utf8')));
  const m = b.map || {};
  const cell = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
  const imported = [];
  let noPhone = 0;
  for (const r of b.rows || []) {
    const phones = [...new Set((m.phones || []).flatMap((i) => cell(r, i).split(/[,;/]| או /)).map(normPhone).filter(Boolean))];
    if (!phones.length) { noPhone++; continue; }
    const name = cell(r, m.name) || [cell(r, m.first), cell(r, m.last)].filter(Boolean).join(' ');
    imported.push({ id: store.newId(), company: cell(r, m.company), name, phones, source: 'import' });
  }
  const manual = db.contacts.filter((c) => c.source !== 'import');
  db.contacts = b.replace === false ? [...db.contacts, ...imported] : [...manual, ...imported];
  reindexContacts(); store.saveContacts();
  send(res, 200, { imported: imported.length, noPhone, total: db.contacts.length });
}, { auth: 'admin' });

route('POST', /^\/api\/admin\/contacts$/, async (req, res) => {
  const b = await readJson(req);
  const phones = [...new Set(String(b.phones || '').split(/[,;\n]/).map(normPhone).filter(Boolean))];
  if (!phones.length) return send(res, 400, { error: 'צריך לפחות מספר טלפון אחד תקין' });
  let c = b.id && db.contacts.find((x) => x.id === b.id);
  if (!c) { c = { id: store.newId(), source: 'manual' }; db.contacts.push(c); }
  Object.assign(c, { company: String(b.company || ''), name: String(b.name || ''), phones });
  reindexContacts(); store.saveContacts();
  send(res, 200, c);
}, { auth: 'admin' });

route('DELETE', /^\/api\/admin\/contacts\/(\w+)$/, (req, res, { params }) => {
  db.contacts = db.contacts.filter((c) => c.id !== params[0]);
  reindexContacts(); store.saveContacts();
  send(res, 200, { ok: true });
}, { auth: 'admin' });

// ---------- ניהול (מנהל בלבד) ----------
route('GET', /^\/api\/admin\/config$/, (req, res) => send(res, 200, { config: adminConfigView(), users: db.users.map(publicUser), instances: instancesStatus() }), { auth: 'admin' });

route('POST', /^\/api\/admin\/config$/, async (req, res) => {
  const b = await readJson(req);
  const c = db.config;
  if (b.companyName !== undefined) c.companyName = String(b.companyName);
  if (b.routeDelaySec !== undefined) c.routeDelaySec = Math.max(0, Math.min(120, Number(b.routeDelaySec) || 0));
  if (b.host) c.host = b.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  if (b.port) c.port = Number(b.port) || 8080;
  if (Array.isArray(b.departments)) {
    c.departments = b.departments.map((d) => ({ id: d.id || store.newId(), name: String(d.name || ''), description: String(d.description || ''), userId: d.userId || null })).filter((d) => d.name);
  }
  if (b.ai) c.ai = { enabled: !!b.ai.enabled, model: b.ai.model || 'claude-opus-5-5', apiKey: unmask(b.ai.apiKey, c.ai.apiKey) || '' };
  if (b.groups) c.groups = { enabled: !!b.groups.enabled, autoReply: !!b.groups.autoReply };
  if (Array.isArray(b.chatRules)) c.chatRules = c.chatRules.filter((x) => b.chatRules.some((y) => y.chatId === x.chatId && y.instanceId === x.instanceId));
  if (Array.isArray(b.ignoredChats)) c.ignoredChats = c.ignoredChats.filter((x) => b.ignoredChats.some((y) => y.chatId === x.chatId && y.instanceId === x.instanceId));
  if (b.autoReply) c.autoReply = { enabled: !!b.autoReply.enabled, routed: String(b.autoReply.routed || ''), unknown: String(b.autoReply.unknown || '') };
  store.saveConfig();
  send(res, 200, { config: adminConfigView() });
}, { auth: 'admin' });

route('POST', /^\/api\/admin\/instances$/, async (req, res) => {
  const b = await readJson(req);
  let inst = b.id && instById(b.id);
  if (!inst) { inst = { id: store.newId() }; db.config.instances.push(inst); }
  Object.assign(inst, {
    name: String(b.name || 'וואטסאפ'),
    idInstance: String(b.idInstance || '').trim(),
    token: unmask(String(b.token || '').trim(), inst.token),
    apiUrl: String(b.apiUrl || '').trim() || 'https://api.green-api.com',
    mediaUrl: String(b.mediaUrl || '').trim() || 'https://media.green-api.com',
    enabled: b.enabled !== false,
  });
  store.saveConfig();
  let state = 'unknown', settingsOk = false, error = '';
  try { state = (await ga.getStateInstance(inst))?.stateInstance || 'unknown'; } catch (e) { error = e.message; }
  if (!error) { try { await ga.enableNotifications(inst); settingsOk = true; } catch (e) { error = e.message; } }
  instState[inst.id] = error ? 'error: ' + error.slice(0, 120) : state;
  const ctl = pollers.get(inst.id); if (ctl) { ctl.stop = true; pollers.delete(inst.id); }
  startPollers();
  emitAll({ type: 'instances', list: instancesStatus() });
  send(res, 200, { id: inst.id, state, settingsOk, error });
}, { auth: 'admin' });

route('DELETE', /^\/api\/admin\/instances\/(\w+)$/, (req, res, { params }) => {
  db.config.instances = db.config.instances.filter((i) => i.id !== params[0]);
  store.saveConfig(); startPollers();
  send(res, 200, { ok: true });
}, { auth: 'admin' });

route('POST', /^\/api\/admin\/users$/, async (req, res, { user }) => {
  const b = await readJson(req);
  const username = String(b.username || '').trim().toLowerCase();
  if (!username) return send(res, 400, { error: 'חסר שם משתמש' });
  if (db.users.some((u) => u.username === username && u.id !== b.id)) return send(res, 400, { error: 'שם המשתמש תפוס' });
  let u = b.id && userById(b.id);
  if (!u) {
    if (!b.password || String(b.password).length < 4) return send(res, 400, { error: 'סיסמה של 4 תווים לפחות' });
    u = { id: store.newId() };
    db.users.push(u);
  }
  if (u.id === user.id && b.role !== 'admin') return send(res, 400, { error: 'אי אפשר להוריד לעצמך הרשאת מנהל' });
  Object.assign(u, { name: String(b.name || username), username, role: b.role === 'admin' ? 'admin' : 'agent', active: b.active !== false, phone: normPhone(b.phone) });
  if (b.password) Object.assign(u, hashPassword(b.password));
  store.saveUsers();
  send(res, 200, publicUser(u));
}, { auth: 'admin' });

route('POST', /^\/api\/admin\/test-ai$/, async (req, res) => {
  const b = await readJson(req);
  const r = await routeTicket(db.config, { customerName: 'בדיקה', texts: [String(b.text || 'שלום, יש לי בעיה עם המרכזייה')] });
  send(res, 200, { ...r, departmentName: depById(r.departmentId)?.name || 'לא זוהה' });
}, { auth: 'admin' });

// =====================================================================
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(u.pathname);
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  const user = getSessionUser(req);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    if (r.auth !== 'none' && !user) return send(res, 401, { error: 'צריך להתחבר' });
    if (r.auth === 'admin' && user.role !== 'admin') return send(res, 403, { error: 'למנהל בלבד' });
    try { return await r.handler(req, res, { user, params: m.slice(1), query: u.searchParams }); }
    catch (e) { log('api error', pathname, e.message); return send(res, 500, { error: e.message }); }
  }
  send(res, 404, { error: 'not found' });
});

// =====================================================================
// עדכון אוטומטי מ-GitHub (כמו התוכנה הקודמת): מוריד, מחליף קבצים, ומפעיל מחדש
// =====================================================================
const UPDATE_BASE = process.env.HD_UPDATE_URL || 'https://raw.githubusercontent.com/yahelsos71-beep/whatsapp-multi/main/helpdesk/';
async function checkUpdate() {
  try {
    const get = async (f) => {
      const r = await fetch(UPDATE_BASE + f + '?t=' + now(), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(r.status + ' ' + f);
      return Buffer.from(await r.arrayBuffer());
    };
    const remote = JSON.parse((await get('version.json')).toString('utf8'));
    if (!remote.version || remote.version <= VERSION) return;
    const files = {};
    for (const [f, hash] of Object.entries(remote.files || {})) {
      if (!/^[\w.-]+(\/[\w.-]+)*$/.test(f) || f.includes('..')) throw new Error('bad path ' + f);
      const buf = await get(f);
      if (crypto.createHash('sha256').update(buf).digest('hex') !== hash) throw new Error('hash mismatch ' + f);
      files[f] = buf;
    }
    for (const [f, buf] of Object.entries(files)) {
      const full = path.join(APP_DIR, f);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
    }
    fs.writeFileSync(path.join(APP_DIR, 'version.json'), JSON.stringify(remote, null, 2));
    log(`updated to v${remote.version} – restarting`);
    emitAll({ type: 'restarting', version: remote.version });
    store.flushAll();
    setTimeout(() => process.exit(3), 1500);
  } catch (e) { log('update check failed:', e.message); }
}

// =====================================================================
process.on('SIGINT', () => { store.flushAll(); process.exit(0); });
process.on('SIGTERM', () => { store.flushAll(); process.exit(0); });
process.on('uncaughtException', (e) => log('uncaught', e.stack || e.message));
process.on('unhandledRejection', (e) => log('unhandled', e && (e.stack || e.message)));

const PORT = Number(process.env.HD_PORT) || db.config.port || 8080;
const HOST = process.env.HD_HOST || db.config.host || '127.0.0.1';
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { log(`Port ${PORT} is busy - the server is probably already running.`); process.exit(10); }
  log('server error', e.message); process.exit(1);
});
server.listen(PORT, HOST, () => {
  log(`WhatsApp Helpdesk v${VERSION} running: http://localhost:${PORT}${HOST === '0.0.0.0' ? ' (open to the office network)' : ' (this server only)'}`);
  startPollers();
  for (const t of db.tickets) if (t.status === 'routing') scheduleRouting(t);
  refreshStates();
  setInterval(refreshStates, 2 * 60 * 1000);
  if (!process.env.HD_NO_UPDATE) { setTimeout(checkUpdate, 30 * 1000); setInterval(checkUpdate, 60 * 60 * 1000); }
});

// מוקד וואטסאפ – שרת
// כל ההודעות מכל מספרי המשרד מגיעות לכאן דרך Green API, נפתחות כקריאות,
// מנותבות לנציג בעזרת Claude, וכל נציג רואה ועונה רק לקריאות שלו.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');
const ga = require('./lib/greenapi');
const { routeTicket, intake } = require('./lib/ai');
const { parseSheet, fixMojibake } = require('./lib/sheet');

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
// בקבוצה משותפת עם עובד (חיים+חני): התור עובר למי שצריך לענות – מי שכתב, הקריאה עוברת לשני
function pinnedPeer(t, fromUserId) {
  const r = t.isGroup && ruleFor(t.instanceId, t.chatId);
  if (!r) return null;
  const emp = userById(r.userId);
  const boss = userById(r.ownerId) || admins()[0];
  if (!emp || !boss || emp.id === boss.id) return null;
  return fromUserId === emp.id ? boss : emp;
}
function handTo(t, peer) {
  if (!peer) return false;
  const old = t.assigneeId;
  t.assigneeId = peer.id;
  const dep = db.config.departments.find((d) => d.userId === peer.id);
  t.departmentId = dep ? dep.id : null;
  if (old && old !== peer.id && userById(old)?.role !== 'admin') sendTo(old, { type: 'remove', id: t.id });
  t.awaiting = true; t.lastInAt = now(); t.snoozeUntil = null;
  return old !== peer.id;
}
const staffByPhone = (phone) => phone && db.users.find((u) => u.active !== false && u.phone && u.phone === phone);
const isIgnored = (instanceId, chatId) => (db.config.ignoredChats || []).some((x) => x.instanceId === instanceId && x.chatId === chatId);
const ignoredByName = (name) => !!name && (db.config.ignoreGroupNames || []).some((w) => w && String(name).includes(w));
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
    contact: c ? { id: c.id, name: c.name || '', company: c.company || '', phones: c.phones } : null,
    assigneeName: a ? a.name : '',
    departmentName: d ? d.name : '',
    instanceName: inst ? inst.name : '',
    lastText: last ? (last.text || { image: '📷 תמונה', video: '🎬 וידאו', file: '📎 קובץ', audio: '🎤 הקלטה', location: '📍 מיקום' }[last.type] || '') : '',
    lastDir: last ? last.dir : '',
    count: msgs.length,
  };
}

function closeIgnoredGroups() {
  for (const t of db.tickets) {
    if (t.status !== 'closed' && t.isGroup && ignoredByName(t.customerName)) {
      t.status = 'closed'; t.closedAt = now(); t.awaiting = false;
      note(t, '🔕 נסגרה – קבוצה שמתעלמים ממנה');
      emitTicket(t);
    }
  }
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
const routingBusy = new Map(); // ticketId -> rerun requested
function clearRouting(t) { clearTimeout(routingTimers.get(t.id)); routingTimers.delete(t.id); }
// delayMs לא מוגדר = ההמתנה הראשונה (routeDelaySec מרגע פתיחת הקריאה)
function scheduleRouting(t, delayMs, opts = {}) {
  clearRouting(t);
  const delay = delayMs ?? Math.max(0, (db.config.routeDelaySec ?? 15) * 1000 - (now() - t.createdAt));
  routingTimers.set(t.id, setTimeout(() => { routingTimers.delete(t.id); runRouting(t, opts); }, delay));
}
async function runRouting(t, opts) {
  if (routingBusy.has(t.id)) { routingBusy.set(t.id, true); return; } // כבר רץ – נריץ שוב בסוף
  routingBusy.set(t.id, false);
  try { await doRouting(t, opts); } catch (e) { log('routing error', e.message); }
  const again = routingBusy.get(t.id);
  routingBusy.delete(t.id);
  if (again && t.status === 'routing') scheduleRouting(t, 1000);
}

// ---------- שעות פעילות ----------
function isOpenNow(at = new Date()) {
  const h = db.config.hours;
  if (!h || !h.enabled) return true;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: h.tz || 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map((x) => [x.type, x.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const toM = (s) => { const [a, b] = String(s || '0:0').split(':').map(Number); return a * 60 + (b || 0); };
  return (h.days || []).includes(day) && mins >= toM(h.start) && mins < toM(h.end);
}
const offHoursSent = new Map(); // chatKey -> ts (פעם אחת בכמה שעות לכל לקוח)
// ---------- הבוט שותק אחרי שעובד ענה ----------
function recentHumanReply(instanceId, chatId) {
  let best = null;
  for (const x of db.tickets) {
    if (x.instanceId !== instanceId || x.chatId !== chatId || !x.lastOutAt) continue;
    if (!best || x.lastOutAt > best.lastOutAt) best = x;
  }
  if (!best) return null;
  const last = [...store.messages(best.id)].reverse().find((m) => m.dir === 'out' && !m.auto);
  return { at: best.lastOutAt, userId: last && last.byUserId ? last.byUserId : best.assigneeId };
}
const isQuiet = (instanceId, chatId) => {
  const r = recentHumanReply(instanceId, chatId);
  return r && now() - r.at < (db.config.quietMinutes ?? 30) * 60000 ? r : null;
};

const useIntake = (t) => !t.isGroup && db.config.ai.enabled && db.config.ai.apiKey && db.config.ai.intake !== false;
const whoIs = (t) => {
  const ct = !t.isGroup && contactFor(t.phone);
  return t.isGroup ? 'WhatsApp group: ' + t.customerName : ct ? `${ct.name || t.customerName}${ct.company ? ' (company: ' + ct.company + ')' : ''}` : t.customerName;
};

// ---------- ניתוב לפי איש קשר (למשל: דויד 05X-XXXXXXX → נועה) ----------
const groupMembers = new Map(); // chatId -> { at, phones:Set }
async function membersOf(t) {
  const c = groupMembers.get(t.chatId);
  if (c && now() - c.at < 3600e3) return c.phones;
  const inst = instById(t.instanceId);
  let phones = new Set();
  try {
    const g = await ga.getGroupData(inst, t.chatId);
    phones = new Set((g && g.participants || []).map((p) => String(p.id || '').split('@')[0]));
  } catch (e) { log('getGroupData failed', e.message); }
  groupMembers.set(t.chatId, { at: now(), phones });
  return phones;
}
async function personRuleFor(t) {
  const rules = (db.config.personRules || []).filter((r) => r.phone && userById(r.userId)?.active !== false);
  if (!rules.length) return null;
  if (!t.isGroup) return rules.find((r) => r.phone === t.phone) || null;
  const senders = new Set(store.messages(t.id).map((m) => m.senderPhone).filter(Boolean));
  const bySender = rules.find((r) => senders.has(r.phone));
  if (bySender) return bySender;
  const members = await membersOf(t);
  return rules.find((r) => members.has(r.phone)) || null;
}

async function doRouting(t, { force = false } = {}) {
  if (t.status !== 'routing') return;
  if (!t.aiTurns) {
    const pr = await personRuleFor(t);
    if (pr && t.status === 'routing') {
      const u = userById(pr.userId);
      const dep = db.config.departments.find((d) => d.userId === u.id);
      return finishRouting(t, dep ? dep.id : null, `${t.isGroup ? 'בקבוצה יש את ' : 'פנייה מ'}${pr.name || pr.phone} → ${u.name}`, '', '', { silent: !!t.isGroup || !!t.silent, assigneeId: u.id });
    }
  }
  if (!useIntake(t) || t.silent) {
    // ניתוב רגיל (קבוצות / בלי עוזר AI / מחוץ לשעות): סיווג אחד, ובלי לכתוב ללקוח כשהקריאה שקטה
    const texts = store.messages(t.id).filter((m) => m.dir === 'in').map((m) => (m.senderName ? m.senderName + ': ' : '') + (m.text || `[${m.type}]`)).slice(0, 10);
    const r = await routeTicket(db.config, { customerName: whoIs(t), texts });
    return finishRouting(t, r.departmentId, r.reason, '', '', { silent: !!t.silent });
  }
  // עוזר AI: מתכתב עם הלקוח עד שברור לאן לנתב
  const transcript = store.messages(t.id).filter((m) => m.dir !== 'note').slice(-30).map((m) => {
    const who = m.dir === 'in' ? 'לקוח' : m.aiBot ? 'עוזר' : 'נציג';
    return `${who}: ${m.text || `[${{ image: 'תמונה', video: 'וידאו', audio: 'הקלטה קולית', file: 'קובץ', location: 'מיקום' }[m.type] || m.type}]`}`;
  }).join('\n');
  const maxTurns = Math.max(0, Math.min(6, Number(db.config.ai.maxQuestions ?? 3)));
  const turns = t.aiTurns || 0;
  const r = await intake(db.config, { customerName: whoIs(t), transcript, turns, maxTurns, force });
  if (t.status !== 'routing') return; // בינתיים עובד לקח את השיחה
  if (r.action === 'ask' && r.reply) {
    t.aiTurns = turns + 1;
    t.aiGuess = r.departmentId;
    try { await sendText(t, r.reply, null, { auto: true, byName: '🤖 עוזר AI', aiBot: true }); }
    catch (e) { note(t, '⚠️ שאלת העוזר לא נשלחה: ' + e.message); return finishRouting(t, r.departmentId, 'השליחה נכשלה', '', ''); }
    // אם הלקוח לא עונה – מנתבים לפי מה שידוע
    scheduleRouting(t, Math.max(1, Number(db.config.ai.waitMinutes ?? 10)) * 60000, { force: true });
    emitTicket(t);
    return;
  }
  const dep = r.departmentId || (force ? t.aiGuess : null) || null;
  const reason = r.error ? `(${r.error})` : force && !r.reply ? 'הלקוח לא ענה – נותב לפי מה שידוע' : '';
  return finishRouting(t, dep, reason, r.summary, r.error ? '' : r.reply);
}

async function finishRouting(t, departmentId, reason, summary, aiReply, { silent = false, assigneeId = null } = {}) {
  clearRouting(t);
  const dep = departmentId ? depById(departmentId) : null;
  let assignee = (assigneeId && userById(assigneeId)) || (dep && userById(dep.userId));
  if (!assignee || assignee.active === false) assignee = admins()[0] || null;
  t.departmentId = dep ? dep.id : null;
  t.assigneeId = assignee ? assignee.id : null;
  t.aiReason = reason;
  t.aiSummary = summary || '';
  t.status = 'open';
  note(t, (dep ? `🤖 נותב ל${assignee ? assignee.name : '?'} (${dep.name})` : `🤖 לא זוהתה מחלקה – הועבר ל${assignee ? assignee.name : 'מנהל'}`) + (reason ? ` – ${reason}` : ''));
  if (summary) note(t, '📝 סיכום הפנייה: ' + summary);
  emitTicket(t, { sound: 'new' });
  log(`ticket #${t.id} routed -> ${assignee && assignee.name} (${dep ? dep.name : 'unknown'})`);

  const ar = db.config.autoReply;
  if (silent || !ar.enabled || (t.isGroup && !db.config.groups.autoReply)) return;
  let text = aiReply;
  if (!text) {
    const tpl = dep ? ar.routed : ar.unknown;
    const dn = displayName(t);
    const name = dn && !/^[\d+\s-]+$/.test(dn) && !t.isGroup ? ' ' + dn.split(' ')[0] : '';
    text = tpl.replace(/\{name\}/g, name).replace(/\{agent\}/g, dep ? dep.name : '').replace(/\{department\}/g, dep ? dep.name : '').replace(/\{company\}/g, db.config.companyName || '');
  }
  try { await sendText(t, text, null, { auto: true, byName: aiReply ? '🤖 עוזר AI' : 'מענה אוטומטי', aiBot: !!aiReply }); }
  catch (e) { note(t, '⚠️ המענה האוטומטי לא נשלח: ' + e.message); }
}

// =====================================================================
// שליחה
// =====================================================================
const sentIds = new Set();
async function sendText(t, text, user, { auto = false, byName = null, aiBot = false } = {}) {
  const inst = instById(t.instanceId);
  if (!inst) throw new Error('המספר של הקריאה לא מוגדר');
  const r = await ga.sendMessage(inst, t.chatId, text);
  if (r && r.idMessage) sentIds.add(r.idMessage);
  const msg = addMessage(t, { dir: 'out', type: 'text', text, idMessage: r && r.idMessage, byUserId: user ? user.id : null, byName: user ? user.name : byName || 'מענה אוטומטי', auto, aiBot, status: 'sent' });
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
  if (isGroup && ignoredByName(sd.chatName)) return; // קבוצות שמתעלמים מהן לפי שם (פורום מתקינים, מתח נמוך...)
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
    } else if (!isGroup && isQuiet(inst.id, chatId)) {
      // עובד ענה ללקוח לאחרונה – בלי בוט; ישר לעובד שענה
      const q = isQuiet(inst.id, chatId);
      const who = (q.userId && userById(q.userId)?.active !== false && userById(q.userId)) || admins()[0] || null;
      t = createTicket(inst, chatId, name, { status: 'open', assigneeId: who ? who.id : null });
      const dep = who && db.config.departments.find((d) => d.userId === who.id);
      if (dep) t.departmentId = dep.id;
      note(t, `↩️ הלקוח חזר ${Math.max(1, Math.round((now() - q.at) / 60000))} דק׳ אחרי התשובה האחרונה – הועבר ישר ל${who ? who.name : 'מנהל'}, בלי בוט`);
    } else {
      t = createTicket(inst, chatId, name);
      if (!isGroup && !isOpenNow()) { t.silent = true; note(t, '🌙 נפתחה מחוץ לשעות הפעילות – בלי שיחה עם העוזר'); }
    }
    log(`new ticket #${t.id} from ${t.phone} (${inst.name})`);
  }
  // מחוץ לשעות הפעילות: הודעת "המשרד סגור" – פעם אחת ב-12 שעות ללקוח, ולא אם עובד ענה לו לאחרונה
  if (!isGroup && !isOpenNow() && db.config.hours.message && !isQuiet(inst.id, chatId) && !(pinned && pinned.active !== false)) {
    const key = inst.id + '|' + chatId;
    if (now() - (offHoursSent.get(key) || 0) > 12 * 3600e3) {
      offHoursSent.set(key, now());
      const dn = displayName(t);
      const nm = dn && !/^[\d+\s-]+$/.test(dn) ? ' ' + dn.split(' ')[0] : '';
      const tick = t;
      setTimeout(() => sendText(tick, db.config.hours.message.replace(/\{name\}/g, nm), null, { auto: true, byName: '🌙 מחוץ לשעות' }).catch((e) => note(tick, '⚠️ הודעת "המשרד סגור" לא נשלחה: ' + e.message)), 1500);
    }
  }
  if (isGroup && sd.chatName && t.customerName !== sd.chatName) t.customerName = sd.chatName;
  const senderPhone = String(sd.sender || '').split('@')[0];
  const staff = isGroup && staffByPhone(senderPhone);
  addMessage(t, { ...m, dir: 'in', ts, idMessage: body.idMessage, ...(isGroup ? { senderName: staff ? staff.name : sd.senderContactName || sd.senderName || senderPhone, senderPhone, staff: !!staff } : {}) });
  const peer = pinnedPeer(t, staff ? staff.id : null);
  if (peer) {
    // קבוצה משותפת עם עובד: מי שכתב – התור עובר לשני (חני כתבה → לחיים; חיים כתב → לחני)
    const changed = handTo(t, peer);
    emitTicket(t, { sound: changed ? 'new' : 'msg' });
    return;
  }
  if (staff && staff.id === t.assigneeId) {
    // העובד עצמו ענה בקבוצה מהטלפון שלו – נחשב כתשובה
    t.awaiting = false; t.lastOutAt = ts;
    emitTicket(t);
    return;
  }
  t.awaiting = true;
  t.lastInAt = ts;
  if (t.snoozeUntil) { t.snoozeUntil = null; note(t, '▶ הלקוח כתב – הקריאה חזרה מהשהיה'); }
  emitTicket(t, { sound: isNew ? null : 'msg' });
  if (t.status === 'routing') scheduleRouting(t, t.aiTurns ? Math.max(2, Number(db.config.ai.replyDelaySec ?? 8)) * 1000 : undefined);
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
    ai: { enabled: c.ai.enabled, model: c.ai.model, apiKey: mask(c.ai.apiKey), intake: c.ai.intake !== false, maxQuestions: c.ai.maxQuestions ?? 3, waitMinutes: c.ai.waitMinutes ?? 10, replyDelaySec: c.ai.replyDelaySec ?? 8 },
    autoReply: c.autoReply,
    groups: c.groups,
    hours: c.hours,
    quietMinutes: c.quietMinutes ?? 30,
    ignoredChats: c.ignoredChats,
    ignoreGroupNames: c.ignoreGroupNames || [],
    personRules: c.personRules || [],
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

route('GET', /^\/api\/tickets\/(\d+)\/wa-history$/, async (req, res, { user, params, query }) => {
  const t = visibleTicket(user, params[0]);
  if (!t) return send(res, 404, { error: 'לא נמצא' });
  const inst = instById(t.instanceId);
  if (!inst) return send(res, 400, { error: 'המספר של הקריאה לא מוגדר' });
  const count = Math.max(20, Math.min(1000, Number(query.get('count')) || 100));
  try {
    const list = await ga.getChatHistory(inst, t.chatId, count);
    const items = (Array.isArray(list) ? list : []).map(ga.parseHistoryItem).sort((a, b) => a.ts - b.ts);
    send(res, 200, { items, count, more: items.length >= count });
  } catch (e) { send(res, 502, { error: 'לא הצלחתי למשוך היסטוריה מ-Green API: ' + e.message }); }
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
  if (t.status === 'routing') {
    // עובד ענה בזמן שהעוזר מתכתב – העובד לוקח את השיחה
    clearRouting(t);
    t.status = 'open';
    if (!t.assigneeId) t.assigneeId = user.id;
    note(t, `👤 ${user.name} לקח/ה את השיחה מהעוזר`);
  }
  try {
    const msg = await sendText(t, text, user);
    const peer = pinnedPeer(t, user.id);
    if (peer && peer.id !== user.id) { const changed = handTo(t, peer); emitTicket(t, { sound: changed ? 'new' : 'msg' }); }
    send(res, 200, msg);
  } catch (e) { send(res, 502, { error: 'השליחה נכשלה: ' + e.message }); }
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
  if (t.status === 'routing') { t.status = 'open'; clearRouting(t); }
  note(t, `↪️ ${user.name} העביר/ה את השיחה ${from ? 'מ' + from.name + ' ' : ''}ל${to.name}${b.note ? ': ' + b.note : ''}`);
  if (oldAssignee && oldAssignee !== to.id && userById(oldAssignee)?.role !== 'admin') sendTo(oldAssignee, { type: 'remove', id: t.id });
  emitTicket(t, { sound: 'new' });
  send(res, 200, summary(t));
});

// השהיה: הקריאה עוברת לרשימת "מושהות" עד הזמן שנבחר, ואז תזכורת לנציג. until=null מבטל
route('POST', /^\/api\/tickets\/(\d+)\/snooze$/, async (req, res, { user, params }) => {
  const t = myTicket(user, params[0], res); if (!t) return;
  if (t.status === 'closed') return send(res, 400, { error: 'הקריאה סגורה' });
  const b = await readJson(req);
  const until = Number(b.until) || 0;
  if (until) {
    if (until < now() + 30000) return send(res, 400, { error: 'בחר זמן עתידי' });
    if (t.status === 'routing') { t.status = 'open'; clearRouting(t); if (!t.assigneeId) t.assigneeId = user.id; }
    t.snoozeUntil = until; t.snoozedBy = user.id; t.awaiting = false;
    note(t, `⏸ ${user.name} השהה/תה את הקריאה עד ${new Date(until).toLocaleString('he-IL', { timeZone: db.config.hours?.tz || 'Asia/Jerusalem', weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
  } else {
    t.snoozeUntil = null;
    note(t, `▶ ${user.name} החזיר/ה את הקריאה מהשהיה`);
  }
  emitTicket(t);
  send(res, 200, summary(t));
});

// בדיקה כל 20 שניות: קריאות מושהות שהגיע זמנן – חוזרות לרשימה + תזכורת קופצת לנציג
setInterval(() => {
  for (const t of db.tickets) {
    if (t.status === 'closed' || !t.snoozeUntil || t.snoozeUntil > now()) continue;
    t.snoozeUntil = null;
    t.reminderAt = now();
    note(t, '⏰ הגיע זמן התזכורת');
    emitTicket(t, { sound: 'new' });
    if (t.assigneeId) sendTo(t.assigneeId, { type: 'reminder', ticket: summary(t) });
  }
}, 20000);

route('POST', /^\/api\/tickets\/(\d+)\/close$/, (req, res, { user, params }) => {
  const t = myTicket(user, params[0], res); if (!t) return;
  t.status = 'closed'; t.closedAt = now(); t.closedBy = user.id; t.awaiting = false; t.snoozeUntil = null;
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
    db.config.chatRules.push({ instanceId: t.instanceId, chatId: t.chatId, name: t.customerName, isGroup: !!t.isGroup, userId: to.id, ownerId: user.id });
    note(t, `📌 ${user.name} קיבע/ה את ${t.isGroup ? 'הקבוצה' : 'הצ\'אט'} ל${to.name}`);
    if (t.status !== 'closed' && t.assigneeId !== to.id) {
      const old = t.assigneeId;
      t.assigneeId = to.id;
      if (t.status === 'routing') { t.status = 'open'; clearRouting(t); }
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
// "קריאה לעובד" / "פנייה למנהל": הודעה בקבוצה המשותפת (חיים+חני). התור עובר לצד השני
function taskTargetsFor(user) {
  return db.config.chatRules.filter((r) => r.isGroup && userById(r.userId)?.active !== false).map((r) => {
    const emp = userById(r.userId);
    const boss = userById(r.ownerId) || admins()[0];
    let target = null;
    if (user.id === emp.id) target = boss; // העובד כותב למנהל
    else if (user.role === 'admin' || (boss && user.id === boss.id)) target = emp; // המנהל כותב לעובד
    return target && target.id !== user.id ? { key: r.instanceId + '|' + r.chatId, userId: target.id, userName: target.name, group: r.name, instanceName: instById(r.instanceId)?.name || '' } : null;
  }).filter(Boolean);
}
route('GET', /^\/api\/tasks\/targets$/, (req, res, { user }) => send(res, 200, taskTargetsFor(user)));
route('POST', /^\/api\/tasks$/, async (req, res, { user }) => {
  const b = await readJson(req);
  const text = String(b.text || '').trim();
  if (!text) return send(res, 400, { error: 'כתוב מה לשלוח' });
  const tg = taskTargetsFor(user).find((x) => x.key === b.key || (!b.key && x.userId === b.userId));
  if (!tg) return send(res, 400, { error: 'לא הוגדרה קבוצה משותפת' });
  const [instanceId, chatId] = tg.key.split('|');
  const r = ruleFor(instanceId, chatId);
  const inst = instById(instanceId);
  const target = userById(tg.userId);
  if (!r || !inst || !target) return send(res, 400, { error: 'לא הוגדרה קבוצה משותפת' });
  let t = openTicketFor(inst.id, chatId);
  if (!t) t = createTicket(inst, chatId, r.name, { status: 'open', assigneeId: target.id });
  t.isGroup = true;
  note(t, `📋 ${user.name} פתח/ה פנייה ל${target.name}`);
  try { await sendText(t, text, user); } catch (e) { return send(res, 502, { error: 'השליחה לקבוצה נכשלה: ' + e.message }); }
  const changed = handTo(t, target); // מחכה לטיפול של הצד השני
  emitTicket(t, { sound: 'new' });
  if (changed && user.role !== 'admin') sendTo(user.id, { type: 'remove', id: t.id });
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
  const findNot = (re, not) => headers.findIndex((x) => re.test(x) && !not.test(x));
  const guess = {
    company: find(/חברה|שם לקוח|^לקוח|שם העסק|עסק|company|client|organization name/i),
    name: findNot(/איש קשר|contact|^name$|^שם$/i, /phonetic|label/i),
    first: findNot(/שם פרטי|first/i, /phonetic/i),
    middle: findNot(/שם אמצעי|middle/i, /phonetic/i),
    last: findNot(/שם משפחה|last/i, /phonetic/i),
    phones: headers.map((x, i) => (/טלפון|נייד|פלאפון|סלולר|mobile|phone|tel/i.test(x) && !/label|type|סוג|phonetic/i.test(x) ? i : -1)).filter((i) => i >= 0),
  };
  if (guess.company < 0 && guess.name < 0 && guess.first < 0) guess.company = find(/שם/);
  if (guess.company >= 0 && guess.company === guess.name) guess.company = -1;
  send(res, 200, { headers, rows: data, guess });
}, { auth: 'admin' });

// ייבוא: שלב 2 – שמירת אנשי הקשר לפי מיפוי העמודות
// mode: 'merge' = מוסיף רק מספרים חדשים (מדלג על מה שכבר קיים); 'replace' = מחליף את הייבוא הקודם
route('POST', /^\/api\/admin\/contacts\/import$/, async (req, res) => {
  const b = await readBody(req, 40 * 1024 * 1024).then((x) => JSON.parse(x.toString('utf8')));
  const m = b.map || {};
  const mode = b.mode === 'replace' ? 'replace' : 'merge';
  const cell = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
  const base = mode === 'replace' ? db.contacts.filter((c) => c.source !== 'import') : db.contacts;
  const existing = new Set(base.flatMap((c) => c.phones || []));
  const seen = new Map(); // phone -> contact שנוסף עכשיו (לאיחוד כפולים בתוך הקובץ)
  const added = [];
  let noPhone = 0, skippedExisting = 0, mergedDupes = 0;
  for (const r of b.rows || []) {
    const phones = [...new Set((m.phones || []).flatMap((i) => cell(r, i).split(/:::|[,;/]| או /)).map(normPhone).filter(Boolean))];
    if (!phones.length) { noPhone++; continue; }
    const name = cell(r, m.name) || [cell(r, m.first), cell(r, m.middle), cell(r, m.last)].filter(Boolean).join(' ').replace(/\s+/g, ' ');
    const company = cell(r, m.company);
    const fresh = phones.filter((p) => !existing.has(p));
    if (!fresh.length) { skippedExisting++; continue; }
    const dup = fresh.map((p) => seen.get(p)).find(Boolean);
    if (dup) { // אותו מספר כבר הופיע בקובץ – מאחדים
      for (const p of fresh) if (!dup.phones.includes(p)) { dup.phones.push(p); seen.set(p, dup); }
      if (!dup.name && name) dup.name = name;
      if (!dup.company && company) dup.company = company;
      mergedDupes++; continue;
    }
    const c = { id: store.newId(), company, name, phones: fresh, source: 'import' };
    for (const p of fresh) seen.set(p, c);
    added.push(c);
  }
  db.contacts = [...base, ...added];
  reindexContacts(); store.saveContacts();
  for (const t of db.tickets) if (t.status !== 'closed' && contactByPhone.has(t.phone)) emitTicket(t);
  send(res, 200, { imported: added.length, skippedExisting, mergedDupes, noPhone, total: db.contacts.length, mode });
}, { auth: 'admin' });

route('POST', /^\/api\/contacts$/, async (req, res) => saveContact(req, res));
async function saveContact(req, res) {
  const b = await readJson(req);
  const phones = [...new Set(String(b.phones || '').split(/[,;\n]/).map(normPhone).filter(Boolean))];
  if (!phones.length) return send(res, 400, { error: 'צריך לפחות מספר טלפון אחד תקין' });
  let c = b.id && db.contacts.find((x) => x.id === b.id);
  if (!c) { c = { id: store.newId(), source: 'manual' }; db.contacts.push(c); }
  Object.assign(c, { company: String(b.company || ''), name: String(b.name || ''), phones });
  reindexContacts(); store.saveContacts();
  // רענון הקריאות הפתוחות של הלקוח אצל מי שרואה אותן
  for (const t of db.tickets) if (t.status !== 'closed' && phones.includes(t.phone)) emitTicket(t);
  send(res, 200, c);
}
route('POST', /^\/api\/admin\/contacts$/, async (req, res) => saveContact(req, res), { auth: 'admin' });

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
    c.departments = b.departments.map((d) => ({ id: d.id || store.newId(), name: String(d.name || ''), description: String(d.description || ''), questions: String(d.questions || ''), userId: d.userId || null })).filter((d) => d.name);
  }
  if (b.ai) c.ai = {
    enabled: !!b.ai.enabled, model: b.ai.model || 'claude-opus-5-5', apiKey: unmask(b.ai.apiKey, c.ai.apiKey) || '',
    intake: b.ai.intake !== false,
    maxQuestions: Math.max(0, Math.min(6, Number(b.ai.maxQuestions ?? 3))),
    waitMinutes: Math.max(1, Math.min(120, Number(b.ai.waitMinutes ?? 10))),
    replyDelaySec: Math.max(2, Math.min(60, Number(b.ai.replyDelaySec ?? 8))),
  };
  if (b.hours) c.hours = {
    enabled: !!b.hours.enabled, tz: c.hours.tz || 'Asia/Jerusalem',
    days: (Array.isArray(b.hours.days) ? b.hours.days : []).map(Number).filter((x) => x >= 0 && x <= 6),
    start: /^\d{1,2}:\d{2}$/.test(b.hours.start) ? b.hours.start : c.hours.start,
    end: /^\d{1,2}:\d{2}$/.test(b.hours.end) ? b.hours.end : c.hours.end,
    message: String(b.hours.message ?? c.hours.message),
  };
  if (b.quietMinutes !== undefined) c.quietMinutes = Math.max(0, Math.min(600, Number(b.quietMinutes) || 0));
  if (b.groups) c.groups = { enabled: !!b.groups.enabled, autoReply: !!b.groups.autoReply };
  if (Array.isArray(b.ignoreGroupNames)) {
    c.ignoreGroupNames = b.ignoreGroupNames.map((x) => String(x).trim()).filter(Boolean);
    closeIgnoredGroups();
  }
  if (Array.isArray(b.personRules)) {
    c.personRules = b.personRules.map((r) => ({ phone: normPhone(r.phone), name: String(r.name || '').trim(), userId: r.userId || null })).filter((r) => r.phone && r.userId);
    groupMembers.clear();
  }
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

// דשבורד למנהל: מה פתוח עכשיו + כמה כל עובד סגר בתקופה
route('GET', /^\/api\/admin\/stats$/, (req, res, { query }) => {
  const period = query.get('period') || 'today';
  const d = new Date();
  const start = period === 'today' ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    : period === 'week' ? now() - 7 * 864e5 : period === 'month' ? now() - 30 * 864e5 : 0;
  const open = db.tickets.filter((t) => t.status !== 'closed');
  const waiting = open.filter((t) => t.awaiting && t.status !== 'routing');
  const oldest = waiting.reduce((m, t) => Math.min(m, t.lastInAt || t.updatedAt), Infinity);
  const people = db.users.filter((u) => u.active !== false);
  const nowByUser = people.map((u) => {
    const mine = open.filter((t) => t.assigneeId === u.id && !t.snoozeUntil);
    const snoozed = open.filter((t) => t.assigneeId === u.id && t.snoozeUntil).length;
    const w = mine.filter((t) => t.awaiting);
    return { id: u.id, name: u.name, open: mine.length, snoozed, waiting: w.length, oldestWaitMs: w.length ? now() - Math.min(...w.map((t) => t.lastInAt || t.updatedAt)) : 0 };
  });
  const closed = db.tickets.filter((t) => t.status === 'closed' && (t.closedAt || 0) >= start).slice(-3000);
  const firstResponse = (t) => {
    const msgs = store.messages(t.id);
    const firstIn = msgs.find((m) => m.dir === 'in');
    if (!firstIn) return null;
    const reply = msgs.find((m) => m.dir === 'out' && !m.auto && m.ts >= firstIn.ts);
    return reply ? reply.ts - firstIn.ts : null;
  };
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const closedByUser = people.map((u) => {
    const mine = closed.filter((t) => t.closedBy === u.id);
    return {
      id: u.id, name: u.name, closed: mine.length,
      avgHandleMs: avg(mine.map((t) => t.closedAt - t.createdAt)),
      avgFirstResponseMs: avg(mine.map(firstResponse).filter((x) => x != null)),
    };
  }).sort((a, b) => b.closed - a.closed);
  const byDept = db.config.departments.map((dep) => ({ name: dep.name, open: open.filter((t) => t.departmentId === dep.id).length }));
  send(res, 200, {
    period, generatedAt: now(),
    now: {
      open: open.filter((t) => !t.snoozeUntil).length, snoozed: open.filter((t) => t.snoozeUntil).length, waiting: waiting.length, routing: open.filter((t) => t.status === 'routing').length,
      unassigned: open.filter((t) => !t.assigneeId && t.status !== 'routing').length,
      oldestWaitMs: Number.isFinite(oldest) ? now() - oldest : 0,
      byUser: nowByUser, byDept, noDept: open.filter((t) => !t.departmentId).length,
    },
    period_: {
      opened: db.tickets.filter((t) => t.createdAt >= start).length,
      closed: closed.length,
      byUser: closedByUser,
    },
  });
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
let lastUpdateCheck = { at: 0, result: 'עוד לא נבדק' };
async function checkUpdate() {
  log('checking for updates...');
  try {
    const get = async (f) => {
      const r = await fetch(UPDATE_BASE + f + '?t=' + now(), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(r.status + ' ' + f);
      return Buffer.from(await r.arrayBuffer());
    };
    const remote = JSON.parse((await get('version.json')).toString('utf8'));
    if (!remote.version || remote.version <= VERSION) {
      lastUpdateCheck = { at: now(), result: `מעודכן – גרסה ${VERSION} היא האחרונה` };
      log(`up to date (v${VERSION})`);
      return lastUpdateCheck;
    }
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
    lastUpdateCheck = { at: now(), result: `עודכן לגרסה ${remote.version} – השרת עולה מחדש` };
    emitAll({ type: 'restarting', version: remote.version });
    store.flushAll();
    setTimeout(() => process.exit(3), 1500);
    return lastUpdateCheck;
  } catch (e) {
    log('update check failed:', e.message);
    lastUpdateCheck = { at: now(), result: 'הבדיקה נכשלה: ' + e.message };
    return lastUpdateCheck;
  }
}
route('POST', /^\/api\/admin\/update-check$/, async (req, res) => send(res, 200, { version: VERSION, ...(await checkUpdate()) }), { auth: 'admin' });
route('GET', /^\/api\/admin\/update-status$/, (req, res) => send(res, 200, { version: VERSION, ...lastUpdateCheck }), { auth: 'admin' });

// =====================================================================
process.on('SIGINT', () => { store.flushAll(); process.exit(0); });
process.on('SIGTERM', () => { store.flushAll(); process.exit(0); });
process.on('uncaughtException', (e) => log('uncaught', e.stack || e.message));
process.on('unhandledRejection', (e) => log('unhandled', e && (e.stack || e.message)));

// עדכון חד-פעמי (גרסה 11): מחלקת מכירות + דויד → נועה
(function migrateV11() {
  if (db.config.migratedV11) return;
  const noa = db.users.find((u) => u.active !== false && /^(נועה|נעה)/.test(String(u.name).trim()));
  if (noa) {
    if (!db.config.departments.some((d) => /מכירות/.test(d.name))) {
      db.config.departments.push({ id: store.newId(), name: 'מכירות', userId: noa.id, questions: '',
        description: 'מכירות: הצעות מחיר, לקוח חדש שמתעניין, רכישת מוצר או שירות חדש, מחירון, הזמנה חדשה, הרחבת שירות קיים' });
      const acc = db.config.departments.find((d) => /חשבונות/.test(d.name));
      if (acc) acc.description = acc.description.replace(/,?\s*הצעות מחיר/, '');
    }
    if (!(db.config.personRules || []).some((r) => r.phone === '972500000000')) {
      db.config.personRules = [...(db.config.personRules || []), { phone: '972500000000', name: 'דויד', userId: noa.id }];
    }
  }
  if (noa) db.config.migratedV11 = true; // אם עוד אין עובדת בשם נועה – ננסה שוב בהפעלה הבאה
  store.saveConfig();
  log('migration v11:', noa ? `sales + David → ${noa.name}` : 'Noa not found – skipped');
})();

// תיקון חד-פעמי (גרסה 16): שמות אנשי קשר שיובאו בקידוד שגוי
(function fixContactNames() {
  let n = 0;
  for (const c of db.contacts) {
    const name = fixMojibake(c.name), company = fixMojibake(c.company);
    if (name !== c.name || company !== c.company) { c.name = name; c.company = company; n++; }
  }
  if (n) { store.saveContacts(); log(`fixed ${n} contact names (encoding)`); }
})();
reindexContacts();

const PORT = Number(process.env.HD_PORT) || db.config.port || 8080;
const HOST = process.env.HD_HOST || db.config.host || '127.0.0.1';
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { log(`Port ${PORT} is busy - the server is probably already running.`); process.exit(10); }
  log('server error', e.message); process.exit(1);
});
server.listen(PORT, HOST, () => {
  log(`WhatsApp Helpdesk v${VERSION} running: http://localhost:${PORT}${HOST === '0.0.0.0' ? ' (open to the office network)' : ' (this server only)'}`);
  startPollers();
  closeIgnoredGroups();
  for (const t of db.tickets) if (t.status === 'routing') {
    if (t.aiTurns) scheduleRouting(t, Math.max(1, Number(db.config.ai.waitMinutes ?? 10)) * 60000, { force: true }); // מחכים לתשובת הלקוח
    else scheduleRouting(t);
  }
  refreshStates();
  setInterval(refreshStates, 2 * 60 * 1000);
  if (!process.env.HD_NO_UPDATE) { setTimeout(checkUpdate, 30 * 1000); setInterval(checkUpdate, 60 * 60 * 1000); }
});

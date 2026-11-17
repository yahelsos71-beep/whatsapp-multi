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
const publicUser = (u) => u && { id: u.id, name: u.name, username: u.username, role: u.role, active: u.active !== false, phone: u.phone || '', waAccess: canWa(u), ext: u.ext || '', quickClose: !!u.quickClose, seenVersion: u.seenVersion || 0 };
// מי רואה את מסך "💬 וואטסאפ" (כל הצ'אטים של המספרים): מנהלים, ועובדים שקיבלו הרשאה
const canWa = (u) => !!u && (u.role === 'admin' || u.waAccess === true);
// איפוס סיסמה מקומי: reset-password.bat כותב data/reset-password.json והשרת מחיל אותו
function applyPasswordReset() {
  const f = require('path').join(store.DATA_DIR, 'reset-password.json');
  if (!require('fs').existsSync(f)) return;
  try {
    const r = JSON.parse(require('fs').readFileSync(f, 'utf8'));
    const u = db.users.find((x) => x.username === String(r.username || '').trim().toLowerCase());
    if (u && String(r.password || '').length >= 4) {
      Object.assign(u, hashPassword(r.password), { active: true });
      for (const [k, v] of Object.entries(db.sessions || {})) if (v && v.userId === u.id) delete db.sessions[k];
      store.saveUsers(); store.saveSessions();
      console.log('Password reset for', u.username);
    }
  } catch (e) { console.error('reset-password', e.message); }
  try { require('fs').unlinkSync(f); } catch {}
}
setInterval(applyPasswordReset, 3000);
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
const s2name = (t) => displayName(t);
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
  // הודעות ששלחנו מהטלפון לצ'אט הזה כשלא הייתה קריאה פתוחה – נכנסות לקריאה החדשה (לפי הסדר)
  const k = inst.id + '|' + chatId;
  const pend = (phoneOut.get(k) || []).filter((m) => now() - m.ts < 48 * 3600e3);
  phoneOut.delete(k);
  for (const m of pend) { store.messages(t.id).push({ id: store.newId(), ...m }); t.lastOutAt = Math.max(t.lastOutAt, m.ts); }
  if (pend.length) { store.saveMessages(t.id); if (!t.assigneeId && pend[0].byUserId) t.assigneeId = pend[0].byUserId; }
  return t;
}
const phoneOut = new Map(); // "inst|chat" -> הודעות יוצאות מהטלפון בלי קריאה פתוחה (עד 48 שעות, 30 אחרונות)

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
const quietMark = new Map(); // "inst|chat" -> {at,userId} – עובד כתב מהמסך "וואטסאפ" בלי קריאה פתוחה
function recentHumanReply(instanceId, chatId) {
  const qm = quietMark.get(instanceId + '|' + chatId);
  let best = null;
  for (const x of db.tickets) {
    if (x.instanceId !== instanceId || x.chatId !== chatId || !x.lastOutAt) continue;
    if (!best || x.lastOutAt > best.lastOutAt) best = x;
  }
  if (!best) return qm || null;
  if (qm && qm.at > best.lastOutAt) return qm;
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
async function sendText(t, text, user, { auto = false, byName = null, aiBot = false, quoted = null } = {}) {
  const inst = instById(t.instanceId);
  if (!inst) throw new Error('המספר של הקריאה לא מוגדר');
  const r = await ga.sendMessage(inst, t.chatId, text, quoted && quoted.id);
  if (r && r.idMessage) sentIds.add(r.idMessage);
  const msg = addMessage(t, { dir: 'out', type: 'text', text, idMessage: r && r.idMessage, byUserId: user ? user.id : null, byName: user ? user.name : byName || 'מענה אוטומטי', auto, aiBot, status: 'sent',
    ...(quoted ? { quoted: { id: quoted.id, text: quoted.text || '', from: quoted.from || '' } } : {}) });
  if (!auto) { t.awaiting = false; t.lastOutAt = now(); }
  emitTicket(t);
  return msg;
}

// =====================================================================
// קבלת הודעות מ-Green API
// =====================================================================
// ---------- הודעות מהטכנאי / מקבוצת השירות ----------
// "טופל" → סוגר את הקריאה. כל דבר אחר → הערה בקריאה. לא נפתחת קריאה חדשה מהטכנאי
const DONE_RE = /(טופל|בוצע|סגרתי|נסגר|הסתדר|✅)/;
async function handleTechMessage(inst, chatId, m, body, sd) {
  const tgt = (db.config.serviceTargets || []).find((x) => (x.chatId && x.chatId === chatId) || (x.phone && chatId === x.phone + '@c.us'));
  if (!tgt) return false;
  const text = m.text || '';
  const withCalls = db.tickets.filter((t) => (t.serviceCallList || []).some((c) => c.targetId === tgt.id));
  let t = null;
  if (m.quoted && m.quoted.id) t = withCalls.find((x) => x.serviceCallList.some((c) => c.idMessage === m.quoted.id));
  if (!t) { const n = /#(\d{3,})/.exec(text); if (n) t = withCalls.find((x) => x.id === n[1]); }
  if (!t && !tgt.chatId) t = withCalls.filter((x) => x.status !== 'closed').sort((a, b) => b.serviceCallList.at(-1).ts - a.serviceCallList.at(-1).ts)[0];
  if (!t) return !tgt.chatId; // טכנאי בלי קריאה מתאימה – לא פותחים קריאה; בקבוצה – זרימה רגילה
  const who = tgt.chatId ? (sd.senderContactName || sd.senderName || tgt.name) : tgt.name;
  const tu = targetUser(tgt);
  if (DONE_RE.test(text) && t.status !== 'closed') {
    t.status = 'closed'; t.closedAt = now(); t.closedBy = tu ? tu.id : null; t.awaiting = false; t.snoozeUntil = null;
    t.resolution = `🛠 ${who}: ${text}`;
    note(t, `✅ ${who} סגר/ה את הקריאה מהוואטסאפ\n📝 מה בוצע: ${text}`);
    emitTicket(t, { sound: 'msg' });
    log(`ticket #${t.id} closed by technician ${tgt.name}`);
    try { const r = await ga.sendMessage(inst, chatId, `👍 קריאה #${t.id} נסגרה. תודה!`, body.idMessage); if (r && r.idMessage) sentIds.add(r.idMessage); } catch {}
  } else {
    addMessage(t, { dir: 'note', type: 'text', text: `💬 ${who}: ${text || '[' + m.type + ']'}`, internal: true, byName: who });
    emitTicket(t, { sound: 'msg' });
  }
  return true;
}

const instState = {}; // instId -> 'authorized' / 'notAuthorized' / 'error: ...'
function findMessageByIdMessage(idMessage) {
  for (const t of db.tickets.slice(-300).reverse()) {
    const m = store.messages(t.id).find((x) => x.idMessage === idMessage);
    if (m) return { t, m };
  }
  return null;
}

// =====================================================================
// מסך "💬 וואטסאפ": כל הצ'אטים של מספרי המשרד (לא רק קריאות)
// =====================================================================
const waKey = (instId, chatId) => instId + '|' + chatId;
function waName(inst, chatId, fallback) {
  if (chatId.endsWith('@g.us')) return fallback || 'קבוצה';
  const phone = chatId.split('@')[0];
  const c = contactFor(phone);
  if (c && (c.name || c.company)) return [c.name, c.company].filter(Boolean).join(' · ');
  return fallback && !/^[\d+\s-]+$/.test(fallback) ? fallback : '';
}
function waUpsert(instId, chatId, { name, ts, text, dir, sender }) {
  const k = waKey(instId, chatId);
  const cur = db.waChats[k] || { instanceId: instId, chatId, isGroup: chatId.endsWith('@g.us') };
  if (name) cur.name = name;
  if (!cur.ts || ts >= cur.ts) { cur.ts = ts; cur.text = text; cur.dir = dir; cur.sender = sender || ''; }
  db.waChats[k] = cur;
  return cur;
}
const waAudience = () => db.users.filter((u) => u.active !== false && canWa(u)).map((u) => u.id);
// 👤 שמירה אוטומטית: מי שכותב לנו ועוד לא שמור – נשמר באנשי הקשר לפי השם שלו בוואטסאפ
function autoSaveContact(phone, name) {
  if (db.config.autoSaveContacts === false) return;
  name = String(name || '').trim();
  if (!phone || phone.length < 9 || !name || /^[\d+\s()-]+$/.test(name) || contactFor(phone)) return;
  if (staffByPhone(phone)) return;
  db.contacts.push({ id: store.newId(), source: 'auto', company: '', name, phones: [phone] });
  reindexContacts(); store.saveContacts();
}
function waTrack(inst, body, type, sd, chatId) {
  if (!['incomingMessageReceived', 'outgoingMessageReceived', 'outgoingAPIMessageReceived'].includes(type)) return;
  const m = ga.parseMessage(body.messageData);
  if (m.type === 'reaction') return;
  const dir = type === 'incomingMessageReceived' ? 'in' : 'out';
  const ts = body.timestamp ? body.timestamp * 1000 : now();
  const isGroup = chatId.endsWith('@g.us');
  const senderPhone = String(sd.sender || '').split('@')[0];
  const sender = isGroup && dir === 'in' ? (sd.senderContactName || sd.senderName || senderPhone) : '';
  if (dir === 'in' && !isGroup) autoSaveContact(chatId.split('@')[0], sd.senderName || sd.senderContactName);
  const nameHint = isGroup ? sd.chatName : (dir === 'in' ? (sd.senderContactName || sd.senderName || sd.chatName) : sd.chatName);
  const text = m.type === 'deleted' ? '(הודעה נמחקה)' : m.text || ({ image: '📷 תמונה', video: '🎬 וידאו', file: '📎 קובץ', audio: '🎤 הקלטה', location: '📍 מיקום' }[m.type] || '');
  const c = waUpsert(inst.id, chatId, { name: waName(inst, chatId, nameHint), ts, text, dir, sender });
  store.saveWaChats();
  const item = { ...m, id: body.idMessage, dir, ts, senderName: sender, senderPhone: isGroup && dir === 'in' ? senderPhone : '', byName: dir === 'out' ? (type === 'outgoingMessageReceived' ? 'מהטלפון' : '') : '' };
  // קצת אחרי – כדי שהקריאה (אם נפתחה עכשיו) כבר תופיע ליד הצ'אט
  setTimeout(() => { const v = waChatView(c); for (const id of waAudience()) sendTo(id, { type: 'wa', chat: v, message: item }); }, 400);
}
function waChatView(c) {
  const t = openTicketFor(c.instanceId, c.chatId);
  const inst = instById(c.instanceId);
  const phone = c.chatId.split('@')[0];
  return { key: waKey(c.instanceId, c.chatId), instanceId: c.instanceId, instanceName: inst ? inst.name : '', chatId: c.chatId, isGroup: !!c.isGroup,
    phone: c.isGroup ? '' : phone, name: waName(inst, c.chatId, c.name) || c.name || '', ts: c.ts || 0, text: c.text || '', dir: c.dir || '', sender: c.sender || '',
    ticketId: t ? t.id : null, ticketAssignee: t && t.assigneeId ? (userById(t.assigneeId)?.name || '') : '' };
}
const waSeeded = new Set();
async function waSeed(inst) {
  if (waSeeded.has(inst.id)) return;
  waSeeded.add(inst.id);
  // מהקריאות שכבר במערכת
  for (const t of db.tickets) {
    if (t.instanceId !== inst.id) continue;
    const ts = Math.max(t.lastInAt || 0, t.lastOutAt || 0, t.createdAt || 0);
    const k = waKey(inst.id, t.chatId);
    if (!db.waChats[k] || !db.waChats[k].ts) waUpsert(inst.id, t.chatId, { name: displayName(t), ts, text: t.lastText || '', dir: t.lastOutAt > (t.lastInAt || 0) ? 'out' : 'in' });
    else if (!db.waChats[k].name) db.waChats[k].name = displayName(t);
  }
  // ההודעות האחרונות מוואטסאפ (3 ימים) + שמות אנשי קשר וקבוצות
  const add = (list, dir) => {
    for (const h of Array.isArray(list) ? list : []) {
      if (!h.chatId || /broadcast|newsletter/.test(h.chatId)) continue;
      const p = ga.parseHistoryItem({ ...h, type: dir === 'out' ? 'outgoing' : 'incoming' });
      const isGroup = h.chatId.endsWith('@g.us');
      waUpsert(inst.id, h.chatId, { name: isGroup ? h.chatName : (h.senderContactName || h.senderName || h.chatName), ts: p.ts, text: p.text || ({ image: '📷 תמונה', video: '🎬 וידאו', file: '📎 קובץ', audio: '🎤 הקלטה', location: '📍 מיקום' }[p.type] || ''), dir,
        sender: isGroup && dir === 'in' ? (h.senderContactName || h.senderName || '') : '' });
    }
  };
  try { add(await ga.lastIncoming(inst), 'in'); } catch (e) { log('lastIncoming', e.message); }
  try { add(await ga.lastOutgoing(inst), 'out'); } catch (e) { log('lastOutgoing', e.message); }
  try {
    for (const c of (await ga.getContacts(inst)) || []) {
      const k = waKey(inst.id, c.id || '');
      if (db.waChats[k] && !db.waChats[k].nameLocked && (c.name || c.contactName)) db.waChats[k].name = c.contactName || c.name;
      if (!c.id || db.waChats[k]) continue;
      // צ'אטים בלי פעילות אחרונה – נכנסים לחיפוש בלבד
      if (c.type === 'group' || c.type === 'user') waContacts.set(k, { instanceId: inst.id, chatId: c.id, name: c.contactName || c.name || '', isGroup: c.id.endsWith('@g.us') });
    }
  } catch (e) { log('getContacts', e.message); }
  store.saveWaChats();
}
const waContacts = new Map(); // לחיפוש: אנשי קשר/קבוצות בלי פעילות אחרונה

const instLastNotif = {}; // instId -> {at, type} – מתי הגיעה הודעה אחרונה מ-Green API
async function handleNotification(inst, body) {
  const type = body && body.typeWebhook;
  instLastNotif[inst.id] = { at: now(), type };
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
  try { waTrack(inst, body, type, sd, chatId); } catch (e) { log('waTrack', e.message); }
  const isGroup = chatId.endsWith('@g.us');
  if (isGroup && !db.config.groups.enabled) return;
  if (isIgnored(inst.id, chatId)) return;
  if (isGroup && ignoredByName(sd.chatName)) return; // קבוצות שמתעלמים מהן לפי שם (פורום מתקינים, מתח נמוך...)
  const m = ga.parseMessage(body.messageData);
  if (m.quoted) {
    // מי כתב את ההודעה המצוטטת: אנחנו (לפי ההודעה השמורה) / איש קשר / טלפון
    const f = m.quoted.id && findMessageByIdMessage(m.quoted.id);
    if (f) m.quoted.from = f.m.dir === 'out' ? (f.m.byName || 'אנחנו') : (f.m.senderName || displayName(f.t));
    else if (m.quoted.from) { const c = contactFor(m.quoted.from); m.quoted.from = c && (c.name || c.company) || (m.quoted.from.startsWith('972') ? '0' + m.quoted.from.slice(3) : m.quoted.from); }
  }
  if (m.type === 'deleted') { if (m.deletedId) markDeleted(m.deletedId, null); return; }
  if (m.type === 'reaction') return;
  if (m.type === 'edited') { m.type = 'text'; m.text = '✏️ (נערכה) ' + m.text; }
  const ts = body.timestamp ? body.timestamp * 1000 : now();

  if (type !== 'incomingMessageReceived') {
    // הודעה יוצאת: נשלחה מהטלפון או מה-API
    if (sentIds.has(body.idMessage) || findMessageByIdMessage(body.idMessage)) return;
    const t = openTicketFor(inst.id, chatId);
    if (!t) {
      // אין קריאה פתוחה: לא פותחים קריאה על הודעה יוצאת, אבל שומרים אותה –
      // כשהלקוח יענה תיפתח קריאה (בלי בוט, אצל מי שטיפל בו לאחרונה) וההודעה שלנו תופיע בה
      const k = inst.id + '|' + chatId;
      const last = db.tickets.filter((x) => x.instanceId === inst.id && x.chatId === chatId).sort((a, b) => b.createdAt - a.createdAt)[0];
      const owner = last && last.assigneeId && userById(last.assigneeId)?.active !== false ? last.assigneeId : null;
      const list = phoneOut.get(k) || [];
      list.push({ ...m, dir: 'out', ts, idMessage: body.idMessage, byName: type === 'outgoingMessageReceived' ? 'מהטלפון' : 'API', status: 'sent', byUserId: owner });
      phoneOut.set(k, list.slice(-30));
      quietMark.set(k, { at: ts, userId: owner });
      return;
    }
    addMessage(t, { ...m, dir: 'out', ts, idMessage: body.idMessage, byName: type === 'outgoingMessageReceived' ? 'מהטלפון' : 'API' });
    t.awaiting = false; t.lastOutAt = ts;
    emitTicket(t);
    return;
  }

  if (!isGroup && /^\s*(הסר|הסירו|הסרה|stop|unsubscribe)\s*[.!]?\s*$/i.test(m.text || '')) {
    const ph = chatId.split('@')[0];
    db.config.optOut = [...new Set([...(db.config.optOut || []), ph])]; store.saveConfig();
    log(`📣 opt-out ${ph}`);
  }
  if (await handleTechMessage(inst, chatId, m, body, sd)) return;
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
const TEST_MODE = !!process.env.HD_TEST_MODE; // 🧪 מצב ניסיון: לא מושכים הודעות ולא שולחים – כדי לא להפריע לשרת האמיתי
function startPollers() {
  if (TEST_MODE) return;
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
    serviceTargets: c.serviceTargets || [],
    ignoredChats: c.ignoredChats,
    ignoreGroupNames: c.ignoreGroupNames || [],
    personRules: c.personRules || [],
    chatRules: c.chatRules.map((r) => ({ ...r, userName: userById(r.userId)?.name || '' })),
    instances: c.instances.map((i) => ({ ...i, token: mask(i.token) })),
    pbxKey: c.pbxKey || '',
    autoSaveContacts: c.autoSaveContacts !== false,
    pbxIgnore: c.pbxIgnore || [],
    pbx: { type: (c.pbx && c.pbx.type) || '015', enabled: !!(c.pbx && c.pbx.enabled), host: (c.pbx && c.pbx.host) || 'www.015pbx.net', user: (c.pbx && c.pbx.user) || '', pass: mask(c.pbx && c.pbx.pass),
      eslHost: (c.pbx && c.pbx.eslHost) || '', eslPort: (c.pbx && c.pbx.eslPort) || 8021, eslPass: mask(c.pbx && c.pbx.eslPass), domain: (c.pbx && c.pbx.domain) || '' },
    pbxStatus,
  };
}

const routes = [];
const route = (method, pattern, handler, { auth = 'user' } = {}) => routes.push({ method, pattern, handler, auth });

// ---------- התקנה ראשונה / התחברות ----------
route('GET', /^\/api\/state$/, (req, res, { user }) =>
  send(res, 200, { setupNeeded: db.users.length === 0, user: publicUser(user), version: VERSION, company: db.config.companyName,
    targets: user ? serviceTargets().map((x) => ({ id: x.id, name: x.name })) : [], testMode: TEST_MODE, mondayVcat: !!(user && mondayOk) }), { auth: 'none' });

route('POST', /^\/api\/setup$/, async (req, res) => {
  if (db.users.length) return send(res, 400, { error: 'כבר הוגדר' });
  const b = await readJson(req);
  if (!b.username || !b.password || String(b.password).length < 4) return send(res, 400, { error: 'שם משתמש וסיסמה (4 תווים לפחות)' });
  db.users.push({ id: store.newId(), name: b.name || b.username, username: String(b.username).trim().toLowerCase(), role: 'admin', active: true, seenVersion: VERSION, ...hashPassword(b.password) });
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
// ---------- 💭 צ'אט פנימי בין העובדים ----------
const staffPair = (m, a, b) => (m.from === a && m.to === b) || (m.from === b && m.to === a);
function staffUnread(userId) {
  const out = {};
  for (const m of db.staffChat) if (m.to === userId && !m.read) out[m.from] = (out[m.from] || 0) + 1;
  return out;
}
route('GET', /^\/api\/staff\/unread$/, (req, res, { user }) => send(res, 200, staffUnread(user.id)));
route('GET', /^\/api\/staff\/chat$/, (req, res, { user, query }) => {
  const other = String(query.get('with') || '');
  if (!userById(other)) return send(res, 400, { error: 'עובד לא קיים' });
  let changed = false;
  for (const m of db.staffChat) if (m.to === user.id && m.from === other && !m.read) { m.read = true; changed = true; }
  if (changed) { store.saveStaffChat(); sendTo(other, { type: 'staffread', by: user.id }); }
  send(res, 200, db.staffChat.filter((m) => staffPair(m, user.id, other)).slice(-200));
});
route('POST', /^\/api\/staff\/chat$/, async (req, res, { user }) => {
  const b = await readJson(req);
  const to = userById(b.to);
  const text = String(b.text || '').trim().slice(0, 4000);
  if (!to || to.active === false || to.id === user.id) return send(res, 400, { error: 'בחר עובד' });
  if (!text) return send(res, 400, { error: 'הודעה ריקה' });
  const t = b.ticketId && ticketById(b.ticketId);
  const m = { id: store.newId(), from: user.id, to: to.id, text, ts: now(), read: false, ...(t ? { ticketId: t.id, ticketName: displayName(t) } : {}) };
  db.staffChat.push(m);
  if (db.staffChat.length > 20000) db.staffChat.splice(0, db.staffChat.length - 20000);
  store.saveStaffChat();
  // עובד שמקבל הפניה לקריאה שהוא לא רואה – מנהל משתף אותה; הוא יוכל לפתוח אותה לצפייה
  sendTo(to.id, { type: 'staffmsg', message: m, fromName: user.name });
  sendTo(user.id, { type: 'staffmsg', message: m, fromName: user.name });
  send(res, 200, m);
});
route('POST', /^\/api\/staff\/read$/, async (req, res, { user }) => {
  const b = await readJson(req);
  let changed = false;
  for (const m of db.staffChat) if (m.to === user.id && m.from === b.with && !m.read) { m.read = true; changed = true; }
  if (changed) { store.saveStaffChat(); sendTo(b.with, { type: 'staffread', by: user.id }); }
  send(res, 200, { ok: true });
});

// "מה חדש": כל עובד מסמן "קראתי" – לא יוצג לו שוב עד הגרסה הבאה
route('POST', /^\/api\/me\/seen$/, async (req, res, { user }) => {
  const b = await readJson(req);
  user.seenVersion = Math.min(VERSION, Number(b.version) || VERSION);
  store.saveUsers();
  send(res, 200, { ok: true });
});
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
  if (mine) return t;
  // קריאה ששותפה איתו בצ'אט הפנימי – צפייה בלבד
  return db.staffChat.some((m) => m.to === user.id && m.ticketId === t.id) ? t : null;
}

route('GET', /^\/api\/tickets\/(\d+)$/, (req, res, { user, params }) => {
  const t = visibleTicket(user, params[0]);
  if (!t) return send(res, 404, { error: 'לא נמצא' });
  const history = db.tickets
    .filter((x) => x.chatId === t.chatId && x.instanceId === t.instanceId && x.id !== t.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((x) => ({ id: x.id, createdAt: x.createdAt, closedAt: x.closedAt, status: x.status, assigneeName: userById(x.assigneeId)?.name || '', departmentName: depById(x.departmentId)?.name || '',
      resolution: x.resolution || '', closedByName: userById(x.closedBy)?.name || '',
      notes: store.messages(x.id).filter((m) => m.internal).map((m) => ({ text: m.text, by: m.byName || '', ts: m.ts })) }));
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
    // תגובה להודעה מסוימת: מאתרים את ההודעה בקריאה (או בקריאות קודמות של אותו צ'אט)
    let quoted = null;
    if (b.replyTo) {
      const pool = db.tickets.filter((x) => x.chatId === t.chatId && x.instanceId === t.instanceId).flatMap((x) => store.messages(x.id));
      const m = pool.find((x) => x.id === b.replyTo);
      if (m && m.idMessage) quoted = { id: m.idMessage, text: (m.text || '').slice(0, 300) || ({ image: '📷 תמונה', video: '🎬 וידאו', file: '📎 קובץ', audio: '🎤 הקלטה' }[m.type] || ''), from: m.dir === 'in' ? (m.senderName || s2name(t)) : (m.byName || 'אנחנו') };
    }
    const msg = await sendText(t, text, user, { quoted });
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

// הערה פנימית (לא נשלחת ללקוח) – למשל "עשינו ריסטרט לראוטר"
route('POST', /^\/api\/tickets\/(\d+)\/note$/, async (req, res, { user, params }) => {
  const t = visibleTicket(user, params[0]);
  if (!t) return send(res, 404, { error: 'לא נמצא' });
  const b = await readJson(req);
  const text = String(b.text || '').trim();
  if (!text) return send(res, 400, { error: 'הערה ריקה' });
  const msg = addMessage(t, { dir: 'note', type: 'text', text, internal: true, byUserId: user.id, byName: user.name });
  emitTicket(t);
  send(res, 200, msg);
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

route('POST', /^\/api\/tickets\/(\d+)\/close$/, async (req, res, { user, params }) => {
  const t = myTicket(user, params[0], res); if (!t) return;
  const b = await readJson(req);
  const resolution = String(b.resolution || '').trim();
  if (resolution.length < 3 && !user.quickClose) return send(res, 400, { error: 'כדי לסגור – כתוב בקצרה מה בוצע' });
  t.status = 'closed'; t.closedAt = now(); t.closedBy = user.id; t.awaiting = false; t.snoozeUntil = null;
  t.resolution = resolution;
  note(t, `✅ הקריאה נסגרה על ידי ${user.name}${resolution ? `\n📝 מה בוצע: ${resolution}` : ''}`);
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
  note(t, `🚫 ${user.name} חסם/ה את ${t.isGroup ? 'הקבוצה' : 'הצ\'אט'} – לא ייכנס יותר למוקד`);
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

// ---------- מחיקת הודעה שנשלחה בטעות (אצל כולם) ----------
const DELETE_WINDOW = 2 * 864e5; // וואטסאפ מאפשר למחוק אצל כולם רק בערך יומיים אחרי השליחה
function markDeleted(idMessage, user) {
  const f = findMessageByIdMessage(idMessage);
  if (!f || f.m.deleted) return f;
  Object.assign(f.m, { deleted: true, deletedAt: now(), deletedBy: user ? user.name : '' });
  store.saveMessages(f.t.id);
  emitToTicket(f.t, { type: 'msgupdate', ticketId: f.t.id, message: f.m });
  return f;
}
async function deleteSent(inst, chatId, idMessage, ts, user) {
  if (ts && now() - ts > DELETE_WINDOW) throw new Error('וואטסאפ מאפשר למחוק אצל כולם רק עד כיומיים אחרי השליחה');
  await ga.deleteMessage(inst, chatId, idMessage);
  markDeleted(idMessage, user);
  const f = findMessageByIdMessage(idMessage);
  if (f) note(f.t, `🗑 ${user.name} מחק/ה הודעה שנשלחה${f.m.text ? ': "' + f.m.text.slice(0, 60) + '"' : f.m.fileName ? ': ' + f.m.fileName : ''}`);
  for (const id of waAudience()) sendTo(id, { type: 'wa-del', key: waKey(inst.id, chatId), id: idMessage, by: user.name });
}
route('POST', /^\/api\/tickets\/(\d+)\/messages\/(\w+)\/delete$/, async (req, res, { user, params }) => {
  const t = myTicket(user, params[0], res); if (!t) return;
  const m = db.tickets.filter((x) => x.chatId === t.chatId && x.instanceId === t.instanceId).flatMap((x) => store.messages(x.id)).find((x) => x.id === params[1]);
  if (!m || m.dir !== 'out' || !m.idMessage) return send(res, 400, { error: 'אפשר למחוק רק הודעה שנשלחה ללקוח' });
  if (m.deleted) return send(res, 200, { ok: true });
  const inst = instById(t.instanceId);
  if (!inst) return send(res, 400, { error: 'המספר לא מוגדר' });
  try { await deleteSent(inst, t.chatId, m.idMessage, m.ts, user); send(res, 200, { ok: true }); }
  catch (e) { send(res, 502, { error: 'המחיקה נכשלה: ' + e.message }); }
});
route('POST', /^\/api\/wa\/delete$/, async (req, res, { user }) => {
  if (!canWa(user)) return send(res, 403, { error: 'אין הרשאה' });
  const b = await readJson(req);
  const inst = instById(b.inst);
  if (!inst || !b.chat || !b.id) return send(res, 400, { error: 'חסרים פרטים' });
  try { await deleteSent(inst, String(b.chat), String(b.id), Number(b.ts) || 0, user); send(res, 200, { ok: true }); }
  catch (e) { send(res, 502, { error: 'המחיקה נכשלה: ' + e.message }); }
});

// ---------- @ תיוג משתתפים בקבוצה ----------
async function groupMemberList(inst, chatId) {
  const key = 'm|' + inst.id + '|' + chatId;
  const c = groupMembers.get(key);
  if (c && now() - c.at < 600e3) return c.list;
  let list = [];
  try {
    const g = await ga.getGroupData(inst, chatId);
    list = (g && g.participants || []).map((p) => {
      const phone = String(p.id || '').split('@')[0];
      const ct = contactFor(phone); const staff = staffByPhone(phone);
      return { phone, name: (staff && staff.name) || (ct && (ct.name || ct.company)) || '' };
    }).filter((x) => x.phone);
  } catch (e) { log('getGroupData failed', e.message); }
  groupMembers.set(key, { at: now(), list });
  return list;
}
route('GET', /^\/api\/tickets\/(\d+)\/members$/, async (req, res, { user, params }) => {
  const t = visibleTicket(user, params[0]);
  if (!t || !t.isGroup) return send(res, 200, []);
  const inst = instById(t.instanceId); if (!inst) return send(res, 200, []);
  send(res, 200, await groupMemberList(inst, t.chatId));
});
route('GET', /^\/api\/wa\/members$/, async (req, res, { user, query }) => {
  if (!canWa(user)) return send(res, 403, { error: 'אין הרשאה' });
  const inst = instById(query.get('inst')); const chatId = String(query.get('chat') || '');
  if (!inst || !chatId.endsWith('@g.us')) return send(res, 200, []);
  send(res, 200, await groupMemberList(inst, chatId));
});

// ---------- 📞 מרכזייה: webhook על שיחה נכנסת → חלון "מי מתקשר" ----------
// מקבל כל פורמט (JSON / טופס / כתובת) ומחפש בו את המספר המתקשר, הקו/שלוחה וסוג האירוע
const pbxLog = []; // 30 האחרונים – לבדיקה במסך הניהול
const flatten = (o, out = {}, pre = '') => { for (const [k, v] of Object.entries(o || {})) { if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, out, pre + k + '.'); else out[pre + k] = v; } return out; };
const pick = (f, re) => { for (const [k, v] of Object.entries(f)) if (re.test(k.split('.').pop()) && v !== '' && v != null) return String(v); return ''; };
function pbxParse(f) {
  return {
    from: pick(f, /^(snumber|scallerid|caller_?id_?number|caller_?number|callerid|caller|from|from_?number|src|source|ani|cli|phone|phone_?number|number|caller_?id|customer_?number)$/i),
    to: pick(f, /^(cnumber|dnumber|destination_?number|destination|dest|dst|to|to_?number|called|called_?number|extension|ext|did|dnis|line|telephone_?line|agent)$/i),
    name: pick(f, /^(caller_?id_?name|caller_?name|cid_?name|name)$/i),
    event: pick(f, /^(event|event_?name|event_?type|type|status|state|call_?state|call_?status|action|direction)$/i),
    callId: pick(f, /^(uuid|call_?id|callid|call_?uuid|unique_?id|id)$/i),
  };
}
function callInfo(phone, p = {}) {
  const c = contactFor(phone);
  const tickets = db.tickets.filter((t) => t.phone === phone).sort((a, b) => b.createdAt - a.createdAt);
  const lastDone = tickets.find((t) => t.resolution);
  return {
    phone, callId: p.callId || '', to: p.to || '', name: (c && c.name) || (p.name && !/^[\d+\s-]+$/.test(p.name) ? p.name : '') || (tickets[0] ? displayName(tickets[0]) : ''),
    company: (c && c.company) || '', known: !!c || tickets.length > 0,
    open: tickets.filter((t) => t.status !== 'closed').map((t) => ({ id: t.id, assigneeId: t.assigneeId, assignee: userById(t.assigneeId)?.name || '', last: t.lastText || '' })),
    lastDone: lastDone ? { id: lastDone.id, at: lastDone.closedAt, by: lastDone.closedByName || '', text: lastDone.resolution } : null,
    ticketsCount: tickets.length,
  };
}
// שיחה נכנסת בלבד: direction=in (לא in_out / internal / out), ולא שיחה שמתחילה מקו של עובד
const staffLines = () => db.users.map((u) => u.ext).filter(Boolean);
function isIncoming(f) {
  const dirKey = Object.keys(f).find((k) => /^(direction|call_?direction)$/i.test(k.split('.').pop()));
  if (dirKey) return /^(in|inbound|incoming)$/i.test(String(f[dirKey]).trim());
  if (/^phone$/i.test(String(f.stype || ''))) return false; // מתחיל מקו טלפון שלנו = יוצאת
  const src = String(f.snumber || f.caller_id_number || f.from || '').replace(/\D/g, '');
  if (src && staffLines().some((x) => src.endsWith(x) || x.endsWith(src))) return false;
  return true;
}
// 📱 "מי זה?" לפי וואטסאפ: שם בפרופיל / שם העסק / תמונה – למספר שלא שמור אצלנו (נשמר במטמון שבוע)
const waInfoCache = new Map();
async function waLookup(phone) {
  phone = normPhone(phone); if (!phone) return null;
  const hit = waInfoCache.get(phone);
  if (hit && now() - hit.at < 7 * 864e5) return hit.info;
  const inst = db.config.instances.find((i) => i.enabled !== false && instState[i.id] !== 'notAuthorized') || db.config.instances[0];
  if (!inst) return null;
  const chatId = phone + '@c.us';
  let info = { exists: false };
  try {
    const [ci, av] = await Promise.all([ga.getContactInfo(inst, chatId).catch(() => null), ga.getAvatar(inst, chatId).catch(() => null)]);
    const name = ci && (ci.name || ci.contactName) || '';
    const exists = !!(ci && (name || ci.isBusiness || ci.description)) || !!(av && av.existsWhatsapp);
    info = { exists, name: name && !/^[\d+\s-]+$/.test(name) ? name : '', business: !!(ci && ci.isBusiness), category: (ci && ci.category) || '',
      description: String((ci && ci.description) || '').slice(0, 200), email: (ci && ci.email) || '', avatar: (av && av.urlAvatar) || (ci && ci.avatar) || '' };
  } catch {}
  waInfoCache.set(phone, { at: now(), info });
  if (waInfoCache.size > 3000) waInfoCache.clear();
  return info;
}
async function sendCallWaInfo(call, targets) {
  if (call.name && call.known) return;
  const info = await waLookup(call.phone);
  if (!info || !info.exists) return;
  for (const u of targets) sendTo(u.id, { type: 'call-info', phone: call.phone, wa: info });
}
route('GET', /^\/api\/wa\/lookup$/, async (req, res, { query }) => send(res, 200, (await waLookup(query.get('phone'))) || { exists: false }));

// 📵 מספרים (או קווים) שלא מקפיצים חלון "שיחה נכנסת" – נשמרים בהגדרות השרת בלבד
const pbxIgnored = (...nums) => {
  const list = db.config.pbxIgnore || [];
  return nums.some((n) => { const d = String(n || '').replace(/\D/g, ''); if (d.length < 3) return false; const p = normPhone(d) || d; return list.some((x) => x === p || x === d || (x.length >= 7 && (p.endsWith(x.slice(-9)) || d.endsWith(x.slice(-9))))); });
};
route('POST', /^\/api\/admin\/pbx-ignore$/, async (req, res) => {
  const b = await readJson(req);
  let list = Array.isArray(b.list) ? b.list : String(b.list || '').split(/[\n,;]+/);
  if (b.add) list = [...(db.config.pbxIgnore || []), b.add];
  db.config.pbxIgnore = [...new Set(list.map((x) => { const d = String(x).replace(/\D/g, ''); return d.length >= 9 ? normPhone(d) || d : d; }).filter((x) => x && x.length >= 3))];
  store.saveConfig();
  send(res, 200, { list: db.config.pbxIgnore });
}, { auth: 'admin' });

async function pbxWebhook(req, res, query) {
  const key = query.get('key') || req.headers['x-api-key'] || '';
  if (!db.config.pbxKey || key !== db.config.pbxKey) {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].replace(/^::ffff:/, '');
    log(`📞 webhook with wrong key from ${ip}`);
    return send(res, 403, { error: 'bad key' });
  }
  let body = {};
  try {
    const raw = (await readBody(req, 256 * 1024)).toString('utf8');
    if (raw.trim().startsWith('{') || raw.trim().startsWith('[')) body = JSON.parse(raw);
    else if (raw.includes('=')) body = Object.fromEntries(new URLSearchParams(raw));
  } catch {}
  const f = flatten({ ...Object.fromEntries([...query].filter(([k]) => k !== 'key')), ...(Array.isArray(body) ? body[0] : body) });
  for (const k of Object.keys(f)) if (/pass|token|secret|key|auth/i.test(k)) delete f[k];
  const p = pbxParse(f);
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].replace(/^::ffff:/, '');
  pbxLog.unshift({ at: now(), fields: f, parsed: p, ip, source: 'webhook' }); pbxLog.length = Math.min(pbxLog.length, 30);
  send(res, 200, { ok: true });
  const phone = normPhone(p.from);
  if (!phone || !isIncoming(f) || pbxIgnored(p.from, p.to)) return;
  const ended = /hang|end|complet|disconnect|bye|finish|answer|missed|busy/i.test(p.event);
  const answered = /answer/i.test(p.event);
  const ext = String(p.to || '').replace(/\D/g, '');
  const people = db.users.filter((u) => u.active !== false);
  let targets = ext ? people.filter((u) => u.ext && (ext.endsWith(u.ext) || u.ext.endsWith(ext))) : [];
  if (!targets.length) targets = people;
  if (ended) { for (const u of targets) sendTo(u.id, { type: 'call-end', phone, callId: p.callId, answered }); return; }
  const call = callInfo(phone, p);
  log(`📞 call from ${phone}${p.to ? ' to ' + p.to : ''} → ${targets.map((u) => u.name).join(', ')}`);
  for (const u of targets) sendTo(u.id, { type: 'call', call });
  sendCallWaInfo(call, targets).catch(() => {});
}
// ---------- 📞 חיבור ישיר ל-015 (Enswitch): בודקים כל 2 שניות אילו שיחות נכנסות מצלצלות ----------
// לא צריך Webhook ולא הפניית פורט – השרת שלנו פונה החוצה למרכזייה
let pbxStatus = { state: 'off', at: 0, text: '' };
const activeCalls = new Map(); // callId -> phone
let pbxTimer = null, pbxSamples = 0;
const pbxLogged = new Set();
function pbxSchedule(ms) { clearTimeout(pbxTimer); pbxTimer = setTimeout(pbxPoll, ms); }
// ---------- 📞 FusionPBX / FreeSWITCH: חיבור Event Socket – אירועי שיחה בזמן אמת + חיוג ----------
const { Esl } = require('./lib/esl');
const esl = new Esl();
let eslKey = '';
const fusionCalls = new Map(); // Unique-ID -> { phone, targets }
// שיחה נכנסת אמיתית מתחילה ברגל "inbound" מבחוץ (מהספק). חיוג Click-to-Call (גם מהתוסף בכרום) – אין לו רגל כזו
const fusionInbound = new Map(); // phone -> ts
esl.on('status', (state, text) => { if ((db.config.pbx || {}).type === 'fusion') pbxStatus = { state, at: now(), text }; });
esl.on('event', (e) => {
  const name = e['Event-Name'], uid = e['Unique-ID'];
  if (name === 'CHANNEL_CREATE') {
    // מרכזייה עם כמה לקוחות (דומיינים): מתעלמים מכל מה שלא שייך לדומיין שלנו – גם לא נרשם ביומן
    const myDomain = String((db.config.pbx || {}).domain || '').toLowerCase();
    const evDomain = String(e.variable_domain_name || e['Caller-Context'] || '').toLowerCase();
    const publicLeg = e['Call-Direction'] === 'inbound' && /^(public|default)?$/.test(String(e['Caller-Context'] || '').toLowerCase());
    if (myDomain && evDomain && evDomain !== myDomain && !publicLeg) return;
    // הרגל שמצלצלת בשלוחה של עובד (dialed_user) עם מספר חיצוני – שיחה נכנסת אליו
    const ext = String(e.variable_dialed_user || '').replace(/\D/g, '');
    const from = normPhone(e['Caller-Caller-ID-Number'] || '');
    const dirVar = String(e.variable_call_direction || '').toLowerCase();
    if (e['Call-Direction'] === 'inbound' && from && from.length >= 9) {
      fusionInbound.set(from, now());
      if (fusionInbound.size > 500) for (const [k, t] of fusionInbound) if (now() - t > 300000) fusionInbound.delete(k);
    }
    const realInbound = now() - (fusionInbound.get(from) || 0) < 180000;
    const incoming = e['Call-Direction'] === 'outbound' && ext && from && from.length >= 9 && (!dirVar || dirVar === 'inbound') && realInbound;
    if (!pbxLogged.has(uid) && (ext || from) && !publicLeg) {
      pbxLogged.add(uid); if (pbxLogged.size > 500) pbxLogged.clear();
      pbxLog.unshift({ at: now(), source: 'fusion', fields: { 'Call-Direction': e['Call-Direction'], call_direction: e.variable_call_direction || '', caller: e['Caller-Caller-ID-Number'] || '', destination: e['Caller-Destination-Number'] || '', dialed_user: e.variable_dialed_user || '', domain: e.variable_domain_name || '',
          context: e['Caller-Context'] || '', other_leg: e['Other-Leg-Unique-ID'] || e.variable_originator || '', inbound_leg_seen: realInbound ? 'כן' : 'לא' },
        parsed: { from: e['Caller-Caller-ID-Number'] || '', to: ext || e['Caller-Destination-Number'] || '', event: incoming ? 'נכנסת → חלון' : 'לא נכנסת → בלי חלון' } });
      pbxLog.length = Math.min(pbxLog.length, 30);
    }
    if (!incoming || pbxIgnored(from, ext) || now() - (recentDials.get(from) || 0) < 90000) return;
    const people = db.users.filter((u) => u.active !== false);
    let targets = people.filter((u) => u.ext && (u.ext === ext || ext.endsWith(u.ext)));
    if (!targets.length && !people.some((u) => u.ext)) targets = people;
    if (!targets.length) return;
    fusionCalls.set(uid, { phone: from, targets: targets.map((u) => u.id) });
    log(`📞 fusion call from ${from} to ext ${ext}`);
    const info = callInfo(from, { callId: uid, to: ext });
    for (const u of targets) sendTo(u.id, { type: 'call', call: info });
    sendCallWaInfo(info, targets).catch(() => {});
  } else if ((name === 'CHANNEL_ANSWER' || name === 'CHANNEL_HANGUP_COMPLETE') && fusionCalls.has(uid)) {
    const c = fusionCalls.get(uid);
    if (name === 'CHANNEL_HANGUP_COMPLETE') fusionCalls.delete(uid);
    for (const id of c.targets) sendTo(id, { type: 'call-end', phone: c.phone, callId: uid, answered: name === 'CHANNEL_ANSWER' });
  }
});
function fusionSync() {
  const c = db.config.pbx || {};
  const want = c.type === 'fusion' && c.enabled && c.eslHost ? JSON.stringify([c.eslHost, c.eslPort, c.eslPass]) : '';
  if (want === eslKey) return;
  eslKey = want;
  if (want) { pbxStatus = { state: 'wait', at: now(), text: 'מתחבר ל-FusionPBX...' }; esl.start({ host: c.eslHost, port: c.eslPort || 8021, password: c.eslPass || 'ClueCon' }); }
  else esl.stop();
}

async function pbxPoll() {
  if ((db.config.pbx || {}).type === 'fusion') { fusionSync(); return pbxSchedule(5000); }
  fusionSync();
  if (TEST_MODE) { pbxStatus = { state: 'off', at: now(), text: '🧪 מצב ניסיון – לא מחובר למרכזייה' }; return; }
  const c = db.config.pbx || {};
  if (!c.enabled || !c.user || !c.pass) { pbxStatus = { state: 'off', at: now(), text: 'כבוי' }; return pbxSchedule(5000); }
  try {
    const body = new URLSearchParams({ auth_username: c.user, auth_password: c.pass });
    const r = await fetch(process.env.HD_015_URL || `https://${String(c.host || 'www.015pbx.net').replace(/^https?:\/\//, '').replace(/\/+$/, '')}/api/json/calls/active/list/`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { throw new Error(`תשובה לא צפויה (${r.status}): ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}`); }
    const resp = Array.isArray(j.responses) ? j.responses[0] : null;
    if (resp && Number(resp.code) >= 300) throw new Error(`${resp.code} ${resp.message || ''}`);
    const list = Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : Array.isArray(j.calls) ? j.calls : [];
    pbxStatus = { state: 'ok', at: now(), text: `מחובר ✓ (${list.length} שיחות פעילות עכשיו)` };
    const seen = new Set();
    for (const call of list) {
      const f = flatten(call);
      const lid = String(f.uniqueid || f.callid || f.id || JSON.stringify(f));
      if (!pbxLogged.has(lid)) { // כל שיחה חדשה נרשמת פעם אחת – כדי לראות איך 015 מסמנים נכנסת/יוצאת
        pbxLogged.add(lid); if (pbxLogged.size > 500) pbxLogged.clear();
        const inc = isIncoming(f);
        pbxLog.unshift({ at: now(), fields: f, parsed: { ...pbxParse(f), event: inc ? 'נכנסת → חלון' : 'לא נכנסת → בלי חלון' }, source: '015' }); pbxLog.length = Math.min(pbxLog.length, 30);
      }
      if (!isIncoming(f)) continue; // רק שיחות נכנסות – לא יוצאות, לא פנימיות ולא חיוג מהמחשב
      const id = String(f.uniqueid || f.callid || f.id || (f.snumber || '') + '|' + (f.dnumber || ''));
      const from = normPhone(f.callerid_external || f.scallerid || f.callerid || f.snumber || f.from || '');
      if (!from || from.length < 9) continue;
      if (pbxIgnored(from, f.dnumber, f.cnumber)) continue; // 📵 ברשימת "לא להקפיץ"
      if (now() - (recentDials.get(from) || 0) < 90000) continue; // החיוג שלנו מהמוקד – לא שיחה נכנסת
      seen.add(id);
      if (activeCalls.has(id)) continue;
      activeCalls.set(id, from);
      const to = String(f.dnumber || f.cnumber || f.peer || '');
      const ext = to.replace(/\D/g, '');
      const people = db.users.filter((u) => u.active !== false);
      let targets = people.filter((u) => u.ext && [f.dnumber, f.cnumber, f.peer].some((x) => String(x || '').replace(/\D/g, '').endsWith(u.ext)));
      if (!targets.length) targets = people;
      log(`📞 015 call from ${from}${to ? ' to ' + to : ''}`);
      const info = callInfo(from, { callId: id, to: ext });
      for (const u of targets) sendTo(u.id, { type: 'call', call: info });
      sendCallWaInfo(info, targets).catch(() => {});
    }
    for (const [id, phone] of activeCalls) if (!seen.has(id)) { activeCalls.delete(id); emitAll({ type: 'call-end', phone, callId: id }); }
    pbxSchedule(2000);
  } catch (e) {
    pbxStatus = { state: 'error', at: now(), text: e.message };
    pbxSchedule(15000);
  }
}
pbxSchedule(3000);
// ---------- 📞 חיוג מהמוקד דרך 015: קודם מצלצל הקו של העובד, וכשהוא עונה – מחובר ללקוח ----------
const recentDials = new Map(); // phone -> ts – כדי לא להקפיץ "שיחה נכנסת" על החיוג שלנו
route('POST', /^\/api\/dial$/, async (req, res, { user }) => {
  const b = await readJson(req);
  const phone = normPhone(b.phone);
  if (!phone) return send(res, 400, { error: 'מספר טלפון לא תקין' });
  const c = db.config.pbx || {};
  if (!user.ext) return send(res, 400, { error: 'לא רשום לך קו טלפון – מנהל: ניהול ← 👥 עובדים ← עריכה ← "שלוחה / קו"' });
  const local = phone.startsWith('972') ? '0' + phone.slice(3) : phone;
  if (c.type === 'fusion') {
    // FusionPBX: מצלצלים בשלוחה של העובד (עם מענה אוטומטי), וכשעונה – מחייגים ללקוח דרך ה-dialplan של הדומיין
    if (!esl.ok) return send(res, 400, { error: 'אין חיבור ל-FusionPBX – מנהל: ניהול ← 📞 מרכזייה' });
    if (!c.domain) return send(res, 400, { error: 'חסר דומיין של FusionPBX – מנהל: ניהול ← 📞 מרכזייה' });
    recentDials.set(phone, now());
    const name = String(b.name || local).replace(/[^\p{L}\p{N} .\-]/gu, '').slice(0, 30) || local;
    const vars = [`origination_caller_id_name='${name}'`, `origination_caller_id_number=${local}`, 'sip_auto_answer=true', 'ignore_early_media=true',
      'call_direction=outbound', `domain_name=${c.domain}`, 'hangup_after_bridge=true'].join(',');
    const cmd = `originate {${vars}}user/${user.ext}@${c.domain} &transfer('${local} XML ${c.domain}')`;
    try {
      const job = await esl.api(cmd);
      log(`📞 ${user.name} dials ${local} (fusion, ext ${user.ext})`);
      // התוצאה מגיעה כשהשלוחה עונה (במענה אוטומטי – מיד) או נכשלת. מחכים עד 12 שניות
      const result = job ? await esl.waitJob(job, 12000) : null;
      pbxLog.unshift({ at: now(), source: 'fusion', fields: { action: 'חיוג (originate)', from_ext: user.ext, to: local, domain: c.domain, result: result === null ? '(עדיין מצלצל)' : result },
        parsed: { from: user.ext, to: local, event: result && result.startsWith('-ERR') ? 'חיוג נכשל' : 'חיוג' } });
      pbxLog.length = Math.min(pbxLog.length, 30);
      if (result && result.startsWith('-ERR')) {
        const code = result.replace(/^-ERR\s*/, '').trim();
        const why = { USER_NOT_REGISTERED: `השלוחה ${user.ext} לא מחוברת למרכזייה כרגע (הטלפון כבוי או לא רשום)`, SUBSCRIBER_ABSENT: `השלוחה ${user.ext} לא מחוברת`,
          NO_ANSWER: `השלוחה ${user.ext} לא ענתה`, NO_USER_RESPONSE: `השלוחה ${user.ext} לא ענתה`, USER_BUSY: `השלוחה ${user.ext} תפוסה`, CALL_REJECTED: 'השיחה נדחתה בטלפון',
          ORIGINATOR_CANCEL: 'החיוג בוטל', INVALID_NUMBER_FORMAT: 'מספר לא תקין', UNALLOCATED_NUMBER: `השלוחה ${user.ext} לא קיימת בדומיין ${c.domain}` }[code];
        return send(res, 502, { error: 'החיוג נכשל: ' + (why || code) });
      }
      return send(res, 200, { ok: true });
    } catch (e) { return send(res, 502, { error: 'החיוג נכשל: ' + e.message }); }
  }
  if (!c.user || !c.pass) return send(res, 400, { error: 'המרכזייה לא מחוברת – מנהל: ניהול ← 📞 מרכזייה ← חיבור ישיר' });
  recentDials.set(phone, now());
  try {
    const body = new URLSearchParams({ auth_username: c.user, auth_password: c.pass, stype: 'phone', snumber: user.ext, ctype: '', cnumber: local, callerid1: local, answer1: '1' }); // answer1=1: הטלפון של העובד עונה לבד
    const r = await fetch(process.env.HD_015_MAKE_URL || `https://${String(c.host || 'www.015pbx.net').replace(/^https?:\/\//, '').replace(/\/+$/, '')}/api/json/calls/make/`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    const resp = j && Array.isArray(j.responses) ? j.responses[0] : null;
    const code = resp ? Number(resp.code) : r.status;
    if (!r.ok || code >= 300) return send(res, 502, { error: 'החיוג נכשל: ' + ((resp && resp.message) || code) });
    log(`📞 ${user.name} dials ${local}`);
    send(res, 200, { ok: true });
  } catch (e) { send(res, 502, { error: 'החיוג נכשל: ' + e.message }); }
});

route('POST', /^\/api\/admin\/pbx$/, async (req, res) => {
  const b = await readJson(req);
  const old = db.config.pbx || {};
  db.config.pbx = { type: b.type === 'fusion' ? 'fusion' : '015', enabled: !!b.enabled, host: String(b.host || 'www.015pbx.net').trim(), user: String(b.user || '').trim(), pass: unmask(b.pass, old.pass) || '',
    eslHost: String(b.eslHost || '').trim(), eslPort: Number(b.eslPort) || 8021, eslPass: unmask(b.eslPass, old.eslPass) || '', domain: String(b.domain || '').trim() };
  store.saveConfig(); pbxSamples = 0; eslKey = ''; esl.stop();
  pbxStatus = { state: 'wait', at: now(), text: 'מתחבר...' };
  pbxSchedule(200);
  await sleep(2500);
  send(res, 200, pbxStatus);
}, { auth: 'admin' });
route('GET', /^\/api\/admin\/pbx-status$/, (req, res) => send(res, 200, pbxStatus), { auth: 'admin' });

route('POST', /^\/api\/pbx\/webhook$/, (req, res, { query }) => pbxWebhook(req, res, query), { auth: 'none' });
route('GET', /^\/api\/pbx\/webhook$/, (req, res, { query }) => pbxWebhook(req, res, query), { auth: 'none' });
route('GET', /^\/api\/admin\/pbx-log$/, (req, res) => send(res, 200, pbxLog), { auth: 'admin' });
route('POST', /^\/api\/admin\/pbx-key$/, (req, res) => { db.config.pbxKey = crypto.randomBytes(12).toString('hex'); store.saveConfig(); send(res, 200, { key: db.config.pbxKey }); }, { auth: 'admin' });
route('POST', /^\/api\/admin\/pbx-test$/, async (req, res, { user }) => {
  const b = await readJson(req);
  const call = { caller_id_number: normPhone(b.phone) || '972501234567', destination_number: user.ext || '', event: 'ringing' };
  pbxLog.unshift({ at: now(), fields: { ...call, test: 'בדיקה מהמסך' }, parsed: pbxParse(call) });
  const ci = callInfo(call.caller_id_number);
  sendTo(user.id, { type: 'call', call: ci });
  sendCallWaInfo(ci, [user]).catch(() => {});
  send(res, 200, { ok: true });
}, { auth: 'admin' });

// =====================================================================
// 📣 הפצה: שליחת וואטסאפ לקבוצת לקוחות (לפי מוצר מה-CRM) או לרשימת מספרים
// כל הודעה מקבלת פתיח/חתימה משתנים (לא שתי הודעות זהות), והפסקה בין שליחה לשליחה
// =====================================================================
const crm = require('./lib/crm');
const SEGMENTS = [
  { k: 'pbx015', label: '📞 מרכזייה 015', test: (c) => /015/.test(c.pbx) },
  { k: 'fusion', label: '📞 מרכזייה פיוזן', test: (c) => /פיוז|fusion/i.test(c.pbx) },
  { k: 'pbx', label: '📞 כל לקוחות המרכזייה', test: (c) => c.services.includes('מרכזיה') || !!c.pbx },
  { k: 'cloud', label: '🖥 שרת ענן', test: (c) => c.services.includes('שרתי ענן') },
  { k: 'm365', label: '✉️ מייל 365', test: (c) => c.services.includes('365') },
  { k: 'answering', label: '🎧 מענה אנושי', test: (c) => c.services.includes('מענה אנושי') },
  { k: 'internet', label: '🌐 אינטרנט', test: (c) => c.services.includes('אינטרנט') || c.services.includes('תשתיות תקשורת') },
  { k: 'all', label: '👥 כל הלקוחות הפעילים', test: () => true },
];
let crmCache = (() => { try { return JSON.parse(require('fs').readFileSync(require('path').join(store.DATA_DIR, 'crmcache.json'), 'utf8')); } catch { return null; } })();
let crmLoading = null;
async function crmLoad(force) {
  const url = (db.config.crm || {}).mcpUrl, key = (db.config.crm || {}).apiKey;
  if (!url && !key) throw new Error('ה-CRM לא מחובר – 📣 הפצה ← "חיבור ל-CRM"');
  if (!force && crmCache && now() - crmCache.at < 6 * 3600e3) return crmCache;
  if (crmLoading) return crmLoading;
  crmLoading = (async () => {
    const prog = (t) => emitAdmins({ type: 'bcast-progress', text: t });
    let list, debug = '';
    if (key) ({ list, debug } = await crm.apiActiveCustomers(key, prog));
    else list = await crm.activeCustomers(url, prog);
    crmCache = { at: now(), list, debug };
    try { require('fs').writeFileSync(require('path').join(store.DATA_DIR, 'crmcache.json'), JSON.stringify(crmCache)); } catch {}
    return crmCache;
  })();
  try { return await crmLoading; } finally { crmLoading = null; }
}
const emitAdmins = (ev) => { for (const u of admins()) sendTo(u.id, ev); };
const optedOut = (phone) => (db.config.optOut || []).includes(phone);
function segmentRecipients(key) {
  const seg = SEGMENTS.find((x) => x.k === key);
  if (!seg || !crmCache) return [];
  const seen = new Set();
  return crmCache.list.filter(seg.test).map((c) => ({ phone: normPhone(c.phone), name: c.name, company: c.company }))
    .filter((r) => r.phone && r.phone.length >= 11 && !seen.has(r.phone) && seen.add(r.phone));
}
// ✍️ גיוון: פתיח לפי שעה + שם, סימן פיסוק, חתימה ואימוג'י משתנים – כל הודעה שונה מהשנייה
function varyMessage(text, r, i) {
  const pick = (arr) => arr[(i * 7 + Math.floor(Math.random() * arr.length)) % arr.length];
  const h = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }));
  const timeGreet = h < 12 ? 'בוקר טוב' : h < 17 ? 'צהריים טובים' : 'ערב טוב';
  const first = String(r.name || '').trim().split(/\s+/)[0] || '';
  const okName = first && !/^[\d+]/.test(first);
  const greet = pick(['שלום', 'היי', timeGreet, 'שלום וברכה', 'הי', timeGreet]) + (okName ? ' ' + first : '') + pick([',', ' 👋', '!', ' 🙂', ',']);
  const sig = (db.config.broadcastSig || db.config.companyName || '').trim();
  const close = sig ? pick([`בברכה,\n${sig}`, `תודה,\n${sig}`, `${sig} 🙏`, `יום טוב,\n${sig}`, `בברכה, ${sig}`]) : pick(['תודה!', 'יום טוב 🙏', 'בברכה', 'תודה 🙂']);
  let body = String(text).replace(/\{name\}/g, okName ? first : '').replace(/\{company\}/g, r.company || '');
  return `${greet}\n\n${body.trim()}\n\n${close}`;
}
// רשימת מספרים מודבקת: מחברים חלקים של אותו מספר ("054 7654321") ומפרידים בין מספרים
function parseNumberList(text) {
  const out = []; let buf = '';
  const need = (d) => (/^972[57]/.test(d) ? 12 : /^972/.test(d) ? 11 : /^0[57]/.test(d) ? 10 : /^0/.test(d) ? 9 : 9);
  for (const t of String(text || '').split(/[\s,;]+/)) {
    const d = t.replace(/\D/g, ''); if (!d) continue;
    buf += d;
    if (buf.length >= need(buf)) { out.push(buf); buf = ''; }
  }
  return out;
}
let bcastJob = null;
async function runBroadcast(job) {
  const inst = instById(job.instanceId);
  for (let i = 0; i < job.items.length; i++) {
    if (job.cancel) break;
    const it = job.items[i];
    it.text = job.vary ? varyMessage(job.text, it, i) : job.text.replace(/\{name\}/g, String(it.name || '').split(' ')[0]);
    if (job.optOutLine) it.text += '\n\n(להסרה מרשימת התפוצה השיבו "הסר")';
    try {
      const r = await ga.sendMessage(inst, it.phone + '@c.us', it.text);
      if (r && r.idMessage) sentIds.add(r.idMessage);
      it.status = 'sent'; job.sent++;
    } catch (e) { it.status = 'failed'; it.error = e.message.slice(0, 120); job.failed++; }
    job.done = i + 1;
    emitAdmins({ type: 'bcast-job', job: jobView(job) });
    if (i < job.items.length - 1 && !job.cancel) await sleep(Math.max(3, job.delaySec) * 1000 + Math.floor(Math.random() * 1500));
  }
  job.finished = now(); job.running = false;
  log(`📣 broadcast "${job.title}": ${job.sent} sent, ${job.failed} failed`);
  emitAdmins({ type: 'bcast-job', job: jobView(job) });
}
const jobView = (j) => j && { id: j.id, title: j.title, total: j.items.length, done: j.done, sent: j.sent, failed: j.failed, running: j.running, cancel: !!j.cancel, finished: j.finished || 0,
  failures: j.items.filter((x) => x.status === 'failed').slice(0, 20).map((x) => ({ phone: x.phone, name: x.name, error: x.error })) };

route('POST', /^\/api\/admin\/crm$/, async (req, res) => {
  const b = await readJson(req);
  const old = db.config.crm || {};
  const apiKey = unmask(String(b.apiKey || '').trim(), old.apiKey) || '';
  const url = unmask(String(b.mcpUrl || '').trim(), old.mcpUrl) || '';
  if (!apiKey && url && (!/^https?:\/\//i.test(url) || /smartsalecrm\.co\.il\/(he|en)?\/?dashboard/i.test(url) || !/token=/i.test(url))) {
    return send(res, 200, { ok: false, error: 'זו לא כתובת החיבור. צריך את כתובת ה-MCP של SmartSale – מתחילה ב-https:// ומסתיימת ב-?token=... (לא הכתובת של מסך הלקוחות)' });
  }
  db.config.crm = { mcpUrl: apiKey ? '' : url, apiKey };
  if (b.broadcastSig !== undefined) db.config.broadcastSig = String(b.broadcastSig || '').slice(0, 80);
  store.saveConfig(); crmCache = null;
  try { const c = await crmLoad(true); send(res, 200, { ok: true, count: c.list.length }); }
  catch (e) { send(res, 200, { ok: false, error: e.message }); }
}, { auth: 'admin' });
route('GET', /^\/api\/admin\/broadcast\/segments$/, async (req, res, { query }) => {
  const cfg = { connected: !!((db.config.crm || {}).mcpUrl || (db.config.crm || {}).apiKey), mcpUrl: mask((db.config.crm || {}).mcpUrl), apiKey: mask((db.config.crm || {}).apiKey), debug: crmCache ? crmCache.debug || '' : '', broadcastSig: db.config.broadcastSig || db.config.companyName || '', optOutCount: (db.config.optOut || []).length };
  let error = '';
  if (cfg.connected) { try { await crmLoad(query.get('refresh') === '1'); } catch (e) { error = e.message; } }
  const segs = SEGMENTS.map((sg) => ({ k: sg.k, label: sg.label, count: segmentRecipients(sg.k).length }));
  const unknownPbx = crmCache ? crmCache.list.filter((c) => c.services.includes('מרכזיה') && !c.pbx).length : 0;
  const noService = crmCache ? crmCache.list.filter((c) => !c.services.length && !c.pbx).length : 0;
  send(res, 200, { ...cfg, error, at: crmCache ? crmCache.at : 0, total: crmCache ? crmCache.list.length : 0, segments: segs, unknownPbx, noService, job: jobView(bcastJob) });
}, { auth: 'admin' });
route('GET', /^\/api\/admin\/broadcast\/preview$/, (req, res, { query }) => {
  send(res, 200, segmentRecipients(query.get('segment')).map((r) => ({ ...r, optedOut: optedOut(r.phone) })));
}, { auth: 'admin' });
route('POST', /^\/api\/admin\/broadcast\/send$/, async (req, res, { user }) => {
  if (bcastJob && bcastJob.running) return send(res, 400, { error: 'כבר רצה הפצה – חכה שתסתיים או עצור אותה' });
  const b = await readJson(req);
  const text = String(b.text || '').trim();
  if (text.length < 3) return send(res, 400, { error: 'כתוב את נוסח ההודעה' });
  const inst = instById(b.instanceId) || db.config.instances.find((i) => i.enabled !== false);
  if (!inst) return send(res, 400, { error: 'בחר מספר וואטסאפ לשליחה' });
  let items = [];
  if (b.segment) items = segmentRecipients(b.segment);
  else items = [...new Set(parseNumberList(b.numbers).map(normPhone).filter((p) => p && p.length >= 11))].map((phone) => ({ phone, name: (contactFor(phone) || {}).name || '' }));
  const exclude = new Set((b.exclude || []).map(String));
  const staffPhones = new Set(db.users.map((u) => u.phone).filter(Boolean));
  items = items.filter((r) => !exclude.has(r.phone) && !optedOut(r.phone) && !staffPhones.has(r.phone)).map((r) => ({ ...r, status: 'wait' }));
  if (!items.length) return send(res, 400, { error: 'אין נמענים' });
  const seg = SEGMENTS.find((x) => x.k === b.segment);
  bcastJob = { id: store.newId(), title: seg ? seg.label : `${items.length} מספרים`, text, vary: b.vary !== false, optOutLine: !!b.optOutLine, delaySec: Math.max(3, Number(b.delaySec) || 3),
    instanceId: inst.id, items, done: 0, sent: 0, failed: 0, running: true, by: user.name, at: now() };
  log(`📣 broadcast "${bcastJob.title}" to ${items.length} by ${user.name}`);
  runBroadcast(bcastJob).catch((e) => { bcastJob.running = false; log('broadcast error', e.message); });
  send(res, 200, jobView(bcastJob));
}, { auth: 'admin' });
route('POST', /^\/api\/admin\/broadcast\/sample$/, async (req, res) => {
  const b = await readJson(req);
  const sample = [{ name: 'דני כהן' }, { name: 'מיכל' }, { name: '' }];
  send(res, 200, sample.map((r, i) => varyMessage(String(b.text || ''), r, i) + (b.optOutLine ? '\n\n(להסרה מרשימת התפוצה השיבו "הסר")' : '')));
}, { auth: 'admin' });
route('POST', /^\/api\/admin\/broadcast\/cancel$/, (req, res) => { if (bcastJob) bcastJob.cancel = true; send(res, 200, jobView(bcastJob)); }, { auth: 'admin' });

// ---------- 🔎 "למה הצ'אט לא נכנס?" – בדיקה לפי טלפון או שם ----------
route('GET', /^\/api\/admin\/diagnose$/, async (req, res, { query }) => {
  const q = String(query.get('q') || '').trim();
  if (!q) return send(res, 400, { error: 'כתוב טלפון או שם' });
  const phone = normPhone(q);
  const ql = q.toLowerCase();
  const out = [];
  for (const inst of db.config.instances) {
    const r = { instance: inst.name, enabled: inst.enabled !== false, state: instState[inst.id] || 'unknown', lastNotif: instLastNotif[inst.id] || null, chats: [] };
    try { const st = await ga.getSettings(inst); r.webhookUrl = st.webhookUrl || ''; r.incomingWebhook = st.incomingWebhook; } catch (e) { r.settingsError = e.message.slice(0, 100); }
    // צ'אטים שמתאימים: לפי טלפון, או לפי שם (צ'אטים שהמוקד ראה + אנשי קשר)
    const ids = new Set();
    if (phone && phone.length >= 9) ids.add(phone + '@c.us');
    for (const c of Object.values(db.waChats)) if (c.instanceId === inst.id && ((c.name || '').toLowerCase().includes(ql) || (phone && c.chatId.startsWith(phone)))) ids.add(c.chatId);
    for (const c of db.contacts) if ([c.name, c.company].some((x) => x && x.toLowerCase().includes(ql))) for (const p of c.phones) ids.add(p + '@c.us');
    for (const t of db.tickets) if (t.instanceId === inst.id && displayName(t).toLowerCase().includes(ql)) ids.add(t.chatId);
    for (const chatId of [...ids].slice(0, 6)) {
      const w = db.waChats[waKey(inst.id, chatId)];
      const ts = db.tickets.filter((t) => t.instanceId === inst.id && t.chatId === chatId).sort((a, b) => b.createdAt - a.createdAt);
      const open = ts.find((t) => t.status !== 'closed');
      let green = null;
      try { const h = await ga.getChatHistory(inst, chatId, 3); green = (Array.isArray(h) ? h : []).map(ga.parseHistoryItem).sort((a, b) => b.ts - a.ts).slice(0, 3).map((x) => ({ ts: x.ts, dir: x.dir, text: (x.text || '').slice(0, 60) })); } catch (e) { green = { error: e.message.slice(0, 80) }; }
      const senderPhone = chatId.split('@')[0];
      r.chats.push({
        chatId, name: (w && w.name) || (ts[0] && displayName(ts[0])) || waName(inst, chatId, '') || '',
        ignored: isIgnored(inst.id, chatId), ignoredByName: chatId.endsWith('@g.us') && ignoredByName(w && w.name),
        pinnedTo: (ruleFor(inst.id, chatId) && userById(ruleFor(inst.id, chatId).userId)?.name) || '',
        staff: (staffByPhone(senderPhone) || {}).name || '',
        tech: serviceTargets().some((x) => normPhone(x.phone) === senderPhone || x.chatId === chatId),
        seen: w ? { ts: w.ts, dir: w.dir, text: (w.text || '').slice(0, 60) } : null,
        open: open ? { id: open.id, status: open.status, assignee: userById(open.assigneeId)?.name || '', snoozed: !!open.snoozeUntil } : null,
        last: ts[0] && ts[0] !== open ? { id: ts[0].id, status: ts[0].status, closedAt: ts[0].closedAt || 0 } : null,
        green,
      });
    }
    out.push(r);
  }
  send(res, 200, out);
}, { auth: 'admin' });

// ---------- מסך "💬 וואטסאפ" ----------
function waGuard(user, res) { if (!canWa(user)) { send(res, 403, { error: 'אין לך הרשאה למסך הוואטסאפ – מנהל יכול להוסיף בניהול ← עובדים' }); return false; } return true; }
route('GET', /^\/api\/wa\/chats$/, async (req, res, { user, query }) => {
  if (!waGuard(user, res)) return;
  const inst = instById(query.get('inst'));
  if (!inst) return send(res, 400, { error: 'בחר מספר' });
  await waSeed(inst);
  const q = String(query.get('q') || '').trim().toLowerCase();
  const qd = q.replace(/\D/g, '').replace(/^0/, '');
  const match = (c) => !q || (c.name || '').toLowerCase().includes(q) || (qd.length >= 3 && c.chatId.includes(qd));
  let list = Object.values(db.waChats).filter((c) => c.instanceId === inst.id).map(waChatView).filter(match).sort((a, b) => b.ts - a.ts);
  if (q) for (const c of waContacts.values()) if (c.instanceId === inst.id && match(c) && !db.waChats[waKey(c.instanceId, c.chatId)]) list.push(waChatView(c));
  send(res, 200, list.slice(0, q ? 200 : 400));
});
route('GET', /^\/api\/wa\/history$/, async (req, res, { user, query }) => {
  if (!waGuard(user, res)) return;
  const inst = instById(query.get('inst')); const chatId = String(query.get('chat') || '');
  if (!inst || !chatId) return send(res, 400, { error: 'חסר צ׳אט' });
  const count = Math.max(20, Math.min(1000, Number(query.get('count')) || 60));
  try {
    const list = await ga.getChatHistory(inst, chatId, count);
    const items = (Array.isArray(list) ? list : []).map(ga.parseHistoryItem).sort((a, b) => a.ts - b.ts);
    // מי מהצוות שלח (לפי ההודעות השמורות בקריאות)
    for (const it of items) if (it.dir === 'out') { const f = findMessageByIdMessage(it.id); if (f && f.m.byName) it.byName = f.m.byName; }
    send(res, 200, { chat: waChatView(db.waChats[waKey(inst.id, chatId)] || { instanceId: inst.id, chatId, isGroup: chatId.endsWith('@g.us') }), items, more: items.length >= count });
  } catch (e) { send(res, 502, { error: 'לא הצלחתי למשוך את ההודעות מ-Green API: ' + e.message }); }
});
route('POST', /^\/api\/wa\/send$/, async (req, res, { user }) => {
  if (!waGuard(user, res)) return;
  const b = await readJson(req);
  const inst = instById(b.inst); const chatId = String(b.chat || '');
  const text = String(b.text || '').trim();
  if (!inst || !chatId || !text) return send(res, 400, { error: 'הודעה ריקה' });
  const quoted = b.quotedId ? { id: String(b.quotedId), text: String(b.quotedText || '').slice(0, 300), from: String(b.quotedFrom || '') } : null;
  try {
    const t = openTicketFor(inst.id, chatId);
    let idMessage;
    if (t) {
      // יש קריאה פתוחה – נרשם גם בקריאה (מי ענה)
      if (t.status === 'routing') { clearRouting(t); t.status = 'open'; if (!t.assigneeId) t.assigneeId = user.id; note(t, `👤 ${user.name} ענה/תה מהמסך "וואטסאפ"`); }
      const msg = await sendText(t, text, user, { quoted });
      idMessage = msg.idMessage;
    } else {
      const r = await ga.sendMessage(inst, chatId, text, quoted && quoted.id);
      idMessage = r && r.idMessage;
      if (idMessage) sentIds.add(idMessage);
      quietMark.set(inst.id + '|' + chatId, { at: now(), userId: user.id });
    }
    const c = waUpsert(inst.id, chatId, { ts: now(), text, dir: 'out' });
    store.saveWaChats();
    const item = { id: idMessage, dir: 'out', ts: now(), type: 'text', text, byName: user.name, status: 'sent', ...(quoted ? { quoted } : {}) };
    for (const id of waAudience()) sendTo(id, { type: 'wa', chat: waChatView(c), message: item });
    send(res, 200, item);
  } catch (e) { send(res, 502, { error: 'השליחה נכשלה: ' + e.message }); }
});
route('POST', /^\/api\/wa\/upload$/, async (req, res, { user, query }) => {
  if (!waGuard(user, res)) return;
  const inst = instById(query.get('inst')); const chatId = String(query.get('chat') || '');
  if (!inst || !chatId) return send(res, 400, { error: 'חסר צ׳אט' });
  const fileName = decodeURIComponent(req.headers['x-file-name'] || 'file');
  const caption = decodeURIComponent(req.headers['x-caption'] || '');
  const mime = req.headers['content-type'] || 'application/octet-stream';
  let buf;
  try { buf = await readBody(req, 60 * 1024 * 1024); } catch { return send(res, 413, { error: 'הקובץ גדול מדי (עד 60MB)' }); }
  try {
    const r = await ga.sendFile(inst, chatId, buf, fileName, mime, caption);
    if (r && r.idMessage) sentIds.add(r.idMessage);
    const type = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';
    const t = openTicketFor(inst.id, chatId);
    if (t) { addMessage(t, { dir: 'out', type, text: caption, fileName, mime, url: r && r.urlFile || '', idMessage: r && r.idMessage, byUserId: user.id, byName: user.name, status: 'sent' }); t.awaiting = false; t.lastOutAt = now(); emitTicket(t); }
    const c = waUpsert(inst.id, chatId, { ts: now(), text: caption || ({ image: '📷 תמונה', video: '🎬 וידאו', audio: '🎤 הקלטה' }[type] || '📎 ' + fileName), dir: 'out' });
    store.saveWaChats();
    const item = { id: r && r.idMessage, dir: 'out', ts: now(), type, text: caption, fileName, url: r && r.urlFile || '', byName: user.name, status: 'sent' };
    for (const id of waAudience()) sendTo(id, { type: 'wa', chat: waChatView(c), message: item });
    send(res, 200, item);
  } catch (e) { send(res, 502, { error: 'השליחה נכשלה: ' + e.message }); }
});

// ---------- קריאת שירות לטכנאי (עידן) ----------
// העובד במערכת שמשויך ליעד (לפי בחירה בניהול, או עובד באותו שם)
const targetUser = (x) => (x.userId && userById(x.userId)) || db.users.find((u) => u.active !== false && u.name.trim() === String(x.name || '').trim()) || null;
const serviceTargets = () => (db.config.serviceTargets || []).filter((x) => x.name && (x.phone || x.chatId));
// הודעה ללקוח כשנפתחת קריאת שירות ("אני מטפלת")
const SERVICE_CUSTOMER_MSG = 'היי{name} 👋\nפתחתי עבורך קריאת שירות (מס׳ {id}) – אני מטפלת בזה ואעדכן אותך בהקדם 🙏';
function fillCustomerMsg(t, tpl) {
  const dn = displayName(t);
  const nm = !t.isGroup && dn && !/^[\d+\s-]+$/.test(dn) ? ' ' + dn.split(' ')[0] : '';
  return String(tpl).replace(/\{name\}/g, nm).replace(/\{id\}/g, t.id);
}
route('GET', /^\/api\/tickets\/(\d+)\/service-call$/, async (req, res, { user, params }) => {
  const t = visibleTicket(user, params[0]);
  if (!t) return send(res, 404, { error: 'לא נמצא' });
  const s = summary(t);
  const ins = store.messages(t.id).filter((m) => m.dir === 'in');
  // בקבוצה: הפונה = מי שכתב לאחרונה (לא הקבוצה עצמה)
  let customer = s.customerName, company = s.company || '', phone = t.isGroup ? '' : t.phone;
  if (t.isGroup) {
    let lastSender = [...ins].reverse().find((m) => m.senderPhone && !m.staff);
    if (!lastSender) {
      // הודעות ישנות בלי טלפון שולח – מנסים מההיסטוריה של וואטסאפ
      try {
        const inst = instById(t.instanceId);
        const hist = inst ? await ga.getChatHistory(inst, t.chatId, 30) : [];
        const staffPhones = new Set(db.users.map((u) => u.phone).filter(Boolean));
        const h = (Array.isArray(hist) ? hist : []).find((x) => x.type === 'incoming' && x.senderId && /@c\.us$/.test(x.senderId) && !staffPhones.has(x.senderId.split('@')[0]));
        if (h) lastSender = { senderPhone: h.senderId.split('@')[0], senderName: h.senderName || '' };
      } catch {}
    }
    if (lastSender) {
      phone = lastSender.senderPhone;
      const ct = contactFor(phone);
      customer = ct && ct.name ? ct.name : lastSender.senderName || phone;
      company = ct && ct.company ? ct.company : t.customerName;
    }
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const recent = ins.filter((m) => m.ts >= today.getTime());
  const msgs = (recent.length ? recent : ins.slice(-8)).map((m) => (m.senderName ? m.senderName + ': ' : '') + (m.text || `[${m.type}]`));
  send(res, 200, {
    targets: serviceTargets().map((x) => ({ id: x.id, name: x.name, isGroup: !!x.chatId, phone: x.phone || '', userName: targetUser(x)?.name || '' })),
    currentAssignee: userById(t.assigneeId)?.name || '',
    customer, company, phone, isGroup: !!t.isGroup, ticketStatus: t.status,
    customerMsg: fillCustomerMsg(t, db.config.serviceCustomerMsg || SERVICE_CUSTOMER_MSG),
    customerMsgRaw: db.config.serviceCustomerMsg || SERVICE_CUSTOMER_MSG,
    description: t.aiSummary ? t.aiSummary + '\n\nמה שהלקוח כתב:\n' + msgs.join('\n') : msgs.join('\n'),
  });
});
route('POST', /^\/api\/tickets\/(\d+)\/service-call$/, async (req, res, { user, params }) => {
  const t = visibleTicket(user, params[0]);
  if (!t) return send(res, 404, { error: 'לא נמצא' });
  const b = await readJson(req);
  const target = serviceTargets().find((x) => x.id === b.targetId) || serviceTargets()[0];
  if (!target) return send(res, 400, { error: 'לא הוגדרו יעדים לקריאת שירות (ניהול ← כללי)' });
  const chatId = target.chatId || (normPhone(target.phone) + '@c.us');
  const inst = (target.instanceId && instById(target.instanceId)) || instById(t.instanceId) || db.config.instances.find((i) => i.enabled !== false);
  if (!inst) return send(res, 400, { error: 'אין מספר וואטסאפ לשליחה' });
  const text = String(b.text || '').trim();
  if (!text) return send(res, 400, { error: 'הקריאה ריקה' });
  let sentId = null;
  try {
    const r = await ga.sendMessage(inst, chatId, text);
    if (r && r.idMessage) { sentIds.add(r.idMessage); sentId = r.idMessage; }
  } catch (e) { return send(res, 502, { error: 'השליחה נכשלה: ' + e.message }); }
  note(t, `🛠 ${user.name} שלח/ה קריאת שירות ל${target.name}:\n${text}`);
  t.serviceCalls = (t.serviceCalls || 0) + 1;
  t.serviceCallList = [...(t.serviceCallList || []), { targetId: target.id, idMessage: sentId, ts: now() }];
  // הקצאה לעובד של היעד (למשל עידן)
  // בחירת עובד מתוך החלון (כשהיעד עוד לא מקושר) – ואפשר לזכור את הקישור לפעם הבאה
  const picked = b.assignUserId && userById(b.assignUserId);
  if (picked && b.rememberLink && user.role === 'admin') {
    const real = (db.config.serviceTargets || []).find((x) => x.id === target.id);
    if (real) { real.userId = picked.id; store.saveConfig(); }
  }
  const tu = picked || targetUser(target);
  if (tu && t.assigneeId !== tu.id && t.status !== 'closed') {
    const old = t.assigneeId;
    t.assigneeId = tu.id;
    if (t.status === 'routing') { t.status = 'open'; clearRouting(t); }
    note(t, `↪️ הקריאה הוקצתה ל${tu.name}`);
    if (old && old !== tu.id && userById(old)?.role !== 'admin') sendTo(old, { type: 'remove', id: t.id });
  }
  // הודעה ללקוח: "אני מטפלת"
  let customerSent = false, customerError = '';
  const ctext = String(b.customerText || '').trim();
  if (b.notifyCustomer && ctext && t.status !== 'closed') {
    try { await sendText(t, ctext, user); customerSent = true; } catch (e) { customerError = e.message; note(t, '⚠️ ההודעה ללקוח לא נשלחה: ' + e.message); }
  }
  if (b.saveCustomerMsg && user.role === 'admin' && b.customerTemplate) { db.config.serviceCustomerMsg = String(b.customerTemplate); store.saveConfig(); }
  emitTicket(t, { sound: tu ? 'new' : null });
  send(res, 200, { ok: true, target: target.name, customerSent, customerError });
});
// ---------- מאנדיי: "העבר לויקאט" (שינוי סטטוס קריאה בלוח של ויקאט) ----------
// הרובוט רץ בנפרד על השרת (/opt/monday-bot, שירות monday-bot) – אם הוא לא קיים, הכפתור לא מופיע
const MONDAY_BOT = process.env.MONDAY_BOT_URL || 'http://127.0.0.1:8099';
let mondayOk = false;
const checkMonday = () => fetch(MONDAY_BOT + '/health', { signal: AbortSignal.timeout(3000) }).then((r) => { mondayOk = r.ok; }).catch(() => { mondayOk = false; });
checkMonday(); setInterval(checkMonday, 2 * 60 * 1000);
async function mondayCall(p, body) {
  let r;
  try { r = await fetch(MONDAY_BOT + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(150000) }); }
  catch (e) { throw new Error('רובוט המאנדיי לא זמין (systemctl status monday-bot)'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'מאנדיי: שגיאה ' + r.status);
  return j;
}
route('POST', /^\/api\/tickets\/(\d+)\/monday-vcat$/, async (req, res, { user, params }) => {
  const t = visibleTicket(user, params[0]);
  if (!t) return send(res, 404, { error: 'לא נמצא' });
  if (!t.isGroup) return send(res, 400, { error: 'העברה לויקאט במאנדיי עובדת רק לקריאות מקבוצה' });
  const b = await readJson(req);
  try {
    let item = b.itemId ? { id: String(b.itemId), name: String(b.itemName || '') } : null;
    if (!item) {
      const r = await mondayCall('/find', { group: t.customerName });
      if (r.items.length !== 1) return send(res, 200, { ok: false, items: r.items, all: r.all });
      item = r.items[0];
    }
    const r = await mondayCall('/set', { group: t.customerName, id: item.id });
    note(t, `🔁 ${user.name} העביר/ה לויקאט במאנדיי: "${r.name || item.name}" ← ${r.status}`);
    t.mondayItemId = item.id;
    emitTicket(t);
    send(res, 200, { ok: true, name: r.name || item.name });
  } catch (e) { send(res, 502, { error: e.message }); }
});
// קבוצות שהמוקד מכיר (לבחירת יעד) – מתוך הקריאות
route('GET', /^\/api\/admin\/known-groups$/, (req, res) => {
  const seen = new Map();
  for (const t of db.tickets) if (t.isGroup && !seen.has(t.chatId)) seen.set(t.chatId, { chatId: t.chatId, name: t.customerName, instanceId: t.instanceId, instanceName: instById(t.instanceId)?.name || '' });
  send(res, 200, [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'he')));
}, { auth: 'admin' });

// ---------- תבניות הודעה ----------
route('GET', /^\/api\/templates$/, (req, res) => send(res, 200, db.config.templates));
route('POST', /^\/api\/templates$/, async (req, res) => {
  const b = await readJson(req);
  const title = String(b.title || '').trim(), text = String(b.text || '').trim();
  if (!title || !text) return send(res, 400, { error: 'צריך כותרת ותוכן' });
  let t = b.id && db.config.templates.find((x) => x.id === b.id);
  if (!t) { t = { id: store.newId() }; db.config.templates.push(t); }
  Object.assign(t, { title, text });
  store.saveConfig();
  emitAll({ type: 'templates' });
  send(res, 200, t);
});
route('DELETE', /^\/api\/templates\/(\w+)$/, (req, res, { params }) => {
  db.config.templates = db.config.templates.filter((x) => x.id !== params[0]);
  store.saveConfig();
  emitAll({ type: 'templates' });
  send(res, 200, { ok: true });
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
  if (Array.isArray(b.serviceTargets)) {
    c.serviceTargets = b.serviceTargets.map((x) => ({
      id: x.id || store.newId(), name: String(x.name || '').trim(), userId: x.userId || null,
      ...(x.chatId ? { chatId: String(x.chatId), instanceId: x.instanceId || null } : { phone: normPhone(x.phone) }),
    })).filter((x) => x.name && (x.phone || x.chatId));
  }
  if (b.autoSaveContacts !== undefined) c.autoSaveContacts = !!b.autoSaveContacts;
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
    u = { id: store.newId(), seenVersion: VERSION };
    db.users.push(u);
  }
  if (u.id === user.id && b.role !== 'admin') return send(res, 400, { error: 'אי אפשר להוריד לעצמך הרשאת מנהל' });
  Object.assign(u, { name: String(b.name || username), username, role: b.role === 'admin' ? 'admin' : 'agent', active: b.active !== false, phone: normPhone(b.phone), waAccess: !!b.waAccess, ext: String(b.ext || '').replace(/\D/g, ''), quickClose: !!b.quickClose });
  if (b.password) Object.assign(u, hashPassword(b.password));
  store.saveUsers();
  send(res, 200, publicUser(u));
}, { auth: 'admin' });

// דוח לאקסל (CSV): קריאה בכל שורה – לקוח, עובד, זמני המתנה וטיפול, מה בוצע, הערות
route('GET', /^\/api\/admin\/export$/, (req, res, { query }) => {
  const period = query.get('period') || 'month';
  const scope = query.get('scope') || 'closed';
  const d = new Date();
  const start = period === 'today' ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    : period === 'week' ? now() - 7 * 864e5 : period === 'month' ? now() - 30 * 864e5 : 0;
  const list = db.tickets.filter((t) => scope === 'closed' ? t.status === 'closed' && (t.closedAt || 0) >= start : (t.createdAt || 0) >= start)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const tz = db.config.hours?.tz || 'Asia/Jerusalem';
  const fmt = (ts) => (ts ? new Date(ts).toLocaleString('he-IL', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  const mins = (ms) => (ms == null || ms < 0 ? '' : Math.round(ms / 60000));
  const phoneLocal = (p) => (p && p.startsWith('972') ? '0' + p.slice(3) : p || '');
  const head = ['מספר קריאה', 'סטטוס', 'נפתחה', 'נסגרה', 'לקוח', 'חברה', 'טלפון', 'קבוצה', 'מספר וואטסאפ', 'מחלקה', 'עובד מטפל', 'נסגרה ע"י',
    'המתנה לתשובה ראשונה (דק׳)', 'זמן טיפול כולל (דק׳)', 'הודעות לקוח', 'הודעות שלנו', 'קריאות שירות', 'מה בוצע', 'הערות פנימיות', 'סיכום AI'];
  const rows = list.map((t) => {
    const s2 = summary(t);
    const msgs = store.messages(t.id);
    const firstIn = msgs.find((m) => m.dir === 'in');
    const firstReply = firstIn && msgs.find((m) => m.dir === 'out' && !m.auto && m.ts >= firstIn.ts);
    return [t.id, t.status === 'closed' ? 'סגורה' : t.snoozeUntil ? 'מושהית' : 'פתוחה', fmt(t.createdAt), fmt(t.closedAt), s2.customerName, s2.company || '',
      t.isGroup ? '' : phoneLocal(t.phone), t.isGroup ? 'כן' : '', s2.instanceName, s2.departmentName, s2.assigneeName, userById(t.closedBy)?.name || '',
      firstIn && firstReply ? mins(firstReply.ts - firstIn.ts) : '', t.closedAt ? mins(t.closedAt - t.createdAt) : '',
      msgs.filter((m) => m.dir === 'in').length, msgs.filter((m) => m.dir === 'out' && !m.auto).length, t.serviceCalls || 0,
      t.resolution || '', msgs.filter((m) => m.internal).map((m) => `${m.byName}: ${m.text}`).join(' | '), t.aiSummary || ''];
  });
  const cell = (v) => { const x = String(v ?? ''); return /[",\n\r]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
  const csv = '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const name = `helpdesk-${scope}-${period}-${new Date().toISOString().slice(0, 10)}.csv`;
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.end(csv);
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

// עדכון חד-פעמי (גרסה 11): מחלקת מכירות → נועה
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
    // (כלל הניתוב של דויד מוגדר בשרת עצמו, ב"ניתוב לפי איש קשר" – לא בקוד)
  }
  if (noa) db.config.migratedV11 = true; // אם עוד אין עובדת בשם נועה – ננסה שוב בהפעלה הבאה
  store.saveConfig();
  log('migration v11:', noa ? `sales → ${noa.name}` : 'Noa not found – skipped');
})();

// חד-פעמי: חיים (המנהל) יכול לסגור קריאה בלי לכתוב מה בוצע
if (!db.config.quickCloseMigrated) {
  const chaim = db.users.find((u) => u.role === 'admin' && /חיים/.test(u.name));
  if (chaim) { chaim.quickClose = true; db.config.quickCloseMigrated = true; store.saveUsers(); store.saveConfig(); }
}
if (!db.config.pbxKey) { db.config.pbxKey = crypto.randomBytes(12).toString('hex'); store.saveConfig(); }

// חד-פעמי (גרסה 20): הקבוצה "KC + VCAT" כיעד לקריאת שירות, אם המוקד כבר מכיר אותה
(function addVcatTarget() {
  if (db.config.vcatTargetAdded) return;
  const g = db.tickets.find((t) => t.isGroup && /VCAT/i.test(t.customerName));
  if (!g) return; // ננסה שוב בהפעלה הבאה
  if (!(db.config.serviceTargets || []).some((x) => x.chatId === g.chatId)) {
    db.config.serviceTargets = [...(db.config.serviceTargets || []), { id: store.newId(), name: g.customerName, chatId: g.chatId, instanceId: g.instanceId }];
  }
  db.config.vcatTargetAdded = true;
  store.saveConfig();
  log('service target added:', g.customerName);
})();

// חד-פעמי (גרסה 17): התבניות של KC Group
(function seedTemplates() {
  if (db.config.templatesSeeded) return;
  const T = (title, text) => ({ id: store.newId(), title, text });
  db.config.templates = [
    T('הצעה', 'KC Group – כל פתרונות המחשוב והתקשורת לעסק במקום אחד\n\n• מרכזיות IP וטלפוניה בענן\n• תשתיות תקשורת ורשתות\n• פתרונות מחשוב, שרתים וענן\n• ציוד מחשוב וציוד היקפי\n• גיבוי והמשכיות עסקית\n• שירותי IT, תחזוקה ותמיכה שוטפת\n\nלהלן הצעת המחיר :'),
    T('תחזור אלינו', 'הי אשמח שתשלח הודעה כאשר אתה יכול לדבר תודה רבה\nקי סי גרופ תקשורת לעסקים'),
    T('אם תרצה', 'הי שלחתי לך הצעה אבל אתה לא עונה לי אם תרצה להתקדם נשמח אם תיצור קשר'),
    T('לקוח שלא סוגר', 'רק חשוב לי שתדעו שאנחנו ב־KC Group נותנים מעטפת מלאה לעסקים בכל מה שקשור ל־\n📞 מרכזיות וטלפוניה לעסקים\n💻 מחשוב ותמיכה טכנית\n🌐 תקשורת, רשתות וסיבים\n📹 מצלמות ואבטחה\n🔐 אבטחת מידע ופתרונות מתקדמים לעסק\n\nככה שאם בעתיד עולה צורך, תקלה, שדרוג או פרויקט חדש – יש לכם כתובת אחת מסודרת לכל התחום 🙌\nנשמח לעמוד לרשותכם בכל זמן 💙'),
    ...db.config.templates,
  ];
  db.config.templatesSeeded = true;
  store.saveConfig();
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

// אחסון פשוט בקבצי JSON בתיקייה data/ (מתאים למשרד קטן, בלי מסד נתונים)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.HD_DATA || path.join(__dirname, '..', 'data');
const MSG_DIR = path.join(DATA_DIR, 'messages');
fs.mkdirSync(MSG_DIR, { recursive: true });

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch { return def; }
}
function writeJsonNow(file, value) {
  const full = path.join(DATA_DIR, file);
  const tmp = full + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, full);
}
const timers = {};
function writeJson(file, value) {
  clearTimeout(timers[file]);
  timers[file] = setTimeout(() => { try { writeJsonNow(file, value); } catch (e) { console.error('save', file, e.message); } }, 200);
}
function flushAll() {
  for (const f of Object.keys(timers)) clearTimeout(timers[f]);
  try { writeJsonNow('config.json', db.config); writeJsonNow('users.json', db.users); writeJsonNow('tickets.json', db.tickets); writeJsonNow('sessions.json', db.sessions); } catch {}
}

const DEFAULT_CONFIG = {
  port: 8080,
  host: '127.0.0.1', // '0.0.0.0' = נגיש גם ממחשבים אחרים ברשת
  companyName: 'המשרד',
  instances: [], // { id, name, idInstance, token, apiUrl, mediaUrl, enabled }
  departments: [], // { id, name, description, userId }
  ai: { enabled: true, apiKey: '', model: 'claude-opus-5-5' },
  routeDelaySec: 15, // מחכים כמה שניות להודעות נוספות לפני ניתוב
  groups: { enabled: true, autoReply: false }, // הודעות מקבוצות פותחות קריאות; בלי מענה אוטומטי לקבוצה
  ignoredChats: [], // { instanceId, chatId, name } – צ'אטים/קבוצות שלא פותחים מהם קריאות
  autoReply: {
    enabled: true,
    routed: 'שלום{name}, קיבלנו את פנייתך 🙏\nהיא הועברה ל{agent} ({department}). נחזור אליך בהקדם.',
    unknown: 'שלום{name}, קיבלנו את פנייתך 🙏\nנחזור אליך בהקדם.',
  },
};

const db = {
  config: Object.assign({}, DEFAULT_CONFIG, readJson('config.json', {})),
  users: readJson('users.json', []),
  tickets: readJson('tickets.json', []),
  sessions: readJson('sessions.json', {}),
};
db.config.ai = Object.assign({}, DEFAULT_CONFIG.ai, db.config.ai);
db.config.autoReply = Object.assign({}, DEFAULT_CONFIG.autoReply, db.config.autoReply);
db.config.groups = Object.assign({}, DEFAULT_CONFIG.groups, db.config.groups);
db.config.ignoredChats = db.config.ignoredChats || [];

const newId = () => crypto.randomBytes(6).toString('hex');

// ---------- הודעות: קובץ לכל קריאה ----------
const msgCache = new Map();
function messages(ticketId) {
  if (!msgCache.has(ticketId)) {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(path.join(MSG_DIR, ticketId + '.json'), 'utf8')); } catch {}
    msgCache.set(ticketId, list);
  }
  return msgCache.get(ticketId);
}
function saveMessages(ticketId) {
  const list = messages(ticketId);
  clearTimeout(timers['m' + ticketId]);
  timers['m' + ticketId] = setTimeout(() => {
    try {
      const full = path.join(MSG_DIR, ticketId + '.json');
      fs.writeFileSync(full + '.tmp', JSON.stringify(list));
      fs.renameSync(full + '.tmp', full);
    } catch (e) { console.error('save msgs', e.message); }
    if (msgCache.size > 300) msgCache.delete(msgCache.keys().next().value);
  }, 200);
}

module.exports = {
  DATA_DIR,
  db,
  newId,
  messages,
  saveMessages,
  saveConfig: () => writeJson('config.json', db.config),
  saveUsers: () => writeJson('users.json', db.users),
  saveTickets: () => writeJson('tickets.json', db.tickets),
  saveSessions: () => writeJson('sessions.json', db.sessions),
  flushAll,
};

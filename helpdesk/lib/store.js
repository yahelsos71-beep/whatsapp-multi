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
  try { writeJsonNow('config.json', db.config); writeJsonNow('users.json', db.users); writeJsonNow('tickets.json', db.tickets); writeJsonNow('sessions.json', db.sessions); writeJsonNow('contacts.json', db.contacts); } catch {}
}

const DEFAULT_CONFIG = {
  port: 8080,
  host: '127.0.0.1', // '0.0.0.0' = נגיש גם ממחשבים אחרים ברשת
  companyName: 'המשרד',
  instances: [], // { id, name, idInstance, token, apiUrl, mediaUrl, enabled }
  departments: [], // { id, name, description, userId }
  ai: { enabled: true, apiKey: '', model: 'claude-opus-5-5', intake: true, maxQuestions: 3, waitMinutes: 10, replyDelaySec: 8 },
  routeDelaySec: 15, // מחכים כמה שניות להודעות נוספות לפני ניתוב
  groups: { enabled: true, autoReply: false }, // הודעות מקבוצות פותחות קריאות; בלי מענה אוטומטי לקבוצה
  ignoredChats: [], // { instanceId, chatId, name } – צ'אטים/קבוצות שלא פותחים מהם קריאות
  hours: {
    enabled: true, tz: 'Asia/Jerusalem', days: [0, 1, 2, 3, 4], start: '08:15', end: '17:00',
    message: 'שלום{name} 🙏\nהמשרד סגור כעת. אנו פתוחים בימים א׳–ה׳ בין 8:15 ל-17:00.\nלפתיחת קריאה מחוץ לשעות הפעילות אנא התקשרו ל-\u200E*8349',
  },
  quietMinutes: 30, // אחרי שעובד ענה ללקוח – הבוט שותק כך וכך דקות
  ignoreGroupNames: ['פורום מתקינים', 'מתח נמוך'], // קבוצות שמתעלמים מהן לפי חלק מהשם
  personRules: [], // { phone, name, userId } – פנייה מהמספר הזה, או מקבוצה שהוא חבר בה, הולכת ישר לעובד
  chatRules: [], // { instanceId, chatId, name, isGroup, userId } – צ'אט/קבוצה שמשויכים קבוע לעובד
  autoReply: {
    enabled: true,
    routed: 'שלום{name}, קיבלנו את פנייתך 🙏\nנפתחה קריאה ל{department}. נחזור אליך בהקדם.',
    unknown: 'שלום{name}, קיבלנו את פנייתך 🙏\nנחזור אליך בהקדם.',
  },
};

const db = {
  config: Object.assign({}, DEFAULT_CONFIG, readJson('config.json', {})),
  users: readJson('users.json', []),
  tickets: readJson('tickets.json', []),
  sessions: readJson('sessions.json', {}),
  contacts: readJson('contacts.json', []), // { id, company, name, phones: ['9725...'], source: 'import'|'manual' }
};
db.config.ai = Object.assign({}, DEFAULT_CONFIG.ai, db.config.ai);
db.config.autoReply = Object.assign({}, DEFAULT_CONFIG.autoReply, db.config.autoReply);
db.config.groups = Object.assign({}, DEFAULT_CONFIG.groups, db.config.groups);
// עדכון הגדרות ישנות: בלי שם עובד בהודעה ללקוח, ושאלות מקדימות ברירת מחדל
if (/\{agent\}/.test(db.config.autoReply.routed)) db.config.autoReply.routed = DEFAULT_CONFIG.autoReply.routed;
const DEFAULT_QUESTIONS = [
  [/מרכזי/, 'איזה קו / שלוחה? מה בדיוק לא עובד (שיחות נכנסות, יוצאות, העברות, הקלטות, תפריט קולי)? ממתי זה קורה? זה קורה לכולם או רק לשלוחה אחת? משהו השתנה לאחרונה?'],
  [/מחשוב|מחשב/, 'איזה מכשיר או תוכנה (מחשב, מדפסת, אינטרנט, מייל, תוכנה מסוימת)? מה בדיוק קורה? יש הודעת שגיאה (אפשר לשלוח צילום מסך)? ממתי? זה קורה רק אצלך או גם לאחרים? ניסית כבר להפעיל מחדש?'],
];
for (const d of db.config.departments || []) {
  if (d.questions === undefined) { const q = DEFAULT_QUESTIONS.find(([re]) => re.test(d.name)); d.questions = q ? q[1] : ''; }
}
db.config.ignoredChats = db.config.ignoredChats || [];
db.config.chatRules = db.config.chatRules || [];
db.config.personRules = db.config.personRules || [];
if (!db.config.ignoreGroupNames) db.config.ignoreGroupNames = ['פורום מתקינים', 'מתח נמוך'];
db.config.hours = Object.assign({}, DEFAULT_CONFIG.hours, db.config.hours);
if (db.config.quietMinutes === undefined) db.config.quietMinutes = 30;

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
  saveContacts: () => writeJson('contacts.json', db.contacts),
  flushAll,
};

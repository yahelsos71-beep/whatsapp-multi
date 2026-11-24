// בדיקות למשימות צוות: פתיחה, העברה, שינוי סטטוס והרשאות.
// מריצים: node --test tests/service-calls.test.js   (מתוך תיקיית helpdesk)
// מפעיל שרת ניסיון על תיקיית נתונים זמנית ופורט פנוי – לא נוגע במוקד האמיתי ולא שולח וואטסאפ.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-svc-test-'));
let proc;
const U = {}; // name -> { id, cookie }

async function call(who, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Cookie: U[who].cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j, headers: r.headers };
}
async function login(name, username, password) {
  const r = await call(null, 'POST', '/api/login', { username, password });
  assert.strictEqual(r.status, 200, 'login ' + username);
  U[name] = { id: r.body.user.id, cookie: r.headers.get('set-cookie').split(';')[0] };
}

before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HD_DATA: DATA, HD_TEST_MODE: '1', HD_NO_UPDATE: '1', HD_PORT: String(PORT), HD_HOST: '127.0.0.1', HD_ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/state'); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  assert.strictEqual((await call(null, 'POST', '/api/setup', { name: 'חיים', username: 'chaim', password: 'pass1234' })).status, 200);
  await login('chaim', 'chaim', 'pass1234');
  for (const [name, username, role] of [['טל', 'tal', 'agent'], ['נועה', 'noa', 'agent'], ['עידן', 'idan', 'agent']]) {
    const r = await call('chaim', 'POST', '/api/admin/users', { name, username, role, password: 'pass1234' });
    assert.strictEqual(r.status, 200);
    await login(username, username, 'pass1234');
  }
  // מטפלים: חיים (מנהל), טל, נועה. עידן – משתמש רגיל שאינו מטפל
  const h = await call('chaim', 'PUT', '/api/svc/handlers', { handlers: [{ userId: U.chaim.id, color: '#2b7de9' }, { userId: U.tal.id, color: '#d6336c' }, { userId: U.noa.id }] });
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.body.handlers.length, 3);
});
after(async () => {
  if (proc && proc.exitCode === null) { const gone = new Promise((r) => proc.once('exit', r)); proc.kill(); await gone; }
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
});

test('פתיחת קריאה: מספר רץ מ-101, סטטוס חדשה, נשמר בקובץ', async () => {
  const r = await call('idan', 'POST', '/api/svc/calls', { assigneeId: U.tal.id, subject: 'להתקשר ללקוח', customer: 'משה', phone: '050-1234567', details: 'שורה 1\nשורה 2', urgent: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.id, 101);
  assert.strictEqual(r.body.status, 'new');
  assert.strictEqual(r.body.assigneeId, U.tal.id);
  assert.strictEqual(r.body.createdBy, U.idan.id);
  assert.strictEqual(r.body.urgent, true);
  const r2 = await call('tal', 'POST', '/api/svc/calls', { assigneeId: U.noa.id, subject: 'שנייה', id: 5000 });
  assert.strictEqual(r2.body.id, 102, 'המספר נקבע בשרת ולא מהדפדפן');
  await new Promise((r) => setTimeout(r, 400));
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'service_calls.json'), 'utf8'));
  assert.strictEqual(saved.seq, 102);
});

test('ולידציה: בלי נושא / בלי מטפל / מטפל שלא ברשימה / טלפון לא תקין', async () => {
  assert.strictEqual((await call('tal', 'POST', '/api/svc/calls', { assigneeId: U.tal.id, subject: ' ' })).status, 400);
  assert.strictEqual((await call('tal', 'POST', '/api/svc/calls', { subject: 'בדיקה' })).status, 400);
  assert.strictEqual((await call('tal', 'POST', '/api/svc/calls', { assigneeId: U.idan.id, subject: 'בדיקה' })).status, 400);
  assert.strictEqual((await call('tal', 'POST', '/api/svc/calls', { assigneeId: U.tal.id, subject: 'בדיקה', phone: '<script>' })).status, 400);
  assert.strictEqual((await call(null, 'POST', '/api/svc/calls', { assigneeId: U.tal.id, subject: 'בדיקה' })).status, 401);
});

test('טקסט עם HTML נשמר כטקסט (הממשק מציג עם esc)', async () => {
  const r = await call('tal', 'POST', '/api/svc/calls', { assigneeId: U.tal.id, subject: '<img src=x onerror=alert(1)>' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.subject, '<img src=x onerror=alert(1)>');
});

test('שינוי סטטוס: התחלתי לטפל → סגור → פתח מחדש, עם היסטוריה', async () => {
  let r = await call('tal', 'POST', '/api/svc/calls/101', { action: 'start' });
  assert.strictEqual(r.body.status, 'progress');
  r = await call('tal', 'POST', '/api/svc/calls/101', { action: 'close' });
  assert.strictEqual(r.body.status, 'closed');
  assert.ok(r.body.closedAt);
  r = await call('tal', 'POST', '/api/svc/calls/101', { action: 'start' });
  assert.strictEqual(r.status, 400, 'אי אפשר להתחיל קריאה סגורה');
  r = await call('tal', 'POST', '/api/svc/calls/101', { action: 'reopen' });
  assert.strictEqual(r.body.status, 'new');
  assert.strictEqual(r.body.closedAt, null);
  assert.deepStrictEqual(r.body.history.map((h) => h.kind), ['open', 'status', 'status', 'status']);
  assert.strictEqual(r.body.history[1].by, U.tal.id);
});

test('העברה: למטפל אחר, הסטטוס חוזר לחדשה, נרשם בהיסטוריה', async () => {
  await call('tal', 'POST', '/api/svc/calls/101', { action: 'start' });
  const r = await call('tal', 'POST', '/api/svc/calls/101', { action: 'transfer', to: U.noa.id });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.assigneeId, U.noa.id);
  assert.strictEqual(r.body.status, 'new');
  const h = r.body.history.find((x) => x.kind === 'assign');
  assert.strictEqual(h.from, U.tal.id); assert.strictEqual(h.to, U.noa.id); assert.strictEqual(h.by, U.tal.id);
  assert.strictEqual((await call('tal', 'POST', '/api/svc/calls/101', { action: 'transfer', to: U.idan.id })).status, 400, 'רק למטפל מהרשימה');
});

test('הרשאות: מי שאינו מטפל לא משנה, רק מנהל מוחק', async () => {
  assert.strictEqual((await call('idan', 'POST', '/api/svc/calls/101', { action: 'close' })).status, 403);
  assert.strictEqual((await call('idan', 'POST', '/api/svc/calls/101', { action: 'transfer', to: U.tal.id })).status, 403);
  assert.strictEqual((await call('tal', 'DELETE', '/api/svc/calls/101')).status, 403, 'מטפל שאינו מנהל לא מוחק');
  assert.strictEqual((await call('tal', 'PUT', '/api/svc/handlers', { handlers: [] })).status, 403, 'רק מנהל עורך מטפלים');
  assert.strictEqual((await call('chaim', 'DELETE', '/api/svc/calls/101')).status, 200);
  assert.strictEqual((await call('chaim', 'DELETE', '/api/svc/calls/101')).status, 404);
  const s = await call('idan', 'GET', '/api/svc');
  assert.ok(!s.body.calls.some((c) => c.id === 101));
  assert.strictEqual(s.body.canManage, false);
});

test('מונה ממשיך אחרי מחיקה (לא משתמש שוב במספר)', async () => {
  const r = await call('chaim', 'POST', '/api/svc/calls', { assigneeId: U.chaim.id, subject: 'אחרי מחיקה' });
  assert.strictEqual(r.body.id, 104);
});

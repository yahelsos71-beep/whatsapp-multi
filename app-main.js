const { app, BrowserWindow, session, Menu, dialog, ipcMain, shell, clipboard, net } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ---- תיקיות ----
// USER_DIR – פרטי לכל יוזר (חשבונות פרטיים, הגדרות צלצול, קבצי צליל)
const USER_DIR = path.join(app.getPath('appData'), 'WhatsAppMulti-User');
fs.mkdirSync(USER_DIR, { recursive: true });
// DATA_DIR – משותף: "data" ליד ה-exe. כל יוזר שמפעיל מאותה תיקייה מקבל את אותם חיבורים.
const exeDir = app.isPackaged ? path.dirname(app.getPath('exe')) : global.BUILTIN_DIR || __dirname;
const DATA_DIR = process.env.WA_MULTI_DATA || path.join(exeDir, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
// מצב "עבודה במקביל": החיבורים (סריקות, כניסה למוקד) נשמרים אצל היוזר עצמו,
// ולכן כמה משתמשים יכולים לפתוח את התוכנה באותו זמן. רשימת הוואטסאפים וההחרגות – עדיין משותפות.
const MODE_FILE = path.join(USER_DIR, 'mode.json');
const PERSONAL = (() => { try { return JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')).personal === true; } catch { return false; } })();
const SESS_DIR = PERSONAL ? path.join(USER_DIR, 'sessions') : DATA_DIR;
fs.mkdirSync(SESS_DIR, { recursive: true });
app.setPath('userData', SESS_DIR);
const setPersonal = (on) => { try { fs.writeFileSync(MODE_FILE, JSON.stringify({ personal: !!on })); } catch {} };

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ---- מנעול: מונע פתיחה כפולה בו-זמנית (גם ממשתמש אחר) ----
const LOCK = path.join(DATA_DIR, 'running.lock');
const ME = os.userInfo().username + '@' + process.pid;
const readLock = () => { try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return null; } };
const writeLock = () => {
  try { fs.writeFileSync(LOCK, JSON.stringify({ owner: ME, user: os.userInfo().username, t: Date.now() })); } catch {}
};
const lockIsFresh = (l) => l && l.owner !== ME && Date.now() - l.t < 25000;

// ---- כל session: UA של כרום, הרשאות, ונעילת תיקייה לחשבון פרטי ----
app.on('session-created', (ses) => {
  ses.setUserAgent(CHROME_UA);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  const sp = ses.getStoragePath && ses.getStoragePath();
  if (process.platform === 'win32' && sp && path.basename(sp).startsWith('p_')) {
    const marker = path.join(USER_DIR, 'locked_' + path.basename(sp));
    if (!fs.existsSync(marker)) {
      fs.mkdirSync(sp, { recursive: true });
      const u = process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' + os.userInfo().username : os.userInfo().username;
      require('child_process').execFile('icacls',
        [sp, '/inheritance:r', '/grant:r', u + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'],
        (err) => { if (!err) fs.writeFileSync(marker, '1'); });
    }
  }
});

ipcMain.on('paths', (e) => {
  e.returnValue = { dataDir: DATA_DIR, userDir: USER_DIR, user: os.userInfo().username, exeDir, personal: PERSONAL };
});
ipcMain.on('set-personal', (_e, on) => {
  setPersonal(on);
  try { const l = readLock(); if (l && l.owner === ME) fs.unlinkSync(LOCK); } catch {}
  app.relaunch();
  app.exit(0);
});
ipcMain.handle('clear-partition', (_e, partition) => session.fromPartition(partition).clearStorageData());
ipcMain.handle('pick-sound', async () => {
  const r = await dialog.showOpenDialog({
    title: 'בחר קובץ צליל',
    filters: [{ name: 'צלילים', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = path.join(USER_DIR, 'sounds');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, Date.now() + path.extname(r.filePaths[0]));
  fs.copyFileSync(r.filePaths[0], dest);
  return { path: dest, name: path.basename(r.filePaths[0]) };
});
ipcMain.on('clipboard', (_e, text) => clipboard.writeText(text));

// ---- פתיחה מהמוקד: קישור whatsappmulti://open ----
// אם התוכנה כבר פתוחה – מביאים את החלון לקדמת המסך במקום לפתוח עוד עותק
const gotSingle = app.requestSingleInstanceLock();
if (!gotSingle) { app.quit(); }
app.on('second-instance', () => {
  // לחיצה נוספת על התוכנה: מביאים את החלון קדימה; אם משום מה אין חלון – פותחים אותו
  if (mainWin && !mainWin.isDestroyed()) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); }
  else if (startupDone) createWindow();
});
let startupDone = false;
try { if (app.isPackaged) app.setAsDefaultProtocolClient('whatsappmulti'); } catch {}

function createWindow(load = true) {
  const win = new BrowserWindow({
    width: 1350,
    height: 880,
    title: 'WhatsApp Multi',
    webPreferences: { webviewTag: true, contextIsolation: false, nodeIntegration: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  if (load) win.loadFile(path.join(global.APP_DIR || __dirname, 'index.html'));
  else win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="font-family:sans-serif;display:grid;place-items:center;height:90vh;color:#666">WhatsApp Multi…</body>'));
  win.on('closed', () => { if (mainWin === win) mainWin = null; });
  mainWin = win;
  return win;
}
// הודעה שתמיד מופיעה מעל החלון (לא נעלמת מאחורי חלונות אחרים)
async function startupDialog(opts) {
  if (!mainWin || mainWin.isDestroyed()) createWindow(false);
  mainWin.show(); mainWin.focus();
  return dialog.showMessageBox(mainWin, opts);
}
let mainWin = null;

// =====================================================================
// עדכון אוטומטי: בודק ב-GitHub אם יש גרסה חדשה, מוריד ומפעיל
// =====================================================================
const REPO = 'yahelsos71-beep/whatsapp-multi';
const SOURCES = process.env.WA_UPDATE_URL ? [process.env.WA_UPDATE_URL] : [
  `https://raw.githubusercontent.com/${REPO}/main/`,
  `https://cdn.jsdelivr.net/gh/${REPO}@main/`,
];
const localVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(global.APP_DIR || __dirname, 'version.json'), 'utf8')).version || 0; } catch { return 0; } };
let updateReady = 0;

async function fetchText(url) {
  const r = await net.fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return Buffer.from(await r.arrayBuffer());
}

async function checkUpdate() {
  for (const base of SOURCES) {
    try {
      const remote = JSON.parse((await fetchText(base + 'version.json')).toString('utf8'));
      if (!remote.version || remote.version <= Math.max(localVersion(), updateReady)) return;
      const tmp = global.UPDATE_DIR + '-new';
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      for (const [file, hash] of Object.entries(remote.files || {})) {
        if (!/^[\w.-]+$/.test(file)) throw new Error('bad file name');
        const buf = await fetchText(base + file);
        if (crypto.createHash('sha256').update(buf).digest('hex') !== hash) throw new Error('hash mismatch ' + file);
        fs.writeFileSync(path.join(tmp, file), buf);
      }
      // מעתיקים לתוך תיקיית העדכון במקום (בלי למחוק אותה – ייתכן שהתוכנה רצה ממנה).
      // version.json נכתב אחרון; אם משהו נכשל באמצע – מוחקים אותו, והגרסה המובנית תעדכן מחדש.
      fs.mkdirSync(global.UPDATE_DIR, { recursive: true });
      const vfile = path.join(global.UPDATE_DIR, 'version.json');
      try {
        for (const file of Object.keys(remote.files || {})) {
          fs.copyFileSync(path.join(tmp, file), path.join(global.UPDATE_DIR, file));
        }
        fs.writeFileSync(vfile, JSON.stringify(remote));
      } catch (e) {
        try { fs.unlinkSync(vfile); } catch {}
        throw e;
      }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      updateReady = remote.version;
      if (mainWin) mainWin.webContents.send('update-ready', remote);
      return;
    } catch (e) {
      console.log('update check failed:', e.message);
    }
  }
}
ipcMain.on('restart-now', () => {
  // משחררים את המנעול ויוצאים בכוח – כדי שהעותק החדש לא ייתקע על "התוכנה כבר פתוחה"
  try { const l = readLock(); if (l && l.owner === ME) fs.unlinkSync(LOCK); } catch {}
  app.relaunch();
  app.exit(0);
});
ipcMain.on('app-version', (e) => { e.returnValue = localVersion(); });
app.whenReady().then(() => {
  setTimeout(checkUpdate, process.env.WA_UPDATE_URL ? 2000 : 15 * 1000);
  setInterval(checkUpdate, 60 * 60 * 1000);
});

// קישורים: התחברות ל-Claude/Google נפתחת בחלון בתוך התוכנה, כל השאר בדפדפן
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/([a-z0-9-]+\.)*(claude\.ai|anthropic\.com|google\.com|accounts\.google\.com|appleid\.apple\.com)\//i.test(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(async () => {
  if (!gotSingle) return;
  // נפתח מתיקייה בלי סריקות, אבל בפעם שעברה עבדנו מתיקייה אחרת עם סריקות? מציעים לעבור אליה
  const LAST = path.join(USER_DIR, 'last-folder.txt');
  let last = null;
  try { last = fs.readFileSync(LAST, 'utf8').trim(); } catch {}
  const hasScans = fs.existsSync(path.join(DATA_DIR, 'Partitions'));
  const exeName = path.basename(app.getPath('exe'));
  if (app.isPackaged && !hasScans && last && path.resolve(last) !== path.resolve(exeDir) && fs.existsSync(path.join(last, exeName))) {
    const r = await startupDialog({
      type: 'warning',
      buttons: ['פתח מהתיקייה הנכונה', 'המשך כאן (יבקש סריקה)'],
      defaultId: 0,
      cancelId: 0,
      title: 'WhatsApp Multi',
      message: 'פתחת את התוכנה מתיקייה אחרת – בלי הוואטסאפים שסרקת.',
      detail: `התיקייה שאתה עובד איתה בדרך כלל:\n${last}\n\nהתיקייה הנוכחית:\n${exeDir}`,
    });
    if (r.response === 0) {
      require('child_process').spawn(path.join(last, exeName), [], { detached: true, stdio: 'ignore', cwd: last }).unref();
      return app.exit(0);
    }
  }
  if (hasScans || !last) { try { fs.writeFileSync(LAST, exeDir); } catch {} }

  const l = PERSONAL ? null : readLock();
  if (lockIsFresh(l)) {
    const r = await startupDialog({
      type: 'warning',
      buttons: ['👥 עבודה במקביל (מומלץ)', 'סגור'],
      defaultId: 0,
      cancelId: 1,
      title: 'WhatsApp Multi',
      message: `התוכנה כבר פתוחה אצל המשתמש "${l.user}".`,
      detail: 'כדי לעבוד במקביל, בחר "עבודה במקביל":\n' +
        'החיבורים יישמרו אצלך, ובפעם הראשונה תסרוק פעם אחת את הוואטסאפים (בטלפון: מכשירים מקושרים ← קישור מכשיר)\n' +
        'ותתחבר פעם אחת למוקד עם המשתמש שלך. מאז – כל אחד עובד אצלו, באותו זמן.',
    });
    if (r.response === 0) { setPersonal(true); app.relaunch(); return app.exit(0); }
    return app.exit(0);
  }
  if (!PERSONAL) { writeLock(); setInterval(writeLock, 10000); }
  startupDone = true;
  if (mainWin && !mainWin.isDestroyed()) { mainWin.loadFile(path.join(global.APP_DIR || __dirname, 'index.html')); mainWin.show(); mainWin.focus(); }
  else createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  if (PERSONAL) return;
  const l = readLock();
  if (l && l.owner === ME) try { fs.unlinkSync(LOCK); } catch {}
});

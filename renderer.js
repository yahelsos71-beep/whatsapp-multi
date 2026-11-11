const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');
const INJECT = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
const WA_URL = process.env.WA_TEST_URL || 'https://web.whatsapp.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const P = ipcRenderer.sendSync('paths');
const SHARED_FILE = path.join(P.dataDir, 'accounts.json'); // חשבונות משותפים
const PRIVATE_FILE = path.join(P.userDir, 'private.json'); // חשבונות פרטיים – רק היוזר הזה
const SETTINGS_FILE = path.join(P.userDir, 'settings.json'); // הגדרות צלצול – לכל יוזר
const PENDING_SHARED = P.personal ? path.join(P.userDir, 'pending-shared.json') : path.join(P.dataDir, 'pending.json');
const PENDING_PRIVATE = path.join(P.userDir, 'pending.json');
const USER_KEY = Buffer.from(P.user.toLowerCase()).toString('hex').slice(0, 40);
const CLAUDE_PARTITION = `persist:p_${USER_KEY}_claude`;
const HELPDESK_PARTITION = `persist:p_${USER_KEY}_helpdesk`;

function load(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } }
function save(file, v) { try { fs.writeFileSync(file, JSON.stringify(v, null, 2)); } catch {} }

let shared = load(SHARED_FILE, null);
if (!shared) {
  shared = [1, 2, 3].map((n) => ({ id: 'wa' + n, name: 'וואטסאפ ' + n }));
  save(SHARED_FILE, shared);
}
let priv = load(PRIVATE_FILE, []);
const partitionOf = (acc) => (acc.private ? `persist:p_${USER_KEY}_${acc.id}` : `persist:${acc.id}`);
const allAccounts = () => [...priv.map((a) => ({ ...a, private: true })), ...shared.map((a) => ({ ...a, private: false }))];

const settings = Object.assign(
  { newTone: 'double', remindTone: 'phone', remindSec: 30, vol: 0.8, muted: false, newFile: null, remindFile: null, helpdeskUrl: 'http://localhost:8080' },
  load(SETTINGS_FILE, {})
);
const saveSettings = () => save(SETTINGS_FILE, settings);

document.getElementById('user').textContent = P.user + ' · v' + ipcRenderer.sendSync('app-version') + (P.personal ? ' · 👥 במקביל' : '') + ' · 📁 ' + path.basename(P.exeDir).slice(0, 18);
document.getElementById('user').title = 'התוכנה רצה מהתיקייה:\n' + P.exeDir;

// עדכון אוטומטי הורד – מציעים להפעיל מחדש
ipcRenderer.on('update-ready', (_e, info) => {
  const b = document.getElementById('updateBtn');
  b.style.display = '';
  b.textContent = '⬆ עדכון חדש מוכן – לחץ להפעלה';
  b.title = info.notes || '';
  b.onclick = () => ipcRenderer.send('restart-now');
  toast('הורד עדכון לתוכנה. הוא יופעל בפתיחה הבאה, או לחץ על הכפתור הירוק למעלה', 7000);
});

function toast(msg, ms = 3500) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.style.display = 'none'), ms);
}

// =====================================================================
// צלצולים
// =====================================================================
const ctx = new AudioContext();
// כל צליל: רשימה של [תדר, התחלה, משך, סוג גל, תדר-סיום (לגלישה)]
const TONES = {
  double: { name: 'צפצוף כפול', notes: [[880, 0, 0.18], [1320, 0.15, 0.25]] },
  soft: { name: 'דינג רך', notes: [[660, 0, 0.6], [990, 0, 0.4]] },
  bell: { name: 'פעמון', notes: [[1046, 0, 1.4, 'triangle'], [2093, 0, 0.9], [3136, 0, 0.5]] },
  marimba: { name: 'מרימבה', notes: [[523, 0, 0.3, 'triangle'], [659, 0.13, 0.3, 'triangle'], [784, 0.26, 0.5, 'triangle']] },
  chime: { name: 'צלצול דלת', notes: [[988, 0, 0.7, 'triangle'], [784, 0.35, 1.0, 'triangle']] },
  phone: {
    name: 'טלפון קלאסי',
    notes: [...Array(16)].map((_, i) => [i % 2 ? 1700 : 1300, i * 0.05 + (i >= 8 ? 0.25 : 0), 0.05, 'square']),
  },
  alarm: { name: 'אזעקה', notes: [[600, 0, 0.45, 'sawtooth', 1400], [600, 0.5, 0.45, 'sawtooth', 1400]] },
  beep3: { name: '3 צפצופים חזקים', notes: [[1000, 0, 0.18], [800, 0.2, 0.2], [1000, 0.45, 0.18], [800, 0.65, 0.2], [1000, 0.9, 0.18], [800, 1.1, 0.2]] },
};

function playNotes(notes) {
  ctx.resume();
  const v = settings.vol;
  for (const [f, start, dur, type = 'sine', f2] of notes) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    const t0 = ctx.currentTime + start;
    o.type = type;
    o.frequency.setValueAtTime(f, t0);
    if (f2) o.frequency.linearRampToValueAtTime(f2, t0 + dur);
    const peak = type === 'square' || type === 'sawtooth' ? v * 0.35 : v;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
}
function playTone(key, file) {
  if (key === 'file' && file) {
    const a = new Audio('file:///' + file.replace(/\\/g, '/'));
    a.volume = settings.vol;
    a.play().catch(() => {});
    return;
  }
  playNotes((TONES[key] || TONES.double).notes);
}
const newMsgSound = () => { if (!settings.muted) playTone(settings.newTone, settings.newFile); };
const reminderRing = () => { if (!settings.muted) playTone(settings.remindTone, settings.remindFile); };

let lastBeep = 0;
function onNewMessage() {
  const now = Date.now();
  if (now - lastBeep < 1500) return;
  lastBeep = now; newMsgSound();
}

// =====================================================================
// "ממתין לתשובה": צ'אט נשאר מסומן עד שאתה עונה לו
// =====================================================================
const CLOCK = /^\d{1,2}:\d{2}/;
const pendingStore = { shared: load(PENDING_SHARED, {}), priv: load(PENDING_PRIVATE, {}) };
function savePending(it) {
  const store = it.acc.private ? pendingStore.priv : pendingStore.shared;
  store[it.partition] = [...it.pending];
  for (const n of Object.keys(it.since)) if (!it.pending.has(n)) delete it.since[n];
  store[it.partition + '#since'] = it.since;
  store[it.partition + '#cleared'] = it.cleared || {};
  save(it.acc.private ? PENDING_PRIVATE : PENDING_SHARED, store);
}

// האם לעקוב אחרי "ממתין לתשובה" בחשבון הזה (ברירת מחדל: כן במשותף, לא בפרטי)
const tracks = (acc) => (acc.track === undefined ? !acc.private : !!acc.track);

// החרגה ידנית: שם או מספר (מספר נבדק לפי 9 הספרות האחרונות)
const digits = (x) => String(x).replace(/\D/g, '');
function isExcluded(acc, name) {
  for (const e of acc.exclude || []) {
    const ed = digits(e);
    if (ed.length >= 7) { if (digits(name).slice(-9) === ed.slice(-9)) return true; }
    else if (e.trim() && name.trim() === e.trim()) return true;
  }
  return false;
}
function setExclude(acc, list) {
  const file = acc.private ? PRIVATE_FILE : SHARED_FILE;
  const all = load(file, []);
  const a = all.find((x) => x.id === acc.id);
  if (!a) return;
  a.exclude = list;
  save(file, all); if (acc.private) priv = all; else shared = all;
  const it = items.get(partitionOf(acc));
  if (it) {
    it.acc = { ...it.acc, exclude: list };
    let ch = false;
    for (const n of [...it.pending]) if (isExcluded(it.acc, n)) { it.pending.delete(n); ch = true; }
    if (ch) { savePending(it); pushPending(it); refreshBadges(); }
  }
}

function onRows(it, rows) {
  let added = false, changed = false;
  if (!tracks(it.acc)) {
    if (it.pending.size) { it.pending.clear(); changed = true; }
    rows = [];
  }
  for (const r of rows) {
    if (r.group || isExcluded(it.acc, r.name)) { // קבוצות / מוחרג ידנית – לא צריך לענות
      if (it.pending.delete(r.name)) changed = true;
      continue;
    }
    if (r.busy) continue; // מקליד / טיוטה – לא משנים כלום
    const prev = it.rows[r.name];
    // נוקה ידנית ("נקה הכל") – לא חוזר עד שמגיעה הודעה חדשה (שעה אחרת)
    if (it.cleared && r.name in it.cleared) {
      if (!r.out && it.cleared[r.name] === r.time) { it.rows[r.name] = { time: r.time, out: r.out }; continue; }
      delete it.cleared[r.name]; changed = true;
    }
    if (r.out) {
      // ההודעה האחרונה בצ'אט היא שלך = ענית → הסימון יורד
      if (it.pending.delete(r.name)) changed = true;
    } else if (!it.pending.has(r.name)) {
      const newIncoming =
        r.unread || // יש הודעות שלא נקראו
        (prev && prev.out) || // היה שלך ועכשיו של הלקוח
        (prev && prev.time !== r.time && CLOCK.test(r.time)); // שעה חדשה (צ'אט פתוח)
      if (newIncoming) { it.pending.add(r.name); it.since[r.name] = Date.now(); added = changed = true; }
    }
    it.rows[r.name] = { time: r.time, out: r.out };
  }
  if (added) onNewMessage();
  if (changed) { savePending(it); refreshBadges(); pushPending(it); }
}
const pushPending = (it) => it.wv.executeJavaScript(`window.__waSetPending && window.__waSetPending(${JSON.stringify([...it.pending])})`).catch(() => {});

// =====================================================================
// לשוניות
// =====================================================================
const tabsEl = document.getElementById('tabs');
const viewsEl = document.getElementById('views');
const items = new Map(); // partition -> item
let active = localStorage.getItem('active-' + USER_KEY);

function makeWebview(partition, src) {
  const wv = document.createElement('webview');
  wv.setAttribute('partition', partition);
  wv.setAttribute('useragent', UA);
  wv.setAttribute('allowpopups', '');
  wv.src = src;
  viewsEl.appendChild(wv);
  return wv;
}

function build() {
  const accs = allAccounts();
  const wanted = new Set(accs.map(partitionOf));
  wanted.add(CLAUDE_PARTITION);
  if (settings.helpdeskUrl) wanted.add(HELPDESK_PARTITION);
  for (const [p, it] of items) if (!wanted.has(p)) { it.tab.remove(); it.wv.remove(); items.delete(p); }
  tabsEl.innerHTML = '';
  accs.forEach((acc) => {
    const p = partitionOf(acc);
    let it = items.get(p);
    if (!it) {
      const wv = makeWebview(p, WA_URL);
      const tab = document.createElement('div');
      tab.className = 'tab';
      const store = acc.private ? pendingStore.priv : pendingStore.shared;
      it = { tab, wv, acc, partition: p, unread: 0, rows: {}, pending: new Set(store[p] || []), since: { ...(store[p + '#since'] || {}) }, cleared: { ...(store[p + '#cleared'] || {}) } };
      items.set(p, it);
      const item = it;
      wv.addEventListener('dom-ready', () => {
        try { wv.setAudioMuted(!!settings.muted); } catch {}
        wv.executeJavaScript(INJECT).catch(() => {});
        setTimeout(() => pushPending(item), 3000);
      });
      wv.addEventListener('console-message', (e) => {
        if (e.message === '__WA_NEW_MSG__') onNewMessage();
        else if (e.message.startsWith('__WA_ROWS__')) {
          try { onRows(item, JSON.parse(e.message.slice(11))); } catch {}
        }
      });
      wv.addEventListener('page-title-updated', (e) => {
        const m = /\((\d+)\)/.exec(e.title);
        const n = m ? parseInt(m[1], 10) : 0;
        if (n > item.unread) onNewMessage();
        item.unread = n;
      });
      tab.addEventListener('click', () => select(p));
      tab.addEventListener('contextmenu', (e) => { e.preventDefault(); editDialog(item.acc); });
      tab.addEventListener('dblclick', () => editDialog(item.acc));
    }
    it.acc = acc;
    it.tab.innerHTML = `${acc.private ? '<span title="פרטי – רק אתה רואה">🔒</span>' : ''}<span class="name"></span><span class="badge"></span>`;
    it.tab.querySelector('.name').textContent = acc.name;
    tabsEl.appendChild(it.tab);
  });

  // לשונית Claude – פרטית לכל יוזר
  let c = items.get(CLAUDE_PARTITION);
  if (!c) {
    const wv = makeWebview(CLAUDE_PARTITION, 'https://claude.ai/new');
    const tab = document.createElement('div');
    tab.className = 'tab claude';
    tab.innerHTML = '🤖 Claude';
    tab.title = 'Claude – פרטי לכל משתמש';
    c = { tab, wv, claude: true, partition: CLAUDE_PARTITION, pending: new Set(), unread: 0 };
    items.set(CLAUDE_PARTITION, c);
    tab.addEventListener('click', () => select(CLAUDE_PARTITION));
  }
  tabsEl.appendChild(c.tab);

  // לשונית המוקד (מוקד וואטסאפ של המשרד) – אם הוגדרה כתובת
  if (settings.helpdeskUrl) {
    let h = items.get(HELPDESK_PARTITION);
    if (h && h.url !== settings.helpdeskUrl) { h.wv.src = settings.helpdeskUrl; h.url = settings.helpdeskUrl; }
    if (!h) {
      const wv = makeWebview(HELPDESK_PARTITION, settings.helpdeskUrl);
      const tab = document.createElement('div');
      tab.className = 'tab claude helpdesk';
      tab.innerHTML = '🎧 מוקד';
      tab.title = 'מוקד וואטסאפ של המשרד';
      h = { tab, wv, claude: true, partition: HELPDESK_PARTITION, pending: new Set(), unread: 0, url: settings.helpdeskUrl };
      items.set(HELPDESK_PARTITION, h);
      tab.addEventListener('click', () => select(HELPDESK_PARTITION));
      wv.addEventListener('page-title-updated', (e) => { const m = /\((\d+)\)/.exec(e.title); tab.innerHTML = '🎧 מוקד' + (m ? ` <span class="badge on">${m[1]}</span>` : ''); });
      // המוקד לא נטען: במחשב שאינו השרת "localhost" לא עובד – מנסים את כתובת השרת במשרד,
      // ואם גם זה לא – מציגים הסבר במקום מסך ריק
      const FALLBACK = 'http://10.10.10.250:8080';
      wv.addEventListener('did-fail-load', (e) => {
        if (!e.isMainFrame || e.errorCode === -3) return;
        h.failed = true;
        const cur = h.url || '';
        if (/\/\/(localhost|127\.0\.0\.1)/i.test(cur) && !h.triedFallback) {
          h.triedFallback = true; h.url = FALLBACK; wv.src = FALLBACK; return;
        }
        const msg = `<body dir="rtl" style="font-family:sans-serif;padding:40px;color:#333;line-height:1.8">
          <h2>🎧 המוקד לא נפתח</h2><p>לא הצלחתי להתחבר לכתובת: <b dir="ltr">${esc(cur)}</b></p>
          <ul><li>בדוק שהשרת של המוקד פועל (החלון השחור על השרת).</li>
          <li>במחשב שאינו השרת, הכתובת צריכה להיות <b dir="ltr">${FALLBACK}</b> – משנים ב-⚙ (בסרגל הכהה) ← "כתובת מוקד הוואטסאפ".</li></ul>
          <p style="color:#888">שגיאה: ${esc(String(e.errorDescription || e.errorCode))}</p></body>`;
        wv.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(msg);
      });
      wv.addEventListener('did-start-loading', () => { h.failed = false; });
      wv.addEventListener('did-finish-load', () => {
        const u = wv.getURL();
        if (h.failed) return;
        if (h.triedFallback && u.startsWith(FALLBACK) && settings.helpdeskUrl !== FALLBACK) { settings.helpdeskUrl = FALLBACK; saveSettings(); }
      });
    }
    tabsEl.insertBefore(h.tab, tabsEl.firstChild);
  }

  document.getElementById('empty').style.display = accs.length ? 'none' : 'block';
  if (!items.has(active)) active = accs.length ? partitionOf(accs[0]) : CLAUDE_PARTITION;
  select(active);
  refreshBadges();
}

function select(p) {
  active = p;
  for (const [k, it] of items) {
    it.tab.classList.toggle('active', k === p);
    it.wv.classList.toggle('active', k === p);
  }
  document.getElementById('toClaude').style.display = items.get(p) && items.get(p).claude ? 'none' : '';
  document.getElementById('exclBtn').style.display = items.get(p) && items.get(p).claude ? 'none' : '';
  localStorage.setItem('active-' + USER_KEY, p);
}

function waItems() { return [...items.values()].filter((it) => !it.claude); }
function refreshBadges() {
  let total = 0;
  for (const it of waItems()) {
    const n = it.pending.size;
    total += n;
    const b = it.tab.querySelector('.badge');
    if (b) { b.textContent = n; b.classList.toggle('on', n > 0); }
  }
  const btn = document.getElementById('pendingBtn');
  btn.textContent = `⏳ ${total}`;
  btn.className = total ? 'warn' : '';
  renderPanel();
}

// ---------- פאנל צד: כל מי שמחכה לתשובה, הכי ותיק למעלה ----------
function waitText(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'עכשיו';
  if (m < 60) return `${m} דק׳`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} שע׳ ${m % 60} דק׳` : `${Math.floor(h / 24)} ימים`;
}
function renderPanel() {
  const panel = document.getElementById('waitPanel');
  if (!panel) return;
  const now = Date.now();
  const list = waItems()
    .flatMap((it) => [...it.pending].map((name) => ({ it, name, since: it.since[name] || now })))
    .sort((a, b) => a.since - b.since);
  document.body.classList.toggle('has-pending', list.length > 0);
  const ul = panel.querySelector('ul');
  ul.innerHTML = '';
  for (const { it, name, since } of list) {
    const wait = now - since;
    const li = document.createElement('li');
    li.className = wait > 15 * 60000 ? 'late' : wait > 5 * 60000 ? 'mid' : '';
    li.innerHTML = '<span class="dot"></span><div class="t"><b></b><small></small></div><span class="w"></span>';
    li.querySelector('b').textContent = name;
    li.querySelector('small').textContent = it.acc.name;
    li.querySelector('.w').textContent = waitText(wait);
    li.title = 'לחץ לפתיחת הצ\'אט';
    li.onclick = async () => {
      select(it.partition);
      const ok = await it.wv.executeJavaScript(`window.__waOpen ? window.__waOpen(${JSON.stringify(name)}) : false`).catch(() => false);
      if (!ok) toast(`לא מצאתי את "${name}" ברשימה – חפש אותו בוואטסאפ`);
    };
    ul.appendChild(li);
  }
  panel.querySelector('.cnt').textContent = list.length;
}
setInterval(renderPanel, 30000);

// תזכורת: כל עוד יש צ'אט שממתין לתשובה (או הודעה שלא נקראה)
let lastRemind = Date.now();
setInterval(() => {
  const waiting = waItems().some((it) => it.pending.size > 0);
  if (!waiting) { lastRemind = Date.now(); return; }
  if (Date.now() - lastRemind >= settings.remindSec * 1000) { lastRemind = Date.now(); reminderRing(); }
}, 1000);

// =====================================================================
// חלוניות
// =====================================================================
const modal = document.getElementById('modal');
const box = document.getElementById('box');
const close = () => modal.classList.remove('on');
modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function addDialog() {
  box.innerHTML = `
    <h3>הוספת וואטסאפ</h3>
    <input type="text" id="nm" placeholder="שם (למשל: עסק, פרטי)">
    <label class="choice"><input type="radio" name="kind" value="shared" checked> 👥 משותף
      <small>כל מי שפותח את התוכנה בשרת יראה אותו</small></label>
    <label class="choice"><input type="radio" name="kind" value="private"> 🔒 פרטי
      <small>רק המשתמש "${esc(P.user)}" יראה אותו. משתמשים אחרים לא יראו אותו בכלל</small></label>
    <div class="row"><button class="primary" id="ok">הוסף וסרוק QR</button><button id="cancel">ביטול</button></div>`;
  modal.classList.add('on');
  const nm = box.querySelector('#nm'); nm.focus();
  box.querySelector('#cancel').onclick = close;
  box.querySelector('#ok').onclick = () => {
    const isPriv = box.querySelector('input[name=kind]:checked').value === 'private';
    const acc = { id: 'wa' + Date.now().toString(36), name: nm.value.trim() || (isPriv ? 'פרטי' : 'וואטסאפ') };
    if (isPriv) { priv = load(PRIVATE_FILE, []); priv.push(acc); save(PRIVATE_FILE, priv); }
    else { shared = load(SHARED_FILE, []); shared.push(acc); save(SHARED_FILE, shared); }
    close(); build(); select(partitionOf({ ...acc, private: isPriv }));
  };
}

function editDialog(acc) {
  box.innerHTML = `
    <h3>${acc.private ? '🔒 חשבון פרטי' : '👥 חשבון משותף'}</h3>
    <input type="text" id="nm">
    <label class="choice"><input type="checkbox" id="track" ${tracks(acc) ? 'checked' : ''}> 🟢 סמן צ'אטים שממתינים לתשובה
      <small>נקודה ירוקה + צלצול תזכורת עד שעונים (לא כולל קבוצות)</small></label>
    <h4>🚫 לא לסמן את הצ'אטים האלה (שם או מספר, אחד בכל שורה)</h4>
    <textarea id="excl" rows="4" style="width:100%;padding:9px;border-radius:8px;border:1px solid #3b4a54;background:#111b21;color:#e9edef;font-size:14px" placeholder="למשל:&#10;0521234567&#10;יוסי ספק"></textarea>
    <div class="row">
      <button class="primary" id="ok">שמור</button>
      <button class="danger" id="del">הסר והתנתק</button>
      <button id="cancel">ביטול</button>
    </div>`;
  modal.classList.add('on');
  const nm = box.querySelector('#nm'); nm.value = acc.name; nm.focus();
  box.querySelector('#excl').value = (acc.exclude || []).join('\n');
  box.querySelector('#cancel').onclick = close;
  const file = acc.private ? PRIVATE_FILE : SHARED_FILE;
  box.querySelector('#ok').onclick = () => {
    const list = load(file, []);
    const a = list.find((x) => x.id === acc.id);
    if (a) { a.name = nm.value.trim() || a.name; a.track = box.querySelector('#track').checked; }
    save(file, list); if (acc.private) priv = list; else shared = list;
    close(); build();
    setExclude(acc, box.querySelector('#excl').value.split('\n').map((x) => x.trim()).filter(Boolean));
    const it = items.get(partitionOf(acc));
    if (it && !tracks(it.acc) && it.pending.size) { it.pending.clear(); savePending(it); pushPending(it); refreshBadges(); }
  };
  const del = box.querySelector('#del');
  del.onclick = async () => {
    if (!del.dataset.sure) { del.dataset.sure = 1; del.textContent = 'בטוח? לחץ שוב'; return; }
    const list = load(file, []).filter((x) => x.id !== acc.id);
    save(file, list); if (acc.private) priv = list; else shared = list;
    const p = partitionOf(acc);
    close(); build();
    await ipcRenderer.invoke('clear-partition', p);
  };
}

function pendingDialog() {
  const list = waItems().flatMap((it) => [...it.pending].map((name) => ({ it, name })));
  box.innerHTML = `
    <h3>⏳ ממתינים לתשובה שלך</h3>
    ${list.length ? '<ul class="plist"></ul>' : '<p>אין צ\'אטים שממתינים לתשובה 👍</p>'}
    <p class="hint">צ'אט נשאר ברשימה (ועם נקודה ירוקה בוואטסאפ) עד שאתה שולח לו תשובה – גם אם קראת את ההודעה.<br>קבוצות לא נספרות. "🚫 החרג" – הצ'אט לא יסומן יותר לעולם (אפשר לבטל בלחיצה ימנית על הלשונית).</p>
    <div class="row">${list.length ? '<button id="clearAll" class="warn">🧹 נקה הכל</button>' : ''}<button id="cancel">סגור</button></div>`;
  const ul = box.querySelector('.plist');
  const ca = box.querySelector('#clearAll');
  if (ca) ca.onclick = () => {
    if (!confirm(`לנקות את כל ${list.length} הממתינים לתשובה?\nצ'אט יחזור לרשימה רק כשתגיע ממנו הודעה חדשה.`)) return;
    for (const it of waItems()) {
      if (!it.pending.size) continue;
      it.cleared = it.cleared || {};
      for (const n of it.pending) it.cleared[n] = (it.rows[n] && it.rows[n].time) || '';
      it.pending.clear(); savePending(it); pushPending(it);
    }
    refreshBadges(); pendingDialog();
  };
  for (const { it, name } of list) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot"></span><span class="n"></span><span class="acc"></span><button title="לא לסמן את הצ'אט הזה לעולם">🚫 החרג</button>`;
    li.querySelector('button').onclick = () => { setExclude(it.acc, [...(it.acc.exclude || []), name]); pendingDialog(); };
    li.querySelector('.n').textContent = name;
    li.querySelector('.acc').textContent = it.acc.name;
    li.querySelector('.n').onclick = () => { close(); select(it.partition); };
    ul.appendChild(li);
  }
  box.querySelector('#cancel').onclick = close;
  modal.classList.add('on');
}

function toneSelect(id, cur, file) {
  const opts = Object.entries(TONES).map(([k, t]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${t.name}</option>`).join('');
  const fileOpt = file ? `<option value="file" ${cur === 'file' ? 'selected' : ''}>🎵 ${esc(file.name)}</option>` : '';
  return `<select id="${id}">${opts}${fileOpt}<option value="__pick">📁 בחר קובץ צליל מהמחשב...</option></select>`;
}

function settingsDialog() {
  box.innerHTML = `
    <h3>⚙️ הגדרות צלצול</h3>
    <h4>צליל להודעה חדשה</h4>
    <div class="row">${toneSelect('newTone', settings.newTone, settings.newFile)}<button id="tNew">▶ נסה</button></div>
    <h4>צלצול תזכורת (כשיש צ'אט שממתין לתשובה)</h4>
    <div class="row">${toneSelect('remindTone', settings.remindTone, settings.remindFile)}<button id="tRem">▶ נסה</button></div>
    <h4>כל כמה זמן לצלצל תזכורת</h4>
    <div class="row"><select id="remindSec">
      ${[[15, '15 שניות'], [30, 'חצי דקה'], [60, 'דקה'], [120, '2 דקות'], [300, '5 דקות']]
        .map(([s, n]) => `<option value="${s}" ${s === settings.remindSec ? 'selected' : ''}>${n}</option>`).join('')}
    </select></div>
    <h4>🎧 כתובת מוקד הוואטסאפ (לשונית "מוקד")</h4>
    <div class="row"><input type="text" id="hdUrl" dir="ltr" value="${esc(settings.helpdeskUrl || '')}" placeholder="http://localhost:8080" style="flex:1;margin:0"><button id="hdSave">שמור</button></div>
    <div class="hint">ריק = בלי לשונית מוקד. במחשב אחר ברשת: http://10.10.10.250:8080</div>
    <h4>👥 עבודה במקביל</h4>
    <div class="row"><label style="flex:1"><input type="checkbox" id="personalMode" ${P.personal ? 'checked' : ''}> כל משתמש עם חיבורים משלו – כמה משתמשים עובדים באותו זמן</label></div>
    <div class="hint">אחרי ההפעלה סורקים פעם אחת את הוואטסאפים ומתחברים פעם אחת למוקד. השינוי מפעיל את התוכנה מחדש.</div>
    <h4>עוצמה</h4>
    <div class="row"><input id="vol" type="range" min="0" max="1" step="0.05" value="${settings.vol}" style="flex:1"></div>
    <div class="row"><button class="primary" id="cancel">סגור</button><button id="dbg">🐞 שמור קובץ אבחון</button></div>`;
  modal.classList.add('on');
  box.querySelector('#dbg').onclick = saveDebug;
  box.querySelector('#personalMode').onchange = (e) => {
    const on = e.target.checked;
    if (!confirm(on ? 'לעבור לעבודה במקביל? התוכנה תיפתח מחדש, ותצטרך לסרוק פעם אחת את הוואטסאפים ולהתחבר למוקד.' : 'לחזור לחיבורים המשותפים? התוכנה תיפתח מחדש (ואז רק משתמש אחד יכול לפתוח אותה בכל רגע).')) { e.target.checked = !on; return; }
    ipcRenderer.send('set-personal', on);
  };
  const bindTone = (id, fileKey) => {
    const sel = box.querySelector('#' + id);
    sel.onchange = async () => {
      if (sel.value === '__pick') {
        const f = await ipcRenderer.invoke('pick-sound');
        if (f) { settings[fileKey] = f; settings[id] = 'file'; }
        saveSettings(); return settingsDialog();
      }
      settings[id] = sel.value; saveSettings();
      playTone(settings[id], settings[fileKey]);
    };
  };
  bindTone('newTone', 'newFile');
  bindTone('remindTone', 'remindFile');
  box.querySelector('#tNew').onclick = () => playTone(settings.newTone, settings.newFile);
  box.querySelector('#tRem').onclick = () => playTone(settings.remindTone, settings.remindFile);
  box.querySelector('#hdSave').onclick = () => { settings.helpdeskUrl = box.querySelector('#hdUrl').value.trim(); saveSettings(); build(); toast('נשמר ✓'); };
  box.querySelector('#remindSec').onchange = (e) => { settings.remindSec = Number(e.target.value); saveSettings(); };
  box.querySelector('#vol').oninput = (e) => { settings.vol = Number(e.target.value); saveSettings(); };
  box.querySelector('#cancel').onclick = close;
}

// קובץ אבחון לשולחן העבודה (בלי טקסט הודעות ובלי שמות)
async function saveDebug() {
  const os = require('os');
  let out = `WhatsApp Multi v${ipcRenderer.sendSync('app-version')}\n`;
  for (const it of waItems()) {
    const d = await it.wv.executeJavaScript('window.__waDebug ? window.__waDebug() : "no inject"').catch((e) => 'ERR ' + e.message);
    out += `\n\n######## ${it.acc.private ? 'private' : 'shared'} pending=${it.pending.size}\n${d}`;
  }
  let dir = path.join(os.homedir(), 'Desktop');
  if (!fs.existsSync(dir)) dir = os.homedir();
  const f = path.join(dir, 'whatsapp-debug.txt');
  fs.writeFileSync(f, out);
  toast('נשמר: ' + f, 6000);
}

// =====================================================================
// שליחת השיחה הפתוחה ל-Claude
// =====================================================================
async function sendToClaude() {
  const it = items.get(active);
  if (!it || it.claude) return;
  const chat = await it.wv.executeJavaScript('window.__waCopyChat && window.__waCopyChat()').catch(() => null);
  if (!chat || !chat.text) return toast('קודם פתח שיחה בוואטסאפ, ואז לחץ על "שאל את Claude"');
  const prompt =
    `זו שיחת וואטסאפ עם "${chat.title}". תציע לי תשובה קצרה ומקצועית בעברית שאוכל לשלוח ללקוח:\n\n${chat.text}`;
  ipcRenderer.send('clipboard', prompt);
  const c = items.get(CLAUDE_PARTITION);
  select(CLAUDE_PARTITION);
  const ok = await c.wv.executeJavaScript(`(() => {
    const e = document.querySelector('div[contenteditable="true"]');
    if (!e) return false;
    e.focus();
    document.execCommand('insertText', false, ${JSON.stringify(prompt)});
    return true;
  })()`).catch(() => false);
  toast(ok ? 'השיחה הועברה ל-Claude – לחץ Enter לשליחה' : 'השיחה הועתקה – לחץ בתיבת הכתיבה של Claude ואז Ctrl+V', 5000);
}

// =====================================================================
// כפתורים
// =====================================================================
document.getElementById('add').onclick = addDialog;
document.getElementById('pendingBtn').onclick = pendingDialog;
document.getElementById('settings').onclick = settingsDialog;
document.getElementById('toClaude').onclick = sendToClaude;
document.getElementById('exclBtn').onclick = async () => {
  const it = items.get(active);
  if (!it || it.claude) return;
  const name = await it.wv.executeJavaScript('window.__waOpenChat && window.__waOpenChat()').catch(() => null);
  if (!name) return toast('קודם פתח בוואטסאפ את הצ\'אט או הקבוצה שרוצים להחריג');
  const list = it.acc.exclude || [];
  if (list.includes(name)) {
    setExclude(it.acc, list.filter((x) => x !== name));
    toast(`✅ "${name}" יסומן שוב כשיחכה לתשובה`);
  } else {
    setExclude(it.acc, [...list, name]);
    toast(`🚫 "${name}" הוחרג – לא יסומן ולא יצלצל. לחיצה נוספת מבטלת`, 5000);
  }
};
const muteBtn = document.getElementById('mute');
const paintMute = () => { muteBtn.textContent = settings.muted ? '🔕 מושתק' : '🔔'; muteBtn.title = settings.muted ? 'הצלצולים כבויים' : 'הצלצולים פעילים'; };
// 🔕 משתיק גם את הצליל של וואטסאפ ווב עצמו בלשוניות הוואטסאפ (לא את לשונית המוקד ולא את Claude)
const applyWaAudio = () => { for (const it of waItems()) { try { it.wv.setAudioMuted(!!settings.muted); } catch {} } };
muteBtn.onclick = () => { settings.muted = !settings.muted; saveSettings(); paintMute(); applyWaAudio(); };
paintMute();
document.getElementById('reload').onclick = () => { const it = items.get(active); if (it) it.wv.reload(); };

build();

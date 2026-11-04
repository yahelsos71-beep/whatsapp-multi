// מוזרק לתוך דף וואטסאפ ווב.
// 1. מזהה התראות על הודעות חדשות.
// 2. סורק את רשימת הצ'אטים ומדווח לתוכנה: למי ההודעה האחרונה נכנסת / יוצאת.
// 3. מסמן בנקודה ירוקה צ'אטים שממתינים לתשובה שלך.
(function () {
  if (window.__waHooked) return;
  window.__waHooked = true;

  // ---------- 1. התראות ----------
  const Orig = window.Notification;
  if (Orig) {
    function Hooked(title, opts) {
      console.log('__WA_NEW_MSG__');
      return new Orig(title, opts);
    }
    Hooked.prototype = Orig.prototype;
    Object.defineProperty(Hooked, 'permission', { get: () => 'granted' });
    Hooked.requestPermission = (cb) => { cb && cb('granted'); return Promise.resolve('granted'); };
    window.Notification = Hooked;
  }
  if (window.ServiceWorkerRegistration) {
    const origShow = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function (...a) {
      console.log('__WA_NEW_MSG__');
      return origShow.apply(this, a);
    };
  }

  // ---------- 2. סריקת רשימת הצ'אטים ----------
  const TYPING = /(typing|recording|מקליד|מקלידה|מקלידים|מקליט|מקליטה|מקליטים)/i;
  const DRAFT = /^(draft|טיוטה)\s*:/i;
  const UNREAD = /(unread|לא נקרא|שלא נקראו)/i;
  const TIME = /^(\d{1,2}:\d{2}(\s?[AP]M)?|\d{1,2}[./]\d{1,2}[./]\d{2,4}|yesterday|אתמול|היום|today|יום [א-ת׳']+|(sun|mon|tue|wed|thu|fri|sat)[a-z]*|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)$/i;

  function rows() {
    const side = document.querySelector('#pane-side');
    if (!side) return [];
    const cand = side.querySelectorAll('[role="listitem"], [role="row"]');
    // רק שורות שיש בהן שם צ'אט, ולא שורה שמכילה שורות אחרות
    return [...cand].filter((r) => r.querySelector('span[title]') && !r.querySelector('[role="listitem"], [role="row"]'));
  }

  // ההודעה האחרונה שלי? (וי / וי כפול / שעון)
  const TICK_LABEL = /^\s*(read|delivered|sent|pending|נקראה|נקרא|נמסרה|נמסר|נשלחה|נשלח|ממתינה|ממתין)\s*$/i;
  function isOutgoing(r) {
    if (r.querySelector('[data-icon*="check"], [data-icon*="tick"], [data-icon*="msg-time"], [data-icon*="status-time"]')) return true;
    for (const el of r.querySelectorAll('[aria-label]')) if (TICK_LABEL.test(el.getAttribute('aria-label'))) return true;
    for (const t of r.querySelectorAll('svg title')) if (/(check|tick)/i.test(t.textContent)) return true;
    return false;
  }

  // קבוצה? 1) לפי נתוני וואטסאפ הפנימיים  2) אייקון קבוצה  3) "שם השולח: הודעה"
  function fiberIsGroup(r) {
    const key = Object.keys(r).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    let f = key && r[key];
    for (let i = 0; f && i < 25; i++, f = f.return) {
      const p = f.memoizedProps;
      if (p) {
        for (const v of [p.chat, p.data, p.contact, p.model]) {
          const id = v && v.id;
          const ser = id && (id._serialized || (id.server ? id.user + '@' + id.server : '') || String(id));
          if (ser && /@(g\.us|c\.us|s\.whatsapp\.net|lid|newsletter|broadcast)/.test(ser)) return /@(g\.us|newsletter|broadcast)/.test(ser);
        }
      }
    }
    return null;
  }
  function isGroup(r, text) {
    try { const g = fiberIsGroup(r); if (g !== null) return g; } catch {}
    if (r.querySelector('[data-icon*="group"], [data-icon*="community"]')) return true;
    // בקבוצה, התצוגה המקדימה היא "שם השולח: טקסט" – כשהשם הוא אלמנט נפרד
    const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
    for (const l of lines) {
      const m = /^(~?\s?[^:]{1,50}?)\s*:\s*$|^(~?\s?[^:]{1,50}?)\s*:\s/.exec(l);
      if (!m) continue;
      const who = (m[1] || m[2]).trim();
      if (/^~/.test(who)) return true;
      for (const el of r.querySelectorAll('span')) {
        if (el.children.length === 0 && el.textContent.trim() === who && el.textContent.trim() !== l) return true;
      }
    }
    return false;
  }

  function readRow(r) {
    const name = r.querySelector('span[title]').getAttribute('title');
    let time = '';
    for (const el of r.querySelectorAll('div, span')) {
      if (el.children.length === 0) {
        const t = el.textContent.trim();
        if (TIME.test(t)) { time = t; break; }
      }
    }
    // שורת התצוגה המקדימה = הטקסט אחרי השם
    const text = r.innerText || '';
    const out = isOutgoing(r);
    const group = isGroup(r, text);
    let unread = false;
    for (const el of r.querySelectorAll('[aria-label]')) {
      if (UNREAD.test(el.getAttribute('aria-label'))) { unread = true; break; }
    }
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const busy = lines.some((l) => TYPING.test(l) && l.length < 40) || lines.some((l) => DRAFT.test(l));
    return { name, time, out, unread, busy, group, el: r };
  }

  let pending = new Set();
  window.__waSetPending = (names) => { pending = new Set(names); mark(); };

  function mark() {
    for (const r of rows()) {
      const name = r.querySelector('span[title]').getAttribute('title');
      if (pending.has(name)) r.setAttribute('data-wa-pending', '1');
      else r.removeAttribute('data-wa-pending');
    }
  }

  const css = document.createElement('style');
  css.textContent = `
    [data-wa-pending="1"] {
      box-shadow: inset -4px 0 0 #25d366 !important;
      background-image: radial-gradient(circle at 16px 50%, #25d366 0 7px, rgba(37,211,102,.25) 8px 11px, transparent 12px) !important;
    }`;
  (document.head || document.documentElement).appendChild(css);

  let last = '';
  function scan() {
    const data = rows().map(readRow).map(({ el, ...d }) => d);
    const s = JSON.stringify(data);
    if (s !== last) { last = s; console.log('__WA_ROWS__' + s); }
    mark();
  }
  setInterval(scan, 1000);

  // ---------- 3. העתקת השיחה הפתוחה (בשביל Claude) ----------
  window.__waCopyChat = function () {
    const main = document.querySelector('#main');
    if (!main) return null;
    const title = (main.querySelector('header span[title]') || main.querySelector('header span[dir="auto"]') || {}).textContent || '';
    const msgs = [];
    for (const m of main.querySelectorAll('.message-in, .message-out')) {
      const c = m.querySelector('[data-pre-plain-text]');
      const meta = c ? c.getAttribute('data-pre-plain-text').trim() : '';
      const body = (m.querySelector('.copyable-text span.selectable-text') || m.querySelector('.selectable-text') || {}).innerText || '[מדיה]';
      msgs.push(`${m.classList.contains('message-out') ? 'אני' : 'לקוח'} ${meta} ${body}`.trim());
    }
    return { title, text: msgs.slice(-40).join('\n') };
  };
})();

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
    const out = !!r.querySelector('[data-icon*="check"], [data-icon*="msg-time"], [data-icon*="status-time"]');
    let unread = false;
    for (const el of r.querySelectorAll('[aria-label]')) {
      if (UNREAD.test(el.getAttribute('aria-label'))) { unread = true; break; }
    }
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const busy = lines.some((l) => TYPING.test(l) && l.length < 40) || lines.some((l) => DRAFT.test(l));
    return { name, time, out, unread, busy, el: r };
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
    [data-wa-pending="1"] { position: relative; box-shadow: inset -4px 0 0 #25d366 !important; }
    [data-wa-pending="1"]::after {
      content: ''; position: absolute; top: 50%; left: 10px; width: 14px; height: 14px; margin-top: -7px;
      border-radius: 50%; background: #25d366; box-shadow: 0 0 0 3px rgba(37,211,102,.3);
      animation: waPulse 1.4s infinite; pointer-events: none; z-index: 5;
    }
    @keyframes waPulse { 50% { box-shadow: 0 0 0 7px rgba(37,211,102,0); } }`;
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

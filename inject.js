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

  // ---- זיהוי לפי המבנה של וואטסאפ ווב (data-testid) ----
  const TICK_LABEL = /^\s*(read|delivered|sent|pending|נקראה|נקרא|נמסרה|נמסר|נשלחה|נשלח|ממתינה|ממתין)\s*$/i;
  const preview = (r) => r.querySelector('[data-testid="last-msg-status"]');

  // ההודעה האחרונה שלי? בתצוגה המקדימה יש אייקון וי/וי כפול/שעון,
  // שהוא ה-svg היחיד שלא נמצא בתוך "סמל סוג הודעה" (תמונה/הקלטה וכו')
  function isOutgoing(r) {
    if (r.querySelector('[data-icon*="check"], [data-icon*="tick"], [data-icon*="msg-time"], [data-icon*="status-time"]')) return true;
    for (const el of r.querySelectorAll('[aria-label]')) if (TICK_LABEL.test(el.getAttribute('aria-label'))) return true;
    const pv = preview(r);
    if (pv) {
      for (const svg of pv.querySelectorAll('svg')) {
        if (!svg.closest('[data-testid="chat-msg-symbol"]')) return true;
      }
    }
    return false;
  }

  // קבוצה? בתצוגה המקדימה יש "שם השולח" + ":" כאלמנטים נפרדים, או הודעת מערכת
  function isGroup(r) {
    const pv = preview(r);
    if (pv) {
      if (pv.querySelector('[data-testid^="subtype-"]')) return true;
      for (const ch of pv.children) {
        if (ch.tagName === 'SPAN' && /^\s*:\s*$/.test(ch.textContent)) return true;
      }
      for (const n of pv.childNodes) {
        if (n.nodeType === 3 && /^\s*:\s*$/.test(n.textContent) && n.previousSibling && n.previousSibling.nodeType === 1) return true;
      }
    }
    if (r.querySelector('[data-icon*="group"], [data-icon*="community"], [data-testid="message-yourself-row"]')) return true;
    return false;
  }

  function readTime(r) {
    const ts = r.querySelector('[data-testid="chat-list-timestamp"]');
    if (ts) return ts.textContent.trim();
    for (const el of r.querySelectorAll('div, span')) {
      if (el.children.length === 0) {
        const t = el.textContent.trim();
        if (TIME.test(t)) return t;
      }
    }
    return '';
  }

  function isUnread(r) {
    for (const el of r.querySelectorAll('[aria-label]')) {
      if (UNREAD.test(el.getAttribute('aria-label'))) return true;
    }
    // תג מספר ירוק בעמודה הימנית-תחתונה
    const col = r.querySelector('[aria-colindex="1"]');
    if (col) for (const el of col.querySelectorAll('span, div')) {
      if (el.children.length === 0 && /^\d{1,4}$/.test(el.textContent.trim())) return true;
    }
    return false;
  }

  function readRow(r) {
    const nameEl = r.querySelector('[data-testid="cell-frame-title"] span[title]') || r.querySelector('span[title]');
    const name = nameEl.getAttribute('title');
    const text = r.innerText || '';
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const busy = lines.some((l) => TYPING.test(l) && l.length < 40) || lines.some((l) => DRAFT.test(l));
    return { name, time: readTime(r), out: isOutgoing(r), unread: isUnread(r), busy, group: isGroup(r), el: r };
  }

  let pending = new Set();
  window.__waSetPending = (names) => { pending = new Set(names); mark(); };

  function mark() {
    for (const r of rows()) {
      const el = r.querySelector('[data-testid="cell-frame-title"] span[title]') || r.querySelector('span[title]');
      const name = el.getAttribute('title');
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

  // ---------- אבחון: מבנה שורות הצ'אטים בלי טקסט ושמות ----------
  window.__waDebug = function () {
    const KEEP = /^(\d{1,2}:\d{2}.*|אתמול|yesterday|\d+)$/i;
    const clean = (node) => {
      const c = node.cloneNode(true);
      const walk = (n) => {
        for (const ch of [...n.childNodes]) {
          if (ch.nodeType === 3) {
            const t = ch.textContent.trim();
            const inTitle = n.tagName && n.tagName.toLowerCase() === 'title';
            if (t && !KEEP.test(t) && !(inTitle && /^[\w-]+$/.test(t))) ch.textContent = '[' + t.length + ']';
          }
          else if (ch.nodeType === 1) {
            if (ch.hasAttribute('title')) ch.setAttribute('title', 'NAME');
            if (ch.tagName === 'IMG') ch.removeAttribute('src');
            ch.removeAttribute('style');
            if (ch.tagName === 'path') ch.removeAttribute('d');
            walk(ch);
          }
        }
      };
      walk(c);
      return c.outerHTML.replace(/ class="[^"]*"/g, '');
    };
    return rows().slice(0, 30).map((r) => {
      const d = readRow(r);
      return `=== out=${d.out} group=${d.group} unread=${d.unread} busy=${d.busy} time=${d.time}\n${clean(r)}`;
    }).join('\n\n') || ('NO ROWS. pane-side=' + !!document.querySelector('#pane-side'));
  };

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

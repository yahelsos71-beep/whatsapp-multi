// 🎫 משימות צוות: קריאות פנימיות שמועברות לאיש צוות (טל / חני / חיים / נועה...)
// הנתונים: data/service_calls.json = { seq, calls: [...] }. רשימת המטפלים: config.svcHandlers = [{ userId, color }]
// כל הבדיקות (ולידציה + הרשאות) כאן בשרת.

const STATUSES = ['new', 'progress', 'closed'];
const COLORS = ['#2b7de9', '#d6336c', '#2f9e44', '#f08c00', '#7048e8', '#0c8599', '#e8590c', '#5c940d'];
const LIMITS = { subject: 120, customer: 120, phone: 20, details: 2000 };

// טקסט נקי: בלי תווי בקרה, בלי רווחים מיותרים, באורך מוגבל
function clean(v, max, multiline = false) {
  let s = String(v ?? '');
  s = multiline ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '') : s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  return s.trim().slice(0, max);
}

module.exports = function createSvc({ db, save, saveConfig, userById, now }) {
  const handlers = () => (db.config.svcHandlers || [])
    .map((h) => ({ ...h, user: userById(h.userId) }))
    .filter((h) => h.user && h.user.active !== false);
  const handlerOf = (userId) => handlers().find((h) => h.userId === userId);
  const isAdmin = (u) => !!u && u.role === 'admin';
  // מטפל (או מנהל) יכול לשנות סטטוס ולהעביר
  const canManage = (u) => isAdmin(u) || !!(u && handlerOf(u.id));
  const nameOf = (id) => (userById(id) || {}).name || '—';
  const byId = (id) => db.serviceCalls.calls.find((c) => c.id === Number(id));

  function view(c) {
    return {
      id: c.id, subject: c.subject, customer: c.customer, phone: c.phone, details: c.details, urgent: c.urgent, status: c.status, dueAt: c.dueAt || null,
      assigneeId: c.assigneeId, assigneeName: nameOf(c.assigneeId),
      createdAt: c.createdAt, createdBy: c.createdBy, createdByName: nameOf(c.createdBy), closedAt: c.closedAt || null,
      history: (c.history || []).map((h) => ({ ...h, byName: nameOf(h.by), fromName: h.kind === 'assign' ? nameOf(h.from) : undefined, toName: h.kind === 'assign' ? nameOf(h.to) : undefined })),
    };
  }
  const handlersView = () => handlers().map((h) => ({ userId: h.userId, name: h.user.name, color: h.color }));

  function state(user) {
    return { handlers: handlersView(), calls: db.serviceCalls.calls.map(view), canManage: canManage(user), isAdmin: isAdmin(user), whatsapp: !!db.config.svcWhatsApp };
  }

  // פתיחת קריאה – כל משתמש מחובר
  function create(user, b) {
    b = b && typeof b === 'object' ? b : {};
    const subject = clean(b.subject, LIMITS.subject);
    if (subject.length < 2) return { error: 'חסר נושא לקריאה' };
    const assignee = handlerOf(String(b.assigneeId || ''));
    if (!assignee) return { error: 'צריך לבחור למי להעביר את הקריאה' };
    const phone = clean(b.phone, 40);
    if (phone && !/^[0-9+\-() ]{3,20}$/.test(phone)) return { error: 'מספר הטלפון לא תקין' };
    const t = now();
    const c = {
      id: ++db.serviceCalls.seq, // מספר רץ – נוצר כאן בשרת בלבד
      subject, customer: clean(b.customer, LIMITS.customer), phone, details: clean(b.details, LIMITS.details, true), urgent: b.urgent === true,
      status: 'new', assigneeId: assignee.userId, createdAt: t, createdBy: user.id, closedAt: null,
      dueAt: Number(b.dueAt) > 0 ? Number(b.dueAt) : null, via: b.via === 'whatsapp' ? 'whatsapp' : undefined,
      history: [{ ts: t, by: user.id, kind: 'open', to: assignee.userId }],
    };
    db.serviceCalls.calls.push(c);
    save();
    return { call: view(c), assignee };
  }

  // התחלתי לטפל / סגור / פתח מחדש / העבר – מטפל או מנהל
  function act(user, id, b) {
    if (!canManage(user)) return { code: 403, error: 'רק מטפל יכול לשנות קריאה' };
    const c = byId(id);
    if (!c) return { code: 404, error: 'הקריאה לא נמצאה' };
    b = b && typeof b === 'object' ? b : {};
    const t = now();
    const setStatus = (to) => {
      if (c.status === to) return;
      c.history.push({ ts: t, by: user.id, kind: 'status', from: c.status, to });
      c.status = to;
      c.closedAt = to === 'closed' ? t : null;
    };
    let assigned = null;
    switch (b.action) {
      case 'start': if (c.status === 'closed') return { code: 400, error: 'הקריאה סגורה – קודם לפתוח מחדש' }; setStatus('progress'); break;
      case 'close': setStatus('closed'); break;
      case 'reopen': if (c.status !== 'closed') return { code: 400, error: 'הקריאה לא סגורה' }; setStatus('new'); break;
      case 'transfer': {
        const to = handlerOf(String(b.to || ''));
        if (!to) return { code: 400, error: 'צריך לבחור מטפל מהרשימה' };
        if (to.userId === c.assigneeId) return { code: 400, error: 'הקריאה כבר אצל ' + to.user.name };
        c.history.push({ ts: t, by: user.id, kind: 'assign', from: c.assigneeId, to: to.userId });
        c.assigneeId = to.userId;
        setStatus('new'); // העברה מחזירה ל"חדשה"
        assigned = to;
        break;
      }
      default: return { code: 400, error: 'פעולה לא מוכרת' };
    }
    save();
    return { call: view(c), assignee: assigned };
  }

  // מחיקה – מנהל בלבד
  function remove(user, id) {
    if (!isAdmin(user)) return { code: 403, error: 'רק מנהל יכול למחוק' };
    const i = db.serviceCalls.calls.findIndex((c) => c.id === Number(id));
    if (i < 0) return { code: 404, error: 'הקריאה לא נמצאה' };
    db.serviceCalls.calls.splice(i, 1);
    save();
    return { ok: true };
  }

  // עריכת רשימת המטפלים – מנהל בלבד
  function setHandlers(user, b) {
    if (!isAdmin(user)) return { code: 403, error: 'למנהל בלבד' };
    const list = Array.isArray(b && b.handlers) ? b.handlers : null;
    if (!list || list.length > 20) return { code: 400, error: 'רשימה לא תקינה' };
    const out = [];
    for (const h of list) {
      const u = userById(String((h && h.userId) || ''));
      if (!u) return { code: 400, error: 'משתמש לא קיים' };
      if (out.some((x) => x.userId === u.id)) continue;
      const color = /^#[0-9a-f]{6}$/i.test(String(h.color || '')) ? String(h.color).toLowerCase() : COLORS[out.length % COLORS.length];
      out.push({ userId: u.id, color });
    }
    db.config.svcHandlers = out;
    if (b.whatsapp !== undefined) db.config.svcWhatsApp = b.whatsapp === true;
    saveConfig();
    return { ok: true };
  }

  return { state, create, act, remove, setHandlers, view, handlersView, STATUSES };
};
module.exports.COLORS = COLORS;
module.exports.clean = clean;

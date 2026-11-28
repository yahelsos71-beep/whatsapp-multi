// 🏢 קריאת שירות לספק (גרסה 98)
// המוקד מתכתב לבד עם בוט הוואטסאפ של ספק (בזק, הוט...) עד שמגיעים לנציג אנושי – ואז עוצר ומודיע.
// הגדרות הספקים: data/vendorbots.json (רק בשרת – לא במאגר, יש בו מספרי טלפון). דוגמה למבנה – בסוף הקובץ.
//
// איך בוחרים בתפריט: שולחים את השם המדויק של האפשרות (Green API לא יודע "ללחוץ"; הבוטים מקבלים את הטקסט).
// סדר עדיפויות בכל תפריט: 1) אפשרות עם "נציג" (לא "דיגיטלי")  2) prefer לפי הסדר ({fault} = התקלה שנבחרה)
// 3) אין התאמה → עוצרים ומודיעים. שאלה בלי תפריט → answers (re → reply), אחרת מחכים.
// "direct": true – ספק בלי בוט: שולחים פתיחה ומחכים; ההודעה הראשונה שלהם = נציג ענה (גרסה 101).
const fs = require('fs');
const path = require('path');

const HUMAN_OPT = /נציג/;
const NOT_HUMAN_OPT = /דיגיטלי|וירטואלי/;
const QUEUE_RE = /יתפנה|בתור|ממתינ|נחזור אליך|יחזור אליך|בהקדם|קיבלנו את הפנייה/;
const HUMAN_RE = /שמי\s+\S+|אני\s+\S+\s+ואטפל|אטפל בפנייתך|(^|\s)(היי|הי|שלום|בוקר טוב|ערב טוב)[^א-ת]*אני\s+[א-ת]+/;
const MAX_STEPS = 30;
const STALL_MS = 120000;

module.exports = function createVendorBot({ dataDir, log, note, sendText, ga, instById, instPhone, emitTicket, sendTo, userById }) {
  const sessions = new Map(); // instId|chatId -> session
  const file = path.join(dataDir, 'vendorbots.json');
  const cfg = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { vendors: [] }; } };
  const vendors = () => (cfg().vendors || []).filter((v) => v && v.id && v.phone && v.instanceId);
  const fill = (s, vars) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  const norm = (s) => String(s || '').replace(/[‎‏*_~]/g, '').replace(/\s+/g, ' ').trim();

  function list() {
    return vendors().map((v) => ({ id: v.id, name: v.name, icon: v.icon || '🏢', faults: v.faults || [], fields: v.fields || [],
      active: [...sessions.values()].some((s) => s.vendorId === v.id && s.state !== 'done' && s.state !== 'stopped') }));
  }

  async function notifyBoss(s, text) {
    const c = cfg().notify || {};
    try {
      const from = instById(c.instanceId);
      let to = c.phone;
      if (!to && c.toInstanceId) { const ti = instById(c.toInstanceId); to = ti && await instPhone(ti); }
      if (from && to) await ga.sendMessage(from, String(to).replace(/\D/g, '') + '@c.us', text);
    } catch (e) { log('vendorbot notify', e.message); }
    if (s.userId) sendTo(s.userId, { type: 'vendorbot', text, ticketId: s.ticketId || null, human: s.state === 'done', vendor: s.vendorName });
  }

  async function start({ vendorId, fault, values, user }) {
    const v = vendors().find((x) => x.id === vendorId);
    if (!v) throw new Error('הספק לא מוגדר');
    const inst = instById(v.instanceId);
    if (!inst) throw new Error('מספר הוואטסאפ של הספק לא מוגדר במוקד');
    const chatId = String(v.phone).replace(/\D/g, '') + '@c.us';
    const key = inst.id + '|' + chatId;
    const old = sessions.get(key);
    if (old && (old.state === 'running' || old.state === 'queued') && Date.now() - old.lastAt < 30 * 60000) throw new Error(`כבר יש פנייה פעילה ל${v.name} (נפתחה ע"י ${old.userName})`);
    const vars = { fault: fault || '' };
    for (const f of v.fields || []) {
      let val = String((values || {})[f.key] || '').trim();
      if (f.digits) val = val.replace(/\D/g, '');
      if (f.required && !val) throw new Error(`חסר: ${f.label}`);
      vars[f.key] = val;
    }
    if ((v.faults || []).length && !vars.fault) throw new Error('בחר סוג תקלה');
    const s = { key, vendorId: v.id, vendorName: v.name, vars, userId: user.id, userName: user.name, startedAt: Date.now(), lastAt: Date.now(),
      state: 'running', steps: 0, askedHuman: false, choices: {}, ticketId: null, pending: null, timer: null, stall: null };
    sessions.set(key, s);
    await ga.sendMessage(inst, chatId, fill(v.opening || 'שלום, אני צריך תמיכה טכנית – {fault}. נציג אנושי בבקשה.', vars));
    // "direct": ספק בלי בוט (נציג עונה ישר, למשל YDM) – מחכים לנציג בלי הגבלת זמן; כל הודעה ממנו = נציג ענה
    if (v.direct) { s.state = 'queued'; s.askedHuman = true; } else armStall(s);
    log(`vendorbot start ${v.name} by ${user.name} (${vars.fault})`);
    return { ok: true, vendor: v.name };
  }

  function armStall(s) {
    clearTimeout(s.stall);
    s.stall = setTimeout(() => {
      if (s.state !== 'running') return;
      s.state = 'stopped';
      notifyBoss(s, `⚠️ בוט ${s.vendorName}: אין התקדמות כבר ${Math.round(STALL_MS / 60000)} דקות – תמשיך ידנית${s.ticketId ? ` (קריאה #${s.ticketId})` : ''}`);
    }, STALL_MS);
  }

  function finish(t, s, state, msg) {
    s.state = state; clearTimeout(s.stall); clearTimeout(s.timer);
    if (t) { note(t, msg); emitTicket(t, { sound: 'new' }); }
    notifyBoss(s, msg);
  }

  // נקרא מהמוקד על כל הודעה נכנסת בצ'אט פרטי (אחרי שנשמרה בקריאה)
  function onIncoming(t, m) {
    const s = sessions.get(t.instanceId + '|' + t.chatId);
    if (!s || s.state === 'done' || s.state === 'stopped') return;
    s.lastAt = Date.now();
    if (!s.ticketId) {
      s.ticketId = t.id;
      if (s.userId && userById(s.userId) && t.assigneeId !== s.userId) { t.assigneeId = s.userId; t.departmentId = null; }
      t.vendorBot = s.vendorId;
      note(t, `🏢 קריאת שירות ל${s.vendorName} – נפתחה ע"י ${s.userName}${s.vars.fault ? ' · ' + s.vars.fault : ''}${s.vars.line ? ' · קו ' + s.vars.line : ''}. הבוט שלנו מתכתב עד שמגיע נציג אנושי.`);
      emitTicket(t);
    }
    const text = norm(m.text);
    const hasOpts = (m.options || []).some((o) => o.kind === 'reply');
    // הגענו לנציג?
    if (!hasOpts && ((HUMAN_RE.test(text) && !NOT_HUMAN_OPT.test(text) && !/הבוט|בוט /.test(text)) || (s.state === 'queued' && text && !QUEUE_RE.test(text)))) {
      return finish(t, s, 'done', `✅ ${s.vendorName}: הגענו לנציג אנושי – תמשיך את השיחה במוקד, קריאה #${t.id}${text ? `\n"${text.slice(0, 120)}"` : ''}`);
    }
    if (!hasOpts && s.askedHuman && QUEUE_RE.test(text) && !(vendors().find((x) => x.id === s.vendorId) || {}).direct) {
      if (s.state !== 'queued') { s.state = 'queued'; clearTimeout(s.stall); note(t, `⏳ ${s.vendorName}: בתור לנציג אנושי`); notifyBoss(s, `⏳ ${s.vendorName}: אנחנו בתור לנציג אנושי (קריאה #${t.id}). אודיע כשהוא כותב.`); }
      return;
    }
    if (s.state !== 'running') return;
    // מחכים רגע – בוטים שולחים כמה הודעות ברצף; מגיבים להודעה האחרונה
    s.pending = { text, options: hasOpts ? m.options.filter((o) => o.kind === 'reply').map((o) => norm(o.value || o.text)) : [] };
    clearTimeout(s.timer);
    s.timer = setTimeout(() => act(t, s).catch((e) => { log('vendorbot act', e.message); finish(t, s, 'stopped', `⚠️ ${s.vendorName}: שגיאה בשליחה (${e.message}) – תמשיך ידנית, קריאה #${t.id}`); }), 3500);
    armStall(s);
  }

  async function act(t, s) {
    const p = s.pending; s.pending = null;
    if (!p || s.state !== 'running') return;
    const v = vendors().find((x) => x.id === s.vendorId) || {};
    let reply = '';
    if (p.options.length) {
      const human = p.options.find((o) => HUMAN_OPT.test(o) && !NOT_HUMAN_OPT.test(o));
      if (human) { reply = human; s.askedHuman = true; }
      else {
        for (const pref of v.prefer || ['{fault}']) {
          const want = norm(fill(pref, s.vars));
          if (!want) continue;
          const hit = p.options.find((o) => o === want) || p.options.find((o) => o.includes(want));
          if (hit) { reply = hit; break; }
        }
      }
      if (!reply) return finish(t, s, 'stopped', `⚠️ ${s.vendorName}: הבוט שאל שאלה שאני לא מכיר – תבחר ידנית, קריאה #${t.id}\n${p.text.slice(0, 150)}\nאפשרויות: ${p.options.join(' / ')}`);
    } else {
      const a = (v.answers || []).find((x) => { try { return new RegExp(x.re).test(p.text); } catch { return false; } });
      if (!a) return; // הודעת מידע – מחכים להודעה הבאה
      reply = fill(a.reply, s.vars);
    }
    s.choices[reply] = (s.choices[reply] || 0) + 1;
    if (s.choices[reply] > 3 || ++s.steps > MAX_STEPS) return finish(t, s, 'stopped', `⚠️ ${s.vendorName}: הבוט חוזר על עצמו – תמשיך ידנית, קריאה #${t.id}`);
    await sendText(t, reply, null, { auto: true, byName: '🤖 בוט ספקים' });
  }

  return { list, start, onIncoming };
};

/* data/vendorbots.json – דוגמה (המספרים רק בשרת):
{
  "notify": { "instanceId": "<מזהה המספר ששולח את ההתראה>", "toInstanceId": "<מזהה המספר שמקבל>" },
  "vendors": [{
    "id": "bezeq", "name": "בזק", "icon": "📞", "instanceId": "<המספר שממנו מתכתבים>", "phone": "9725XXXXXXXX",
    "fields": [{ "key": "line", "label": "מספר הקו (כולל קידומת)", "required": true, "digits": true }],
    "faults": ["אין לי אינטרנט כלל", "איטיות באינטרנט"],
    "opening": "שלום, יש תקלה בקו {line} – {fault}. אני צריך תמיכה טכנית, נציג אנושי.",
    "answers": [{ "re": "מספר קו|מנוי האינטרנט", "reply": "{line}" }],
    "prefer": ["{fault}", "מספר קו בזק/אינטרנט", "טיפול בתקלה", "רוצה להזדהות", "עדיין"]
  }]
}
*/

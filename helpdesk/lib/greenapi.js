// חיבור ל-Green API: קבלת התראות (polling), שליחת הודעות וקבצים, הגדרות
const base = (inst, media) =>
  String((media ? inst.mediaUrl : inst.apiUrl) || (media ? 'https://media.green-api.com' : 'https://api.green-api.com')).replace(/\/+$/, '');
const url = (inst, method, { media = false, suffix = '', query = '' } = {}) =>
  `${base(inst, media)}/waInstance${inst.idInstance}/${method}/${inst.token}${suffix}${query}`;

async function call(inst, method, opts = {}) {
  const init = { method: opts.httpMethod || 'GET', signal: AbortSignal.timeout(opts.timeoutMs || 30000) };
  if (opts.json !== undefined) {
    init.method = opts.httpMethod || 'POST';
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.json);
  }
  if (opts.form) { init.method = 'POST'; init.body = opts.form; }
  const r = await fetch(url(inst, method, opts), init);
  const text = await r.text();
  if (!r.ok) throw new Error(`Green API ${method}: ${r.status} ${text.slice(0, 200)}`);
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

const receiveNotification = (inst) => call(inst, 'receiveNotification', { query: '?receiveTimeout=20', timeoutMs: 40000 });
const deleteNotification = (inst, receiptId) => call(inst, 'deleteNotification', { httpMethod: 'DELETE', suffix: '/' + receiptId });
const sendMessage = (inst, chatId, message) => call(inst, 'sendMessage', { json: { chatId, message } });
const getStateInstance = (inst) => call(inst, 'getStateInstance', { timeoutMs: 15000 });
// מפעיל את ההתראות שהמערכת צריכה (נכנסות, יוצאות מהטלפון, יוצאות מה-API, סטטוסים)
const enableNotifications = (inst) => call(inst, 'setSettings', {
  json: {
    webhookUrl: '',
    incomingWebhook: 'yes',
    outgoingMessageWebhook: 'yes',
    outgoingAPIMessageWebhook: 'yes',
    outgoingWebhook: 'yes',
    stateWebhook: 'yes',
  },
});

async function sendFile(inst, chatId, buffer, fileName, mime, caption) {
  const form = new FormData();
  form.append('chatId', chatId);
  form.append('fileName', fileName);
  if (caption) form.append('caption', caption);
  form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), fileName);
  return call(inst, 'sendFileByUpload', { media: true, form, timeoutMs: 120000 });
}

// ממיר הודעה של Green API למבנה שלנו
function parseMessage(md) {
  const t = md && md.typeMessage;
  const out = { type: 'text', text: '' };
  if (!t) return out;
  if (t === 'textMessage') out.text = md.textMessageData?.textMessage || '';
  else if (t === 'extendedTextMessage' || t === 'quotedMessage') out.text = md.extendedTextMessageData?.text || '';
  else if (['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'].includes(t)) {
    const f = md.fileMessageData || {};
    out.type = { imageMessage: 'image', videoMessage: 'video', documentMessage: 'file', audioMessage: 'audio', stickerMessage: 'image' }[t];
    out.url = f.downloadUrl || '';
    out.fileName = f.fileName || '';
    out.mime = f.mimeType || '';
    out.text = f.caption || '';
  } else if (t === 'locationMessage') {
    const l = md.locationMessageData || {};
    out.type = 'location';
    out.text = l.nameLocation || l.address || 'מיקום';
    out.url = `https://maps.google.com/?q=${l.latitude},${l.longitude}`;
  } else if (t === 'contactMessage') {
    out.text = '👤 איש קשר: ' + (md.contactMessageData?.displayName || '');
  } else if (t === 'reactionMessage') {
    out.type = 'reaction';
    out.text = md.extendedTextMessageData?.text || '';
  } else if (t === 'editedMessage') {
    out.type = 'edited';
    out.text = md.editedMessageData?.textMessage || md.extendedTextMessageData?.text || '';
  } else if (t === 'deletedMessage') {
    out.type = 'deleted';
  } else {
    out.text = `[הודעה מסוג ${t}]`;
  }
  return out;
}

// פרטי קבוצה (כולל המשתתפים)
const getGroupData = (inst, groupId) => call(inst, 'getGroupData', { json: { groupId }, timeoutMs: 30000 });

// היסטוריית צ'אט מוואטסאפ (ההודעות האחרונות, כולל מלפני המוקד)
const getChatHistory = (inst, chatId, count = 100) => call(inst, 'getChatHistory', { json: { chatId, count }, timeoutMs: 60000 });

// ממיר פריט מההיסטוריה של Green API למבנה שלנו
function parseHistoryItem(h) {
  const t = h.typeMessage || '';
  const type = { imageMessage: 'image', videoMessage: 'video', documentMessage: 'file', audioMessage: 'audio', stickerMessage: 'image', locationMessage: 'location' }[t] || 'text';
  let text = h.textMessage || (h.extendedTextMessage && h.extendedTextMessage.text) || h.caption || '';
  if (!text && t === 'contactMessage') text = '👤 איש קשר';
  if (!text && t === 'reactionMessage') text = '(תגובה)';
  if (!text && t === 'deletedMessage') text = '(הודעה נמחקה)';
  if (!text && type === 'text' && t && !/text/i.test(t)) text = `[${t}]`;
  return {
    id: h.idMessage, dir: h.type === 'outgoing' ? 'out' : 'in', ts: (h.timestamp || 0) * 1000, type, text,
    url: h.downloadUrl || (t === 'locationMessage' && h.location ? `https://maps.google.com/?q=${h.location.latitude},${h.location.longitude}` : ''),
    fileName: h.fileName || '', senderName: h.type === 'outgoing' ? '' : h.senderName || h.senderContactName || '', status: h.statusMessage || '',
  };
}

module.exports = { getGroupData, getChatHistory, parseHistoryItem, receiveNotification, deleteNotification, sendMessage, sendFile, getStateInstance, enableNotifications, parseMessage };

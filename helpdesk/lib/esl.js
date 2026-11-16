// חיבור ל-FreeSWITCH / FusionPBX דרך Event Socket (ESL, ברירת מחדל פורט 8021)
// מקבל אירועי שיחה (נכנסת / נענתה / הסתיימה) ושולח פקודות (חיוג – originate)
const net = require('net');
const { EventEmitter } = require('events');

class Esl extends EventEmitter {
  constructor() { super(); this.sock = null; this.buf = Buffer.alloc(0); this.ok = false; this.cfg = null; this.timer = null; this.pending = []; }

  start(cfg) {
    this.stop();
    this.cfg = cfg;
    this.connect();
  }

  stop() {
    clearTimeout(this.timer); this.timer = null;
    this.cfg = null; this.ok = false;
    if (this.sock) { this.sock.removeAllListeners(); this.sock.destroy(); this.sock = null; }
  }

  connect() {
    const cfg = this.cfg; if (!cfg) return;
    this.buf = Buffer.alloc(0); this.ok = false;
    const s = net.connect({ host: cfg.host || '127.0.0.1', port: Number(cfg.port) || 8021 });
    this.sock = s;
    s.setKeepAlive(true, 30000);
    s.setTimeout(15000, () => { if (!this.ok) s.destroy(new Error('אין תשובה מהמרכזייה (timeout)')); });
    s.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    s.on('error', (e) => { this.emit('status', 'error', e.message); });
    s.on('close', () => {
      const was = this.ok; this.ok = false;
      if (was) this.emit('status', 'error', 'החיבור למרכזייה נותק – מתחבר מחדש...');
      if (this.cfg && this.sock === s) this.timer = setTimeout(() => this.connect(), 10000);
    });
  }

  send(cmd) { if (this.sock && !this.sock.destroyed) this.sock.write(cmd + '\n\n'); }

  // פקודה ברקע (bgapi) – מחזיר את תוצאת ההפעלה המיידית
  api(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.ok) return reject(new Error('אין חיבור למרכזייה'));
      this.pending.push({ resolve, reject, at: Date.now() });
      this.send('bgapi ' + cmd);
      setTimeout(() => { const i = this.pending.findIndex((p) => p.resolve === resolve); if (i >= 0) { this.pending.splice(i, 1); reject(new Error('אין תשובה מהמרכזייה')); } }, 10000);
    });
  }

  parse() {
    for (;;) {
      const sep = this.buf.indexOf('\n\n');
      if (sep < 0) return;
      const head = parseHeaders(this.buf.slice(0, sep).toString('utf8'), false);
      const len = Number(head['Content-Length'] || 0);
      if (this.buf.length < sep + 2 + len) return;
      const body = this.buf.slice(sep + 2, sep + 2 + len).toString('utf8');
      this.buf = this.buf.slice(sep + 2 + len);
      this.onMessage(head, body);
    }
  }

  onMessage(head, body) {
    const type = head['Content-Type'];
    if (type === 'auth/request') { this.send('auth ' + (this.cfg.password || 'ClueCon')); return; }
    if (type === 'command/reply') {
      const reply = head['Reply-Text'] || '';
      if (!this.ok) {
        if (/^\+OK accepted/.test(reply)) {
          this.ok = true; this.sock.setTimeout(0);
          this.send('event plain CHANNEL_CREATE CHANNEL_ANSWER CHANNEL_HANGUP_COMPLETE');
          this.emit('status', 'ok', 'מחובר ✓');
        } else if (/^-ERR/.test(reply)) {
          this.emit('status', 'error', 'הסיסמה של Event Socket שגויה'); this.cfg && this.sock.destroy();
        }
        return;
      }
      if (/Job-UUID/.test(reply) || head['Job-UUID']) { const p = this.pending.shift(); if (p) p.resolve(reply); }
      else if (/^-ERR/.test(reply)) { const p = this.pending.shift(); if (p) p.reject(new Error(reply)); }
      return;
    }
    if (type === 'text/event-plain') { this.emit('event', parseHeaders(body, true)); return; }
    if (type === 'text/disconnect-notice') { this.sock.destroy(); }
  }
}

function parseHeaders(text, decode) {
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(': ');
    if (i < 0) continue;
    const k = line.slice(0, i); let v = line.slice(i + 2);
    if (decode) { try { v = decodeURIComponent(v); } catch {} }
    out[k] = v;
  }
  return out;
}

module.exports = { Esl, parseHeaders };

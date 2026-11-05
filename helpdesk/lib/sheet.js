// קורא קבצי אקסל (xlsx) ו-CSV בלי ספריות חיצוניות – בשביל ייבוא אנשי קשר מ-iCount
const zlib = require('zlib');

// ---------- CSV ----------
function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.slice(2));
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  try { return new TextDecoder('windows-1255').decode(buf); } catch { return utf8; } // עברית של אקסל ישן
}
function parseCsv(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

// ---------- XLSX (zip + xml) ----------
function unzip(buf) {
  // מאתרים את ה-central directory בסוף הקובץ
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('הקובץ לא נראה כמו קובץ אקסל (xlsx)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const data = buf.slice(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + csize);
    files[name] = () => (method === 0 ? data : zlib.inflateRawSync(data));
    p += 46 + nameLen + extraLen + commLen;
  }
  return files;
}
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const textOf = (xml) => [...xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => unxml(m[1])).join('');
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

function parseXlsx(buf) {
  const files = unzip(buf);
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    const xml = files['xl/sharedStrings.xml']().toString('utf8');
    for (const m of xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)) shared.push(textOf(m[1]));
  }
  // הגיליון הראשון לפי workbook + rels
  let sheetPath = null;
  try {
    const wb = files['xl/workbook.xml']().toString('utf8');
    const rid = /<(?:\w+:)?sheet\b[^>]*r:id="([^"]+)"/.exec(wb)[1];
    const rels = files['xl/_rels/workbook.xml.rels']().toString('utf8');
    const target = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels) || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels);
    sheetPath = target[1].startsWith('/') ? target[1].slice(1) : 'xl/' + target[1].replace(/^\.\//, '');
  } catch {}
  if (!sheetPath || !files[sheetPath]) sheetPath = Object.keys(files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort()[0];
  if (!sheetPath) throw new Error('לא נמצא גיליון בקובץ');
  const xml = files[sheetPath]().toString('utf8');
  const rows = [];
  for (const rm of xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = cm[1], inner = cm[2] || '';
      const ref = (/\br="([A-Z]+\d+)"/.exec(attrs) || [])[1];
      const type = (/\bt="(\w+)"/.exec(attrs) || [])[1];
      const v = (/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner) || [])[1];
      let val = '';
      if (type === 's') val = shared[+v] ?? '';
      else if (type === 'inlineStr') val = textOf(inner);
      else if (v !== undefined) val = unxml(v);
      const idx = ref ? colIndex(ref) : row.length;
      row[idx] = val;
    }
    rows.push(Array.from(row, (c) => (c === undefined ? '' : String(c))));
  }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

function parseSheet(buf, fileName = '') {
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  if (isZip) return parseXlsx(buf);
  if (buf[0] === 0xd0 && buf[1] === 0xcf) throw new Error('זה קובץ אקסל ישן (xls). פתח אותו באקסל ושמור בשם כ-xlsx או CSV');
  return parseCsv(decodeText(buf));
}

module.exports = { parseSheet };

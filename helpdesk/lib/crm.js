// חיבור ל-CRM של SmartSale דרך כתובת ה-MCP שלו (Streamable HTTP, JSON-RPC)
// מושך לקוחות פעילים ואת השדות "סוג שירות" ו"סוג מרכזיה" – בשביל הפצה לפי מוצר
let session = { url: '', id: '', ready: false };
let rpcId = 1;

async function post(url, body, sessionId) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const sid = r.headers.get('mcp-session-id') || sessionId || '';
  const text = await r.text();
  if (!r.ok) throw new Error(`CRM ${r.status}: ${text.replace(/<[^>]+>/g, ' ').trim().slice(0, 160)}`);
  let msg = null;
  if ((r.headers.get('content-type') || '').includes('event-stream')) {
    for (const line of text.split('\n')) if (line.startsWith('data:')) { try { const j = JSON.parse(line.slice(5).trim()); if (j.id === body.id) msg = j; } catch {} }
  } else if (text.trim()) { try { msg = JSON.parse(text); } catch {} }
  return { msg, sid };
}

async function ensure(url) {
  if (session.ready && session.url === url) return session.id;
  const init = { jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'kc-helpdesk', version: '1' } } };
  const { msg, sid } = await post(url, init, '');
  if (msg && msg.error) throw new Error('CRM: ' + (msg.error.message || 'initialize failed'));
  try { await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid); } catch {}
  session = { url, id: sid, ready: true };
  return sid;
}

async function callTool(url, name, args) {
  const sid = await ensure(url);
  const body = { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args || {} } };
  let { msg } = await post(url, body, sid).catch(async (e) => { session.ready = false; const s2 = await ensure(url); return post(url, body, s2); });
  if (!msg) throw new Error('אין תשובה מה-CRM');
  if (msg.error) throw new Error('CRM: ' + (msg.error.message || 'error'));
  const txt = ((msg.result && msg.result.content) || []).map((c) => c.text || '').join('');
  if (msg.result && msg.result.isError) throw new Error('CRM: ' + txt.slice(0, 160));
  try { return JSON.parse(txt); } catch { return txt; }
}

// כל הלקוחות הפעילים + השדות שלהם (סוג שירות, סוג מרכזיה)
async function activeCustomers(url, onProgress) {
  const leads = [];
  for (let off = 0; off < 5000; off += 100) {
    const r = await callTool(url, 'list_leads', { status: 'activeclient', limit: 100, offset: off });
    const list = (r && r.leads) || [];
    leads.push(...list);
    if (onProgress) onProgress(`נמשכו ${leads.length} לקוחות פעילים...`);
    if (list.length < 100) break;
  }
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < leads.length) {
      const l = leads[i++];
      let services = [], pbx = '';
      try {
        const d = await callTool(url, 'get_lead', { lead_id: l.id });
        for (const f of (d && d.custom_fields) || []) {
          const label = String((f.custom_field_definitions && (f.custom_field_definitions.label || f.custom_field_definitions.name)) || '').trim();
          let v = f.value; try { v = JSON.parse(v); } catch {}
          if (/סוג שירות|^want$/.test(label)) services = Array.isArray(v) ? v : [v].filter(Boolean);
          if (/סוג מרכזי|^sug$/.test(label)) pbx = Array.isArray(v) ? v[0] : String(v || '');
        }
      } catch {}
      out.push({ id: l.id, name: [l.name, l.last_name].filter(Boolean).join(' ').trim(), company: l.company || '', phone: l.phone || '', services, pbx });
      if (onProgress && out.length % 20 === 0) onProgress(`נבדקו ${out.length} מתוך ${leads.length} לקוחות...`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

module.exports = { activeCustomers, callTool };

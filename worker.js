/* Free Food Stockpile — applications backend + admin dashboard.
   Bindings: DB (D1), CARDS (R2), ASSETS (static site). Secret: ADMIN_PASSWORD. */

const STATUSES = ['New', 'In Review', 'Approved', 'Enrolled', 'On Hold', 'Not Eligible'];
const ALLOWED_ORIGINS = [
  'https://jgffyjbv.github.io',
  'https://freefoodstockpile.org',
  'https://www.freefoodstockpile.org'
];

const FIELD_MAP = {
  'First Name': 'first_name', 'Last Name': 'last_name', 'Date of Birth': 'dob',
  'Social Security Number': 'ssn', 'Medicaid CIN ID': 'medicaid_cin', 'Phone': 'phone',
  'Email': 'email', 'Street Address': 'street', 'City': 'city', 'Region': 'region',
  'State': 'state', 'ZIP Code': 'zip', 'Language Preference': 'language',
  'Total Household Members': 'household_total', 'Household Members': 'household_members',
  'Chronic Condition in Household': 'chronic_condition', 'Condition Details': 'condition_details',
  'Notes': 'notes_applicant', 'Consent': 'consent'
};
const EDITABLE = Object.values(FIELD_MAP).concat(['status']);

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}
const json = (data, status, extra) =>
  new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, extra || {}) });

/* ---------- password + session auth ----------
   The admin password lives in the D1 `settings` table (PBKDF2 hash + salt), so it
   can be changed from the dashboard and reset without redeploying. Sessions are
   signed with a stable random `session_secret` (also in settings), so changing the
   password does not silently break the signing key. env.ADMIN_PASSWORD is only a
   one-time migration seed if the table was never initialised. */
function bytesToHex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function hexToBytes(hex) { return Uint8Array.from((hex.match(/../g) || []).map(h => parseInt(h, 16))); }
function randHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return bytesToHex(a); }
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return bytesToHex(sig);
}
async function pbkdf2Hex(password, saltHex, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: iter, hash: 'SHA-256' }, key, 256);
  return bytesToHex(bits);
}
async function getSetting(env, key) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
  return r ? r.value : null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, value).run();
}
async function setPassword(env, password) {
  const salt = randHex(16);
  await setSetting(env, 'pw_salt', salt);
  await setSetting(env, 'pw_iter', '100000');
  await setSetting(env, 'pw_hash', await pbkdf2Hex(password, salt, 100000));
}
async function loadSecret(env) {
  let secret = null;
  try { secret = await getSetting(env, 'session_secret'); } catch (e) { /* table missing */ }
  if (secret) return secret;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)').run();
  secret = await getSetting(env, 'session_secret');
  if (!secret) { secret = randHex(32); await setSetting(env, 'session_secret', secret); }
  if (!(await getSetting(env, 'pw_hash')) && env.ADMIN_PASSWORD) { await setPassword(env, env.ADMIN_PASSWORD); }
  return secret;
}
async function verifyPassword(env, password) {
  const pw = String(password == null ? '' : password).trim();
  if (!pw) return false;
  const hash = await getSetting(env, 'pw_hash');
  const salt = await getSetting(env, 'pw_salt');
  const iter = parseInt((await getSetting(env, 'pw_iter')) || '100000', 10);
  if (hash && salt) return timingSafeEqualHex(await pbkdf2Hex(pw, salt, iter), hash);
  return !!env.ADMIN_PASSWORD && pw === env.ADMIN_PASSWORD.trim();
}
async function makeSession(env) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30; // 30 days
  return (await hmac(await loadSecret(env), 'ffs|' + exp)) + '.' + exp;
}
async function checkSession(req, env) {
  const m = (req.headers.get('Cookie') || '').match(/ffs_session=([a-f0-9]+)\.(\d+)/);
  if (!m) return false;
  if (Date.now() > +m[2]) return false;
  return (await hmac(await loadSecret(env), 'ffs|' + m[2])) === m[1];
}

/* ---------- helpers ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });

    /* ============ PUBLIC: receive an application ============ */
    if (p === '/api/apply' && req.method === 'POST') {
      try {
        const fd = await req.formData();
        const row = {};
        for (const [label, col] of Object.entries(FIELD_MAP)) row[col] = String(fd.get(label) || '').slice(0, 4000);
        if (!row.first_name.trim() || !row.last_name.trim() || !row.phone.trim())
          return json({ success: false, error: 'missing required fields' }, 400, corsHeaders(req));

        let cardKey = '', cardType = '';
        const file = fd.get('attachment');
        if (file && typeof file === 'object' && file.size) {
          if (file.size > 10 * 1024 * 1024) return json({ success: false, error: 'file too large' }, 400, corsHeaders(req));
          const okTypes = ['image/png', 'image/jpeg', 'application/pdf'];
          if (okTypes.includes(file.type)) {
            const ext = file.type === 'application/pdf' ? 'pdf' : (file.type === 'image/png' ? 'png' : 'jpg');
            cardKey = 'cards/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
            await env.CARDS.put(cardKey, file.stream(), { httpMetadata: { contentType: file.type } });
            cardType = file.type;
          }
        }
        const cols = Object.values(FIELD_MAP);
        const stmt = 'INSERT INTO applications (' + cols.join(',') + ',card_key,card_type) VALUES (' + cols.map(() => '?').join(',') + ',?,?)';
        const res = await env.DB.prepare(stmt).bind(...cols.map(c => row[c]), cardKey, cardType).run();
        return json({ success: true, id: res.meta.last_row_id }, 200, corsHeaders(req));
      } catch (e) {
        return json({ success: false, error: 'server error' }, 500, corsHeaders(req));
      }
    }

    /* ============ ADMIN: login ============ */
    if (p === '/api/admin/login' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      if (!(await verifyPassword(env, body.password)))
        return json({ success: false }, 401);
      const sess = await makeSession(env);
      return json({ success: true }, 200, {
        'Set-Cookie': 'ffs_session=' + sess + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + 60 * 60 * 24 * 30
      });
    }

    /* ============ ADMIN: API (auth required) ============ */
    if (p.startsWith('/api/admin/')) {
      if (!(await checkSession(req, env))) return json({ success: false, error: 'unauthorized' }, 401);

      /* change the admin password (self-service) */
      if (p === '/api/admin/password' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        if (!(await verifyPassword(env, body.current)))
          return json({ success: false, error: 'Your current password is not correct.' }, 403);
        const next = String(body.next == null ? '' : body.next).trim();
        if (next.length < 8) return json({ success: false, error: 'Please choose a new password of at least 8 characters.' }, 400);
        await setPassword(env, next);
        const sess = await makeSession(env);
        return json({ success: true }, 200, {
          'Set-Cookie': 'ffs_session=' + sess + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + 60 * 60 * 24 * 30
        });
      }

      if (p === '/api/admin/applications' && req.method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim();
        let rows;
        if (q) {
          const like = '%' + q + '%';
          rows = await env.DB.prepare(
            'SELECT * FROM applications WHERE first_name LIKE ?1 OR last_name LIKE ?1 OR phone LIKE ?1 OR medicaid_cin LIKE ?1 OR city LIKE ?1 OR region LIKE ?1 ORDER BY id DESC LIMIT 500'
          ).bind(like).all();
        } else {
          rows = await env.DB.prepare('SELECT * FROM applications ORDER BY id DESC LIMIT 500').all();
        }
        return json({ success: true, applications: rows.results });
      }

      let m = p.match(/^\/api\/admin\/applications\/(\d+)$/);
      if (m && req.method === 'GET') {
        const app = await env.DB.prepare('SELECT * FROM applications WHERE id=?').bind(+m[1]).first();
        if (!app) return json({ success: false }, 404);
        const notes = await env.DB.prepare('SELECT * FROM app_notes WHERE application_id=? ORDER BY id DESC').bind(+m[1]).all();
        return json({ success: true, application: app, notes: notes.results });
      }
      if (m && req.method === 'PUT') {
        const body = await req.json().catch(() => ({}));
        const sets = [], vals = [];
        for (const [k, v] of Object.entries(body)) {
          if (!EDITABLE.includes(k)) continue;
          if (k === 'status' && !STATUSES.includes(v)) continue;
          sets.push(k + '=?'); vals.push(String(v == null ? '' : v).slice(0, 4000));
        }
        if (!sets.length) return json({ success: false, error: 'nothing to update' }, 400);
        vals.push(+m[1]);
        await env.DB.prepare('UPDATE applications SET ' + sets.join(',') + ", updated_at=datetime('now') WHERE id=?").bind(...vals).run();
        return json({ success: true });
      }

      m = p.match(/^\/api\/admin\/applications\/(\d+)\/notes$/);
      if (m && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const note = String(body.note || '').trim().slice(0, 4000);
        if (!note) return json({ success: false, error: 'empty note' }, 400);
        await env.DB.prepare('INSERT INTO app_notes (application_id, note) VALUES (?,?)').bind(+m[1], note).run();
        return json({ success: true });
      }

      m = p.match(/^\/api\/admin\/applications\/(\d+)\/card$/);
      if (m && req.method === 'GET') {
        const app = await env.DB.prepare('SELECT card_key, card_type FROM applications WHERE id=?').bind(+m[1]).first();
        if (!app || !app.card_key) return new Response('No card uploaded', { status: 404 });
        const obj = await env.CARDS.get(app.card_key);
        if (!obj) return new Response('File missing', { status: 404 });
        return new Response(obj.body, { headers: { 'Content-Type': app.card_type || 'application/octet-stream', 'Cache-Control': 'private, no-store' } });
      }

      return json({ success: false, error: 'not found' }, 404);
    }

    /* ============ ADMIN: dashboard page ============ */
    if (p === '/admin' || p === '/admin/') {
      const authed = await checkSession(req, env);
      return new Response(authed ? DASHBOARD_HTML : LOGIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    /* ============ everything else: the static site ============ */
    return env.ASSETS.fetch(req);
  }
};

/* ================= inline admin UI (kept out of the public static site) ================= */
const BASE_CSS = `
*{box-sizing:border-box;margin:0}
body{font-family:Nunito,system-ui,sans-serif;background:#f7f5ee;color:#26312a;padding:0}
h1,h2,h3{font-family:Fraunces,Georgia,serif;color:#1e3a2a}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px}
.btn{display:inline-block;background:#2f7d4f;color:#fff;border:0;border-radius:999px;padding:10px 22px;font-weight:700;font-size:15px;cursor:pointer;font-family:inherit}
.btn.warm{background:#ef6a34}
.btn:disabled{opacity:.6}
input,select,textarea{width:100%;padding:10px 12px;border:1.5px solid #dcd8c8;border-radius:10px;font-family:inherit;font-size:15px;background:#fff}
label{font-weight:700;font-size:13.5px;display:block;margin:12px 0 4px}
.card{background:#fff;border-radius:18px;box-shadow:0 8px 30px rgba(30,58,42,.08);padding:26px}
`;

const LOGIN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Applications — Free Food Stockpile</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Nunito:wght@400;700;800&display=swap" rel="stylesheet">
<style>${BASE_CSS}
.login{max-width:380px;margin:12vh auto}
</style></head><body>
<div class="login card">
  <h1 style="font-size:26px;margin-bottom:6px">Applications</h1>
  <p style="color:#5d6b60;font-size:14.5px">Free Food Stockpile — team sign in</p>
  <label for="pw">Password</label>
  <input id="pw" type="password" autocomplete="current-password">
  <p id="err" style="color:#c0392b;font-size:13.5px;display:none;margin-top:8px">Wrong password — try again.</p>
  <button class="btn" id="go" style="margin-top:16px;width:100%">Sign in</button>
</div>
<script>
const go=document.getElementById('go'),pw=document.getElementById('pw');
async function login(){
  go.disabled=true;
  const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value.trim()})});
  if(r.ok){location.reload();return}
  document.getElementById('err').style.display='block';go.disabled=false;pw.select();
}
go.addEventListener('click',login);
pw.addEventListener('keydown',e=>{if(e.key==='Enter')login()});
pw.focus();
</script></body></html>`;

const DASHBOARD_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Applications — Free Food Stockpile</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>${BASE_CSS}
.stats{display:flex;gap:14px;margin:18px 0}
.stat{background:#fff;border-radius:14px;padding:14px 22px;box-shadow:0 4px 16px rgba(30,58,42,.07)}
.stat b{font-size:24px;display:block;color:#2f7d4f}
.stat span{font-size:13px;color:#5d6b60}
#search{margin:6px 0 16px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(30,58,42,.07)}
th{background:#eef2e8;text-align:left;padding:11px 12px;font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;color:#44543f}
td{padding:11px 12px;border-top:1px solid #f0ede1;font-size:14.5px;vertical-align:middle}
tr.row{cursor:pointer}
tr.row:hover{background:#fbfaf2}
td select{width:auto;padding:6px 10px;font-size:13.5px}
.s-New{background:#fff8e6}.s-In.Review{background:#eef4ff}
.badge-card{font-size:12px;background:#eef2e8;border-radius:999px;padding:3px 10px}
#detail{position:fixed;inset:0;background:rgba(20,30,22,.45);display:none;align-items:flex-start;justify-content:center;overflow:auto;padding:4vh 14px;z-index:50}
#detail .card{max-width:760px;width:100%;position:relative}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}
@media(max-width:640px){.grid2{grid-template-columns:1fr}}
.close{position:absolute;top:14px;right:16px;background:none;border:none;font-size:22px;cursor:pointer;color:#5d6b60}
.note{background:#fbfaf2;border-radius:10px;padding:10px 12px;margin-top:8px;font-size:14px}
.note small{color:#8a927f;display:block;margin-bottom:3px}
.savebar{display:flex;gap:10px;align-items:center;margin-top:18px}
#saved{color:#2f7d4f;font-weight:700;display:none}
</style></head><body>
<div class="wrap">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
    <div>
      <h1 style="font-size:30px">Applications</h1>
      <p style="color:#5d6b60">Every application in one place — click a row to view, edit, and add notes.</p>
    </div>
    <button class="btn" style="background:#5d6b60" id="openPw">Change password</button>
  </div>
  <div class="stats"><div class="stat"><b id="stTotal">–</b><span>Total applications</span></div><div class="stat"><b id="stNew">–</b><span>New / unreviewed</span></div></div>
  <input id="search" placeholder="Search name, phone, Medicaid CIN, city, region…">
  <table><thead><tr><th>Date</th><th>Applicant</th><th>Phone</th><th>Medicaid CIN</th><th>Region</th><th>Card</th><th>Status</th></tr></thead>
  <tbody id="rows"></tbody></table>
</div>

<div id="pwModal" style="position:fixed;inset:0;background:rgba(20,30,22,.45);display:none;align-items:flex-start;justify-content:center;overflow:auto;padding:8vh 14px;z-index:60">
  <div class="card" style="max-width:420px;width:100%;position:relative">
    <button class="close" onclick="closePw()">✕</button>
    <h2 style="font-size:22px;margin-bottom:4px">Change password</h2>
    <p style="color:#5d6b60;font-size:14px">Set a new password for signing in to this dashboard.</p>
    <label for="pwCur">Current password</label>
    <input id="pwCur" type="password" autocomplete="current-password">
    <label for="pwNew">New password</label>
    <input id="pwNew" type="password" autocomplete="new-password" placeholder="At least 8 characters">
    <label for="pwNew2">Confirm new password</label>
    <input id="pwNew2" type="password" autocomplete="new-password">
    <p id="pwMsg" style="font-size:13.5px;margin-top:10px;display:none"></p>
    <div class="savebar"><button class="btn" id="pwSave">Save new password</button></div>
  </div>
</div>

<div id="detail"><div class="card">
  <button class="close" onclick="closeDetail()">✕</button>
  <h2 id="dTitle" style="font-size:23px;margin-bottom:2px"></h2>
  <p id="dMeta" style="color:#8a927f;font-size:13px"></p>
  <div id="dFields" class="grid2"></div>
  <div class="savebar"><button class="btn" id="dSave">Save changes</button><span id="saved">Saved ✓</span><a id="dCard" class="badge-card" target="_blank" style="display:none;text-decoration:none">View Medicaid card ↗</a></div>
  <h3 style="margin-top:26px;font-size:18px">Notes</h3>
  <div style="display:flex;gap:10px;margin-top:8px"><input id="dNote" placeholder="Add a note — saved with today's date…"><button class="btn warm" id="dAddNote">Add</button></div>
  <div id="dNotes"></div>
</div></div>

<script>
const STATUSES=${JSON.stringify(STATUSES)};
const FIELDS=[
 ['first_name','First name'],['last_name','Last name'],['dob','Date of birth'],['ssn','Social Security Number'],
 ['medicaid_cin','Medicaid CIN'],['phone','Phone'],['email','Email'],['street','Street address'],
 ['city','City / Town'],['region','Region'],['state','State'],['zip','ZIP'],['language','Language'],
 ['household_total','Total in household'],['household_members','Household members'],
 ['chronic_condition','Chronic condition?'],['condition_details','Condition details'],['notes_applicant','Applicant note'],['consent','Consent']
];
let APPS=[],CUR=null;
function fmtDate(s){if(!s)return'';const d=new Date(s.replace(' ','T')+'Z');return isNaN(d)?s:d.toLocaleDateString('en-US',{month:'numeric',day:'numeric',year:'numeric'})}
async function load(q){
  const r=await fetch('/api/admin/applications'+(q?'?q='+encodeURIComponent(q):''));
  if(r.status===401){location.reload();return}
  const j=await r.json();APPS=j.applications||[];render();
}
function render(){
  document.getElementById('stTotal').textContent=APPS.length;
  document.getElementById('stNew').textContent=APPS.filter(a=>a.status==='New').length;
  const tb=document.getElementById('rows');tb.innerHTML='';
  APPS.forEach(a=>{
    const tr=document.createElement('tr');tr.className='row';
    tr.innerHTML='<td>'+fmtDate(a.created_at)+'</td><td><b>'+escp(a.first_name+' '+a.last_name)+'</b></td><td>'+escp(a.phone)+'</td><td>'+escp(a.medicaid_cin)+'</td><td>'+escp(a.region||a.city)+'</td><td>'+(a.card_key?'<span class="badge-card">📎 card</span>':'')+'</td><td></td>';
    const sel=document.createElement('select');
    STATUSES.forEach(s=>{const o=document.createElement('option');o.textContent=s;o.selected=s===a.status;sel.appendChild(o)});
    sel.addEventListener('click',e=>e.stopPropagation());
    sel.addEventListener('change',async()=>{await fetch('/api/admin/applications/'+a.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:sel.value})});a.status=sel.value;render()});
    tr.lastElementChild.appendChild(sel);
    tr.addEventListener('click',()=>openDetail(a.id));
    tb.appendChild(tr);
  });
}
function escp(s){const d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML}
async function openDetail(id){
  const r=await fetch('/api/admin/applications/'+id);const j=await r.json();
  if(!j.success)return;
  CUR=j.application;
  document.getElementById('dTitle').textContent=(CUR.first_name+' '+CUR.last_name).trim()||('Application #'+id);
  document.getElementById('dMeta').textContent='Applied '+fmtDate(CUR.created_at)+' · last updated '+fmtDate(CUR.updated_at)+' · #'+CUR.id;
  const wrap=document.getElementById('dFields');wrap.innerHTML='';
  const stL=document.createElement('div');stL.innerHTML='<label>Status</label>';
  const stSel=document.createElement('select');stSel.id='f_status';
  STATUSES.forEach(s=>{const o=document.createElement('option');o.textContent=s;o.selected=s===CUR.status;stSel.appendChild(o)});
  stL.appendChild(stSel);wrap.appendChild(stL);wrap.appendChild(document.createElement('div'));
  FIELDS.forEach(([k,label])=>{
    const d=document.createElement('div');
    if(k==='household_members'){d.style.gridColumn='1/-1';d.innerHTML='<label>'+label+'</label><textarea id="f_'+k+'" rows="3"></textarea>';}
    else d.innerHTML='<label>'+label+'</label><input id="f_'+k+'">';
    wrap.appendChild(d);
    document.getElementById('f_'+k).value=CUR[k]||'';
  });
  const cardLink=document.getElementById('dCard');
  if(CUR.card_key){cardLink.style.display='inline-block';cardLink.href='/api/admin/applications/'+CUR.id+'/card';}
  else cardLink.style.display='none';
  renderNotes(j.notes||[]);
  document.getElementById('detail').style.display='flex';
}
function renderNotes(notes){
  const nd=document.getElementById('dNotes');nd.innerHTML='';
  notes.forEach(n=>{const d=document.createElement('div');d.className='note';d.innerHTML='<small>'+new Date(n.created_at.replace(' ','T')+'Z').toLocaleString('en-US')+'</small>'+escp(n.note);nd.appendChild(d)});
}
document.getElementById('dSave').addEventListener('click',async()=>{
  const body={status:document.getElementById('f_status').value};
  FIELDS.forEach(([k])=>{body[k]=document.getElementById('f_'+k).value});
  const r=await fetch('/api/admin/applications/'+CUR.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(r.ok){const s=document.getElementById('saved');s.style.display='inline';setTimeout(()=>s.style.display='none',2000);load(document.getElementById('search').value)}
});
document.getElementById('dAddNote').addEventListener('click',async()=>{
  const inp=document.getElementById('dNote');if(!inp.value.trim())return;
  await fetch('/api/admin/applications/'+CUR.id+'/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({note:inp.value})});
  inp.value='';openDetail(CUR.id);
});
function closeDetail(){document.getElementById('detail').style.display='none'}
document.getElementById('detail').addEventListener('click',e=>{if(e.target.id==='detail')closeDetail()});
let t;document.getElementById('search').addEventListener('input',e=>{clearTimeout(t);t=setTimeout(()=>load(e.target.value),300)});

/* ---- change password ---- */
const pwModal=document.getElementById('pwModal');
function openPw(){['pwCur','pwNew','pwNew2'].forEach(id=>document.getElementById(id).value='');const m=document.getElementById('pwMsg');m.style.display='none';pwModal.style.display='flex';document.getElementById('pwCur').focus()}
function closePw(){pwModal.style.display='none'}
document.getElementById('openPw').addEventListener('click',openPw);
pwModal.addEventListener('click',e=>{if(e.target.id==='pwModal')closePw()});
document.getElementById('pwSave').addEventListener('click',async()=>{
  const cur=document.getElementById('pwCur').value,nw=document.getElementById('pwNew').value,nw2=document.getElementById('pwNew2').value;
  const m=document.getElementById('pwMsg');m.style.display='block';
  if(nw.length<8){m.style.color='#c0392b';m.textContent='New password must be at least 8 characters.';return}
  if(nw!==nw2){m.style.color='#c0392b';m.textContent='The two new-password boxes do not match.';return}
  const btn=document.getElementById('pwSave');btn.disabled=true;
  const r=await fetch('/api/admin/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current:cur,next:nw})});
  const j=await r.json().catch(()=>({}));
  btn.disabled=false;
  if(r.ok&&j.success){m.style.color='#2f7d4f';m.textContent='Password changed ✓';setTimeout(closePw,1200)}
  else{m.style.color='#c0392b';m.textContent=j.error||'Could not change the password.'}
});
load();
</script></body></html>`;

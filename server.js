/* Hydro-Alert server - zero dependencies, needs Node.js 18+.  Run: node server.js */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const PUB = path.join(__dirname, 'public');
const LEVELS = ['Elementary', 'Junior High', 'Senior High', 'College'];
const SELF_ROLES = ['Student', 'Parent/Guardian', 'Teacher'];
const ADMIN = 'School Administrator';
const LBL = { green: 'Normal', orange: 'Orange - Warning', red: 'Red - Critical Warning' };

// ---------- passwords ----------
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const check = (pw, h) => { const [s, x] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(x), Buffer.from(crypto.scryptSync(pw, s, 32).toString('hex'))); };

// ---------- database (JSON file) ----------
let db;
function save() { fs.mkdirSync(path.dirname(DB_FILE), { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1)); }
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { db = null; }
if (!db) {
  db = { users: [], anns: [], notifs: [], hist: [], seq: 1, settings: { place: process.env.PLACE || 'Manila', lat: +process.env.LAT || 14.5995, lon: +process.env.LON || 120.9842 } };
  const seed = (email, name, role, org, level, section, pw) => db.users.push({ id: db.seq++, email, name, role, org, level, section, pw: hash(pw), lastRead: 0 });
  seed('admin@hydroalert.ph', 'Maria Santos', ADMIN, 'Central College', 'All', '', 'admin123');
  seed('teacher@hydroalert.ph', 'Ana Lopez', 'Teacher', 'Central College', 'College', 'BSIT 1-E', 'teacher123');
  seed('student@hydroalert.ph', 'Pedro Reyes', 'Student', 'Central College', 'College', 'BSIT 1-E', 'student123');
  seed('parent@hydroalert.ph', 'Rosa Reyes', 'Parent/Guardian', 'Parent of Pedro Reyes', 'College', 'BSIT 1-E', 'parent123');
  save();
  console.log('Created data/db.json with demo accounts (change these passwords before real use).');
}
const pub = u => { const { pw, ...r } = u; return r; };

// ---------- weather + alert engine ----------
const W = { rain: 0, temp: 0, hum: 0, wind: 0, level: 'green', source: 'offline', updated: Date.now() };
let sim = null;
const levelOf = r => r >= 30 ? 'red' : r >= 15 ? 'orange' : 'green';   // mm/hr (PAGASA-style Orange/Red)
const wx = () => ({ ...W, place: db.settings.place });
const clients = new Set();
function broadcast(ev, data) { for (const c of clients) c.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); }
function addNotif(type, level, text) {
  const n = { id: db.seq++, time: Date.now(), type, level, text };
  db.notifs = [n, ...db.notifs].slice(0, 200); save(); return n;
}
// Delivery hook: logs, and POSTs to WEBHOOK_URL if set (connect an SMS/email service there).
async function deliver(text) {
  console.log('[ALERT]', text, `-> ${db.users.length} users`);
  if (process.env.WEBHOOK_URL) { try { await fetch(process.env.WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, users: db.users.map(u => ({ name: u.name, email: u.email })) }) }); } catch (e) { console.log('webhook failed'); } }
}
function applyWeather() {
  if (sim !== null) { W.rain = sim; W.source = 'simulated'; }
  W.updated = Date.now();
  const nl = levelOf(W.rain);
  if (nl !== W.level) {
    const prev = W.level; W.level = nl;
    const text = nl === 'green' ? 'Rainfall is back to normal levels.' : `${LBL[nl]}: rainfall at ${W.rain.toFixed(1)} mm/hr in ${db.settings.place}. Prepare for possible class suspension.`;
    const n = addNotif('alert', nl, text);
    db.hist = [{ id: db.seq++, time: Date.now(), type: 'alert', level: nl, rain: +W.rain.toFixed(1), note: `Changed from ${prev} to ${nl}` }, ...db.hist].slice(0, 500); save();
    broadcast('alert', { id: n.id, level: nl, text }); deliver(text);
  }
  broadcast('weather', wx());
}
async function fetchWeather() {
  if (sim !== null) return applyWeather();
  try {
    const { lat, lon } = db.settings;
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation&timezone=auto`);
    const c = (await r.json()).current;
    W.temp = c.temperature_2m; W.hum = c.relative_humidity_2m; W.wind = c.wind_speed_10m; W.rain = c.precipitation; W.source = 'live';
  } catch (e) { W.source = 'offline'; }
  applyWeather();
}
fetchWeather(); setInterval(fetchWeather, 5 * 60 * 1000);
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);

// ---------- helpers ----------
const sessions = new Map(), tries = new Map();
const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const cookie = req => ((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(p => p[0] === 'sid') || [])[1];
const userOf = req => db.users.find(u => u.id === sessions.get(cookie(req)));
const body = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) { req.destroy(); no(); } }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { ok({}); } }); });
const str = (v, n = 120) => String(v ?? '').trim().slice(0, n);
function login(res, u) { const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, u.id); send(res, 200, { user: pub(u) }, { 'Set-Cookie': `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800` }); }

// ---------- API ----------
async function api(req, res, r) {
  const m = req.method;
  if ((m === 'POST' || m === 'PUT') && !(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'JSON required' });
  if (m === 'POST' && r === 'login') {
    const ip = req.socket.remoteAddress, t = tries.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - t.t > 60000) { t.n = 0; t.t = Date.now(); }
    if (++t.n > 10) return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
    tries.set(ip, t);
    const b = await body(req), u = db.users.find(x => x.email === str(b.email).toLowerCase());
    if (!u || !check(str(b.password, 200), u.pw)) return send(res, 401, { error: 'Invalid email or password.' });
    return login(res, u);
  }
  if (m === 'POST' && r === 'register') {
    const b = await body(req), email = str(b.email).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'Enter a valid email.' });
    if (str(b.password, 200).length < 6) return send(res, 400, { error: 'Password must be at least 6 characters.' });
    if (!str(b.name)) return send(res, 400, { error: 'Name is required.' });
    if (!SELF_ROLES.includes(b.role)) return send(res, 400, { error: 'Invalid role.' });
    if (!LEVELS.includes(b.level)) return send(res, 400, { error: 'Choose an education level.' });
    if (db.users.some(x => x.email === email)) return send(res, 409, { error: 'That email is already registered.' });
    const u = { id: db.seq++, email, name: str(b.name), role: b.role, org: str(b.org), level: b.level, section: str(b.section, 40), pw: hash(str(b.password, 200)), lastRead: Date.now() };
    db.users.push(u); save(); return login(res, u);
  }
  const u = userOf(req);
  if (!u) return send(res, 401, { error: 'Please log in.' });
  const admin = u.role === ADMIN;
  if (m === 'POST' && r === 'logout') { sessions.delete(cookie(req)); return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' }); }
  if (m === 'GET' && r === 'me') return send(res, 200, { user: pub(u) });
  if (m === 'PUT' && r === 'me') {
    const b = await body(req);
    if (!str(b.name)) return send(res, 400, { error: 'Name is required.' });
    u.name = str(b.name); u.org = str(b.org);
    if (!admin && LEVELS.includes(b.level)) u.level = b.level;
    u.section = str(b.section, 40);
    if (b.password) { if (String(b.password).length < 6) return send(res, 400, { error: 'Password must be at least 6 characters.' }); u.pw = hash(String(b.password)); }
    save(); return send(res, 200, { user: pub(u) });
  }
  if (m === 'GET' && r === 'state') return send(res, 200, { weather: wx() });
  if (m === 'GET' && r === 'stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (m === 'GET' && r === 'notifications') return send(res, 200, { items: db.notifs.slice(0, 100), lastRead: u.lastRead });
  if (m === 'POST' && r === 'notifications/read') { u.lastRead = Date.now(); save(); return send(res, 200, { lastRead: u.lastRead }); }
  if (m === 'GET' && r === 'history') return send(res, 200, { items: db.hist.slice(0, 200) });
  if (m === 'GET' && r === 'announcements') return send(res, 200, { items: db.anns.slice(0, 100) });
  if (m === 'POST' && r === 'announcements') {
    if (!admin) return send(res, 403, { error: 'Only the School Administrator can announce suspensions.' });
    const b = await body(req), levels = (Array.isArray(b.levels) ? b.levels : []).filter(l => l === 'All' || LEVELS.includes(l));
    if (!str(b.title) || !str(b.reason, 300) || !levels.length) return send(res, 400, { error: 'Add a title, a reason, and at least one affected level.' });
    db.anns.forEach(a => a.active = false);
    const a = { id: db.seq++, time: Date.now(), active: true, title: str(b.title), reason: str(b.reason, 300), levels, details: str(b.details, 200), by: `${u.name}, ${u.role}` };
    db.anns.unshift(a);
    const scope = (levels.includes('All') ? 'All levels' : levels.join(', ')) + (a.details ? ' - ' + a.details : '');
    const text = `OFFICIAL: ${a.title}. Affected: ${scope}. Reason: ${a.reason}`;
    addNotif('suspension', '', text);
    db.hist = [{ id: db.seq++, time: Date.now(), type: 'announcement', level: W.level, rain: +W.rain.toFixed(1), note: `${a.title} (${u.role})` }, ...db.hist].slice(0, 500); save();
    broadcast('announcement', { id: a.id, text, title: a.title }); deliver(text);
    return send(res, 200, { item: a });
  }
  if (m === 'POST' && r === 'announcements/lift') {
    if (!admin) return send(res, 403, { error: 'Admins only.' });
    db.anns.forEach(a => a.active = false);
    const text = 'OFFICIAL: Suspension has been lifted. Classes resume as scheduled.';
    addNotif('suspension', '', text);
    db.hist = [{ id: db.seq++, time: Date.now(), type: 'announcement', level: W.level, rain: +W.rain.toFixed(1), note: 'Suspension lifted' }, ...db.hist].slice(0, 500); save();
    broadcast('announcement', { text, title: 'Suspension lifted' }); deliver(text);
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && r === 'simulate') {                      // admin: test the system with a fake rainfall value
    if (!admin) return send(res, 403, { error: 'Admins only.' });
    const b = await body(req); sim = (b.rain === null || b.rain === undefined) ? null : Math.max(0, Math.min(100, +b.rain || 0));
    await fetchWeather(); return send(res, 200, { weather: wx() });
  }
  if (m === 'POST' && r === 'settings') {                      // admin: set the monitored location
    if (!admin) return send(res, 403, { error: 'Admins only.' });
    const b = await body(req), lat = +b.lat, lon = +b.lon;
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) || !str(b.place)) return send(res, 400, { error: 'Enter a place name and valid coordinates.' });
    db.settings = { place: str(b.place, 60), lat, lon }; save(); await fetchWeather(); return send(res, 200, { weather: wx() });
  }
  send(res, 404, { error: 'Not found' });
}

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serve(res, p) {
  const f = path.normalize(path.join(PUB, p === '/' ? 'index.html' : p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(d); });
}
http.createServer(async (req, res) => {
  try { const p = new URL(req.url, 'http://x').pathname; if (p.startsWith('/api/')) await api(req, res, p.slice(5)); else serve(res, p); }
  catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: 'Server error' }); }
}).listen(PORT, () => console.log(`Hydro-Alert running at http://localhost:${PORT}`));

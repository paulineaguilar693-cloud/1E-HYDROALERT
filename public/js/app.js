/* Hydro-Alert client: talks to the Node server (REST + live Server-Sent Events). */
(() => {
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = t => new Date(t).toLocaleString();
const LEVELS = ['Elementary', 'Junior High', 'Senior High', 'College'];
const LBL = { green: 'Normal', orange: 'Orange - Warning', red: 'Red - Critical Warning' };
const COL = { green: 'var(--g)', orange: 'var(--o)', red: 'var(--r)' };
const PAGES = { dashboard: 'Dashboard', alerts: 'Alert Center', notifications: 'Notifications', announcements: 'Announcements', history: 'History', profile: 'Profile' };
let me = null, W = { rain: 0, level: 'green', source: 'offline' }, anns = [], notifs = [], lastRead = 0, es = null, reg = false, sound = true;
try { sound = localStorage.getItem('ha_sound') !== '0'; } catch (e) {}

async function api(p, m = 'GET', b) {
  const r = await fetch('/api/' + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Error ' + r.status);
  return j;
}
const route = () => { const r = location.hash.slice(1); return PAGES[r] ? r : 'dashboard'; };
const isAdmin = () => me && me.role === 'School Administrator';
const active = () => anns.find(a => a.active);
const affects = a => !a.levels || a.levels.includes('All') || me.level === 'All' || a.levels.includes(me.level);
const unread = () => notifs.filter(n => n.time > lastRead).length;

// ----- alarm: siren + voice + full-screen warning + browser notification -----
let ac, osc, sirT;
function siren(on, level) {
  try {
    clearInterval(sirT); if (osc) { osc.stop(); osc = null; }
    if (!on || !sound) return;
    ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume();
    osc = ac.createOscillator(); const g = ac.createGain(); g.gain.value = .3; osc.type = 'square'; osc.connect(g); g.connect(ac.destination); osc.start();
    let hi = false; sirT = setInterval(() => { hi = !hi; osc.frequency.value = hi ? 950 : 600; }, level === 'red' ? 300 : 650);
  } catch (e) {}
}
const speak = t => { try { if (sound) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(t)); } } catch (e) {} };
const pushNote = (t, b) => { try { if (Notification.permission === 'granted') new Notification(t, { body: b }); } catch (e) {} };
function stopAlarm() { siren(false); try { speechSynthesis.cancel(); } catch (e) {} $('ov').style.display = 'none'; }
function overlay(level, msg) {
  const o = $('ov'); o.className = level; o.style.display = 'flex';
  o.innerHTML = `<div style="font-size:70px">${level === 'red' ? '🚨' : '⚠️'}</div><h1>${level === 'red' ? 'RED ALERT' : 'ORANGE ALERT'}</h1><p>${esc(msg)}</p><button id="ack">I Understand</button>`;
  $('ack').onclick = stopAlarm; siren(true, level); speak(msg); pushNote('Hydro-Alert ' + level.toUpperCase(), msg);
}

// ----- live connection -----
async function loadAll() {
  const [s, a, n] = await Promise.all([api('state'), api('announcements'), api('notifications')]);
  W = s.weather; anns = a.items; notifs = n.items; lastRead = n.lastRead;
}
function connect() {
  if (es) es.close();
  es = new EventSource('/api/stream');
  es.addEventListener('weather', e => { W = JSON.parse(e.data); paint(); });
  es.addEventListener('alert', async e => {
    const d = JSON.parse(e.data); await loadAll(); if (d.level === 'green') stopAlarm(); else overlay(d.level, d.text); softRender();
  });
  es.addEventListener('announcement', async e => {
    const d = JSON.parse(e.data); await loadAll(); speak(d.text); pushNote('Hydro-Alert: ' + d.title, d.text); softRender();
  });
}
const typing = () => { const a = document.activeElement; return a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.type !== 'range'; };
const softRender = () => { if (!typing()) render(); else { nav(); } };

// ----- views -----
const level = () => `<span class="pill ${W.level}">${LBL[W.level]}</span>`;
function nav() {
  const n = unread(), cur = route(); $('nav').hidden = false;
  $('nav').innerHTML = '<b>💧 Hydro-Alert</b>' + Object.keys(PAGES).map(k => `<a href="#${k}" class="${k === cur ? 'on' : ''}">${PAGES[k]}${k === 'notifications' && n ? `<span class="badge">${n}</span>` : ''}</a>`).join('') + '<a href="#" id="lo" style="margin-left:auto">Logout</a>';
  $('lo').onclick = async e => { e.preventDefault(); stopAlarm(); try { await api('logout', 'POST'); } catch (x) {} if (es) es.close(); me = null; render(); };
}
const nItem = n => `<div class="item ${n.level || n.type} ${n.time > lastRead ? 'unread' : ''}">${esc(n.text)}<div class="mu">${esc(n.type.toUpperCase())} · ${fmt(n.time)}</div></div>`;
const scope = a => (a.levels.includes('All') ? 'All levels' : a.levels.join(', ')) + (a.details ? ' - ' + a.details : '');

function authView() {
  const f = reg ? `<label>Full name</label><input id="rn"><label>I am a</label><select id="rr"><option>Student</option><option>Parent/Guardian</option><option>Teacher</option></select>
    <label>Education level (for a parent: your child's level)</label><select id="rl">${LEVELS.map(l => `<option>${l}</option>`).join('')}</select>
    <label>Section / grade (optional)</label><input id="rs" placeholder="e.g. BSIT 1-E"><label>School / organization</label><input id="ro">` : '';
  return `<div class="login"><h1 class="brand">💧 Hydro-Alert</h1><p class="mu">Centralized Class Suspension Announcements &amp; Weather Alerts</p>
  <div class="card"><label>Email</label><input id="em" type="email" autocomplete="username" placeholder="student@hydroalert.ph">${f}
  <label>Password</label><input id="pw" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}"><div class="err" id="err"></div>
  <button id="go" style="width:100%">${reg ? 'Create account' : 'Login'}</button>
  <p class="mu" style="text-align:center;margin:8px 0 0"><a href="#" id="sw">${reg ? 'I already have an account' : 'Create an account'}</a></p></div>
  ${reg ? '' : '<p class="mu">Demo accounts:<br>admin@hydroalert.ph / admin123 (School Administrator)<br>teacher@hydroalert.ph / teacher123<br>student@hydroalert.ph / student123<br>parent@hydroalert.ph / parent123</p>'}
  <div class="card" style="text-align:left;margin-top:12px"><h3>Why Hydro-Alert?</h3><p class="mu" style="margin:0">Students and parents often rely on Facebook, group chats and word of mouth to learn if classes are suspended in bad weather, so announcements can be delayed or unclear. Hydro-Alert puts live rainfall alerts and official suspension notices in one place.</p></div></div>`;
}
function bindAuth() {
  $('sw').onclick = e => { e.preventDefault(); reg = !reg; render(); };
  const go = async () => {
    try {
      try { new (window.AudioContext || window.webkitAudioContext)().resume(); } catch (e) {}
      const b = { email: $('em').value, password: $('pw').value };
      if (reg) Object.assign(b, { name: $('rn').value, role: $('rr').value, level: $('rl').value, section: $('rs').value, org: $('ro').value });
      me = (await api(reg ? 'register' : 'login', 'POST', b)).user;
      await loadAll(); connect(); location.hash = '#dashboard'; render();
      if (W.level !== 'green') overlay(W.level, `${LBL[W.level]} is active. Rainfall ${(+W.rain).toFixed(1)} mm/hr.`);
    } catch (e) { $('err').textContent = e.message; }
  };
  $('go').onclick = go; $('pw').onkeydown = e => { if (e.key === 'Enter') go(); };
}
function dashView() {
  return `<h2>Dashboard</h2><p class="mu">Welcome, ${esc(me.name)} (${esc(me.role)}${me.level !== 'All' ? ' · ' + esc(me.level) + (me.section ? ' ' + esc(me.section) : '') : ''})</p>
  <div class="grid"><div class="card"><h3>Current Weather</h3><div class="big" id="temp"></div><div class="mu">Humidity <b id="hum"></b> · Wind <b id="wind"></b></div></div>
  <div class="card"><h3>Rainfall Level</h3><div class="big" id="rainV"></div><div class="meter"><i id="meter"></i></div></div>
  <div class="card"><h3>Current Alert Status</h3><span id="lvl"></span></div>
  <div class="card"><h3>Class Suspension Status (for you)</h3><div id="susp"></div></div></div>
  <p class="mu" id="src"></p><h3 style="margin-top:16px">Recent Notifications</h3>${notifs.slice(0, 4).map(nItem).join('') || '<p class="mu">No notifications yet.</p>'}`;
}
function alertsView() {
  const card = (k, t, d) => `<div class="card" style="border-color:${W.level === k ? COL[k] : 'var(--bd)'}"><span class="pill ${k}">${t}</span><p class="mu">${d}</p>${W.level === k ? '<b>● Current status</b>' : ''}</div>`;
  const adm = isAdmin() ? `<div class="card" style="margin-top:12px"><h3>Admin: Test the system</h3><label>Simulated rainfall: <b id="simV">${(+W.rain).toFixed(1)}</b> mm/hr</label>
    <input type="range" id="sim" min="0" max="60" step="0.5" value="${W.rain}"><button id="simGo">Apply simulation</button><button class="sec" id="simOff">Use live weather</button></div>
    <div class="card" style="margin-top:12px"><h3>Admin: Monitored location</h3><label>Place</label><input id="pl" value="${esc(W.place || '')}"><label>Latitude</label><input id="la"><label>Longitude</label><input id="lo2">
    <div class="err" id="serr"></div><button id="locGo">Save location</button></div>` : '';
  return `<h2>Alert Center</h2><div class="grid">${card('green', 'Green: Normal', 'Below 15 mm/hr.')}${card('orange', 'Orange: Warning', '15-29.9 mm/hr. Heavy rain.')}${card('red', 'Red: Critical Warning', '30 mm/hr or more. Torrential rain.')}</div>
  <div class="card"><h3>Alarm Sound, Full-Screen Alert &amp; Notifications</h3><label><input type="checkbox" id="snd" ${sound ? 'checked' : ''}>Enable alarm sound and voice advisory</label><br>
  <button class="orange" id="t1">Test Orange</button><button class="red" id="t2">Test Red</button><button class="sec" id="t3">Stop Alarm</button><button class="sec" id="bn">Enable browser notifications</button></div>${adm}`;
}
const notifView = () => `<h2>Notifications</h2><button class="sec" id="mr">Mark all as read</button><div style="margin-top:10px">${notifs.map(nItem).join('') || '<p class="mu">No notifications yet.</p>'}</div>`;
function annView() {
  const form = isAdmin() ? `<div class="card" style="margin-bottom:14px"><h3>Approve &amp; Announce Suspension</h3>
    <label>Announcement title</label><input id="at" value="${W.level === 'green' ? '' : 'Class suspension due to ' + (W.level === 'red' ? 'critical' : 'heavy') + ' rainfall'}">
    <label>Affected levels</label><div id="lv" style="margin:4px 0 10px"><label><input type="checkbox" value="All"> All levels</label>&nbsp;${LEVELS.map(l => `<label><input type="checkbox" value="${l}"> ${l}</label>&nbsp;`).join('')}</div>
    <label>Affected sections / details (optional)</label><input id="ad"><label>Reason</label><textarea id="ar" rows="2">${W.level === 'green' ? '' : esc(LBL[W.level] + ' - rainfall at ' + (+W.rain).toFixed(1) + ' mm/hr')}</textarea>
    <div class="err" id="aerr"></div><button id="ap">✔ Approve &amp; Announce</button>${active() ? '<button class="sec" id="lift">Lift Active Suspension</button>' : ''}</div>`
    : '<p class="mu">Only the School Administrator can issue official announcements. Everyone sees the same notice here.</p>';
  return `<h2>Suspension Announcements</h2>${form}` + (anns.map(a => `<div class="item suspension"><b>${esc(a.title)}</b> ${a.active ? '<span class="pill blue">ACTIVE</span>' : '<span class="pill" style="background:var(--mu)">LIFTED</span>'}${a.active && !affects(a) ? ' <span class="mu">(not for your level)</span>' : ''}<div>Affected: ${esc(scope(a))}</div><div>Reason: ${esc(a.reason)}</div><div class="mu">${fmt(a.time)} · Official: ${esc(a.by)}</div></div>`).join('') || '<p class="mu">No announcements yet.</p>');
}
const histView = () => `<h2>Alert History</h2><select id="hf" style="max-width:220px"><option value="all">All records</option><option value="green">Green</option><option value="orange">Orange</option><option value="red">Red</option><option value="announcement">Announcements</option></select>
  <div class="table card"><table><thead><tr><th>Date &amp; Time</th><th>Type</th><th>Level</th><th>Rain (mm/hr)</th><th>Details</th></tr></thead><tbody id="rows"></tbody></table></div>`;
const profView = () => `<h2>User Profile</h2><div class="card" style="max-width:420px"><label>Full name</label><input id="pn" value="${esc(me.name)}"><label>Email</label><input value="${esc(me.email)}" disabled><label>Role</label><input value="${esc(me.role)}" disabled>
  <label>School / organization</label><input id="po" value="${esc(me.org)}"><label>Education level</label><select id="pl" ${isAdmin() ? 'disabled' : ''}>${['All', ...LEVELS].filter(l => isAdmin() || l !== 'All').map(l => `<option ${l === me.level ? 'selected' : ''}>${l}</option>`).join('')}</select>
  <label>Section / grade</label><input id="ps2" value="${esc(me.section)}"><label>New password (optional)</label><input id="pp" type="password"><div class="err" id="perr"></div><button id="ps">Save changes</button></div>`;

function paint() {
  const set = (i, v) => { const e = $(i); if (e) e.innerHTML = v; };
  set('rainV', (+W.rain).toFixed(1) + ' <small>mm/hr</small>'); set('temp', W.source === 'offline' && !W.temp ? '--' : (+W.temp).toFixed(1) + '°C');
  set('hum', Math.round(W.hum || 0) + '%'); set('wind', Math.round(W.wind || 0) + ' km/h'); set('lvl', level());
  const m = $('meter'); if (m) { m.style.width = Math.min(100, W.rain / 60 * 100) + '%'; m.style.background = COL[W.level]; }
  const s = active();
  set('susp', s ? (affects(s) ? '<span class="pill red">CLASSES SUSPENDED</span>' : '<span class="pill green">Not affected</span>') + `<div class="mu" style="margin-top:6px"><b>${esc(s.title)}</b><br>${esc(scope(s))}<br>${esc(s.by)}</div>` : '<span class="pill green">Classes as scheduled</span>');
  const src = { live: 'Live data from Open-Meteo', simulated: 'SIMULATED rainfall (admin test mode)', offline: 'Weather service unreachable' }[W.source];
  set('src', `${esc(W.place || '')} · ${src} · updated ${new Date(W.updated).toLocaleTimeString()}`);
}
async function render() {
  if (!me) { $('nav').hidden = true; $('app').innerHTML = authView(); return bindAuth(); }
  nav(); const r = route();
  $('app').innerHTML = { dashboard: dashView, alerts: alertsView, notifications: notifView, announcements: annView, history: histView, profile: profView }[r]();
  paint(); bind(r);
}
function bind(r) {
  if (r === 'alerts') {
    $('snd').onchange = e => { sound = e.target.checked; try { localStorage.setItem('ha_sound', sound ? '1' : '0'); } catch (x) {} if (!sound) siren(false); };
    $('t1').onclick = () => overlay('orange', 'TEST: Orange Alert. Heavy rainfall warning.');
    $('t2').onclick = () => overlay('red', 'TEST: Red Alert. Critical rainfall. Stay indoors.');
    $('t3').onclick = stopAlarm;
    $('bn').onclick = () => { try { Notification.requestPermission().then(p => alert('Browser notifications: ' + p)); } catch (e) { alert('Not supported in this browser.'); } };
    if (isAdmin()) {
      const sl = $('sim'); sl.oninput = () => { $('simV').textContent = (+sl.value).toFixed(1); };
      $('simGo').onclick = () => api('simulate', 'POST', { rain: +sl.value });
      $('simOff').onclick = () => api('simulate', 'POST', { rain: null });
      $('locGo').onclick = async () => { try { await api('settings', 'POST', { place: $('pl').value, lat: $('la').value, lon: $('lo2').value }); $('serr').style.color = 'var(--g)'; $('serr').textContent = 'Location saved. Fetching live weather...'; } catch (e) { $('serr').style.color = 'var(--r)'; $('serr').textContent = e.message; } };
    }
  }
  if (r === 'notifications') {
    const mark = async () => { lastRead = (await api('notifications/read', 'POST')).lastRead; nav(); };
    $('mr').onclick = async () => { await mark(); render(); }; setTimeout(mark, 1500);
  }
  if (r === 'announcements' && isAdmin()) {
    $('ap').onclick = async () => {
      const levels = [...document.querySelectorAll('#lv input')].filter(b => b.checked).map(b => b.value);
      try { await api('announcements', 'POST', { title: $('at').value, reason: $('ar').value, details: $('ad').value, levels }); await loadAll(); render(); } catch (e) { $('aerr').textContent = e.message; }
    };
    const l = $('lift'); if (l) l.onclick = async () => { await api('announcements/lift', 'POST'); await loadAll(); render(); };
  }
  if (r === 'history') {
    api('history').then(({ items }) => {
      const draw = () => { const f = $('hf').value; const rows = items.filter(h => f === 'all' || h.level === f || h.type === f);
        $('rows').innerHTML = rows.map(h => `<tr><td>${fmt(h.time)}</td><td>${esc(h.type)}</td><td><span class="pill ${esc(h.level)}">${esc(h.level)}</span></td><td>${esc(h.rain)}</td><td>${esc(h.note)}</td></tr>`).join('') || '<tr><td colspan="5" class="mu">No records.</td></tr>'; };
      $('hf').onchange = draw; draw();
    });
  }
  if (r === 'profile') $('ps').onclick = async () => {
    try { me = (await api('me', 'PUT', { name: $('pn').value, org: $('po').value, level: $('pl').value, section: $('ps2').value, password: $('pp').value })).user;
      $('pp').value = ''; $('perr').style.color = 'var(--g)'; $('perr').textContent = 'Profile saved!'; nav(); }
    catch (e) { $('perr').style.color = 'var(--r)'; $('perr').textContent = e.message; }
  };
}
window.addEventListener('hashchange', () => { if (me) render(); });
document.addEventListener('click', () => { if (ac && ac.state === 'suspended') ac.resume(); });
(async () => { try { me = (await api('me')).user; await loadAll(); connect(); } catch (e) { me = null; } render(); })();
})();

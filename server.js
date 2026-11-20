// Lecture Room Control (MCSCMS): central server (HTTP API + WebSocket hub)
//
// Core rule: a faculty login belongs to ONE Lecture Room (LR) PC.
//  - Every LR is defined by a name and a unique Agent ID (made by the server, stored in the
//    installer). When the agent connects, the server learns the PC's address, so nobody types IPs.
//  - Faculty can sign in only from that LR PC (its address matches the connected agent).
//  - The session is bound to that LR and that IP. It can control that LR only.
//  - One faculty account can be signed in on one LR PC at a time, and one LR PC
//    serves one faculty login at a time. AV staff / admin can release a stuck login.
//
// Remote sharing: faculty can also sign in from their own phone or laptop (config allowRemoteFaculty).
//  - A remote login is not tied to an address. The faculty member PICKS one free, online LR.
//  - From then on every command, upload and slide goes to that one LR only (the server ignores any
//    room name sent by a faculty browser) and the LR's agent may download only the lecture opened on it.
'use strict';
const express = require('express'), http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const nodemailer = require('nodemailer');
const net = require('net');

/* ---------- storage ---------- */
const D = process.env.MCSCMS_DATA || path.join(__dirname, 'data');
fs.mkdirSync(path.join(D, 'lectures'), { recursive: true });
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')); } catch { return d; } };
const wr = (f, v) => { const p = path.join(D, f), t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, p); };
const audit = (u, m) => fs.appendFileSync(path.join(D, 'audit.log'), `${new Date().toISOString()} ${u} ${String(m).replace(/[\r\n]+/g, ' ')}\n`);

/* ---------- config ---------- */
const DEFAULTS = {
  idleMinutes: 120,            // end a presentation after this long without any command
  teacherIdleMinutes: 45,      // sign faculty out after this long idle (not while presenting)
  disconnectGraceMinutes: 3,   // keep a login this long after the browser closes (refresh / crash)
  staffIdleHours: 12,
  checkSeconds: 30,
  maxUploadMB: 2048,           // largest lecture file (videos are big)
  allowFacultyControl: true,   // a faculty member signed in from their own phone/laptop may use the mouse and keyboard of the room PC (Remote control). Admin/AV always can after Take control
  vncPort: 5900,               // TightVNC port on the room PCs (Full access uses VNC when it is installed on the PC)
  allowRemoteFaculty: true,    // faculty may sign in from a phone or personal laptop and pick a lecture room
  allowFacultyTransfer: true,  // faculty on their own phone/laptop may send files (slides, PDF, Word, Excel, images, media) to a folder on their room PC and open them there
  transferMaxMB: 500,          // largest file that can be sent to a room PC with File transfer
  transferFolders: ['Lectures', 'Handouts', 'Media', 'Other'],   // the only folders (inside the room PC's MCSCMS Files folder) that files can be sent to
  systemName: 'Lecture Room Control',   // shown on the sign-in screen, the side bar and the browser tab (Settings > Branding)
  agentPingSeconds: 15,        // server pings each agent; a PC that stops answering is shown Offline within ~2 pings
  mail: { host: '', port: 587, secure: false, insecureTls: false, user: '', pass: '', from: '', to: '' }, // AV help-request emails
};
const AGENT_VER = +(/^AGENT_VER = (\d+)/m.exec(fs.readFileSync(path.join(__dirname, 'agent', 'agent.py'), 'utf8')) || [])[1] || 0;   // the newest agent this server holds
try { JSON.parse(fs.readFileSync(path.join(D, 'config.json'), 'utf8')); } catch (e) {
  if (e.code !== 'ENOENT') { try { fs.copyFileSync(path.join(D, 'config.json'), path.join(D, 'config.json.bad')); } catch { } console.log('\nWARNING: data/config.json is not valid JSON (' + e.message + '). Defaults are used and your file was saved as config.json.bad. Fix the comma or quote mistake and start again.\n'); }
}
const CFG = { ...DEFAULTS, ...rd('config.json', {}) };
CFG.mail = { ...DEFAULTS.mail, ...(CFG.mail || {}) };
wr('config.json', CFG);
const XFOLDERS = (Array.isArray(CFG.transferFolders) ? CFG.transferFolders : DEFAULTS.transferFolders).map(String).filter(f => /^[A-Za-z0-9 _-]{1,30}$/.test(f) && f.trim() === f);
if (!XFOLDERS.length) XFOLDERS.push('Lectures');
const IDLE = CFG.idleMinutes * 60000, T_IDLE = CFG.teacherIdleMinutes * 60000, GRACE = CFG.disconnectGraceMinutes * 60000, S_IDLE = CFG.staffIdleHours * 3600000;

/* ---------- passwords (salted scrypt; old unsalted hashes are upgraded on next sign-in) ---------- */
const legacyHash = p => crypto.scryptSync(p, 'mcscms', 32).toString('hex');
const hashPw = p => { const salt = crypto.randomBytes(16).toString('hex'); return `scrypt$${salt}$${crypto.scryptSync(p, salt, 32).toString('hex')}`; };
const same = (a, b) => { a = Buffer.from(a); b = Buffer.from(b); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const checkPw = (u, p) => {
  if (u.pass.startsWith('scrypt$')) { const [, salt, hx] = u.pass.split('$'); return same(hx, crypto.scryptSync(p, salt, 32).toString('hex')); }
  return same(u.pass, legacyHash(p));
};
const MIN_PW = 8;

let users = rd('users.json', null);
if (!users) {
  // First run only. Every starter account must set a new password at first sign-in.
  users = [['admin', 'admin123', 'admin', 'Administrator'], ['av1', 'av123', 'av', 'AV Operator 1'], ['av2', 'av123', 'av', 'AV Operator 2'], ['teacher1', 'teach123', 'teacher', 'Dr. Ahmed']]
    .map(([user, p, role, name]) => ({ user, pass: hashPw(p), role, name, mustChange: true }));
  wr('users.json', users);
}
/* ---------- lecture file types ---------- */
// Any lecture file may be uploaded (slides, PDF, video, audio, images, documents ...) EXCEPT programs, scripts, shortcuts,
// macro-enabled Office files and web pages: the agent opens lectures on the lecture room PC, so these must never reach it.
const BLOCKED = new Set(('exe msi msp bat cmd com scr pif ps1 psm1 psd1 vbs vbe js jse wsf wsh hta jar lnk url reg dll sys cpl msc inf gadget application appx appxbundle msix msixbundle apk sh bash py pyw rb pl php ' +
  'docm xlsm pptm dotm xltm potm ppsm ppam xlam xll sldm iso img vhd vhdx dmg chm svg html htm xhtml mht mhtml swf xap crx scf settingcontent-ms library-ms diagcab').split(' ').map(x => '.' + x));
const EXT = { slides: '.ppt .pptx .pps .ppsx', pdf: '.pdf', video: '.mp4 .m4v .mkv .avi .mov .wmv .webm .mpg .mpeg .flv .3gp .ogv .mts .m2ts', audio: '.mp3 .wav .m4a .aac .ogg .oga .flac .wma .opus',
  image: '.jpg .jpeg .png .gif .bmp .webp .tif .tiff', doc: '.doc .docx .xls .xlsx .odt .ods .odp .rtf .txt .csv' };
const kindOf = f => { const e = path.extname(String(f)).toLowerCase(); for (const k in EXT) if (EXT[k].split(' ').includes(e)) return k; return 'other'; };
const MAX_UPLOAD = Math.max(1, +CFG.maxUploadMB || 2048) * 1048576;

let rooms = rd('rooms.json', []), lectures = rd('lectures.json', []), tickets = rd('help.json', []);
const saveHelp = () => wr('help.json', tickets);
// Agent ID: one unique, hard-to-guess ID per LR, e.g. AG-7F3K-9Q2M-XD41. It is what the installed agent presents.
const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newAgentId = () => 'AG-' + [0, 1, 2].map(() => Array.from(crypto.randomBytes(4), b => AL[b % 32]).join('')).join('-');
rooms.forEach(r => { if (!r.key) r.key = newAgentId(); if (r.ip === undefined) r.ip = ''; });
wr('rooms.json', rooms);

/* ---------- runtime state ---------- */
const live = {};            // roomId -> {online, seen, session, owner, assist, done, last, frame}
const agents = {};          // roomId -> agent WebSocket
const uis = new Set();      // browser WebSockets (ws.s = session)
const sessions = new Map(); // token -> session
const fails = new Map();    // ip -> {n, until} login throttle

const ipOf = sock => { const a = String(sock.remoteAddress || '').replace(/^::ffff:/, ''); return a === '::1' ? '127.0.0.1' : a; };
const lanIp = () => { for (const i of Object.values(os.networkInterfaces()).flat()) if (i && i.family === 'IPv4' && !i.internal) return i.address; return null; };
// Address that LR PCs must use to reach this server. If the dashboard was opened as localhost / 127.0.0.1, an
// installer built from that address would point the agent at ITS OWN PC and it would show Offline forever,
// so the server's LAN address is used instead. MCSCMS_PUBLIC_HOST (e.g. 192.168.10.2:3000) overrides it.
const hostOf = q => {
  if (process.env.MCSCMS_PUBLIC_HOST) return String(process.env.MCSCMS_PUBLIC_HOST).replace(/[^\w.:-]/g, '');
  const h = String(q.headers.host || '').replace(/[^\w.:-]/g, ''), m = h.match(/^(localhost|127(?:\.\d+){3}|::1)(:\d+)?$/i), lan = lanIp();
  return m && lan ? lan + (m[2] || '') : h;
};
/* ---------- slide pictures (full quality) ----------
// The agent asks PowerPoint to draw every slide and sends the pictures here. The teacher's own device shows them
// (instead of a compressed screen copy) and follows the room PC's current slide. They are kept per room and removed when the lecture ends. */
const decks = {};            // roomId -> { gen, total, have:Set(slide numbers) }
const MAX_SLIDE = 25 * 1048576;
const deckDir = id => path.join(D, 'slides', id);
const deckMsg = id => { const k = decks[id]; return { t: 'deck', room: id, gen: k ? k.gen : 0, total: k ? k.total : 0, have: k ? [...k.have] : [] }; };
const notifyDeck = id => uis.forEach(w => w.readyState === 1 && isTeacher(w.s) && w.s.room === id && send(w, deckMsg(id)));
function clearDeck(id, quiet) { const had = !!decks[id]; delete decks[id]; try { fs.rmSync(deckDir(id), { recursive: true, force: true }); } catch { } if (had && !quiet) notifyDeck(id); }
try { fs.rmSync(path.join(D, 'slides'), { recursive: true, force: true }); } catch { }   // nothing from an earlier run is kept
const warned = new Map();   // throttle for repeated agent warnings
const warnOnce = (k, m) => { const n = Date.now(); if ((warned.get(k) || 0) > n - 300000) return; warned.set(k, n); audit('system', m); };
const AL32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const vncPassOf = room => { if (CFG.vncPassword) return String(CFG.vncPassword); if (!room.vncPass) { room.vncPass = Array.from(crypto.randomBytes(8), b => AL32[b % 32]).join(''); wr('rooms.json', rooms); } return room.vncPass; };   // TightVNC uses the first 8 characters
// Passwords to try for a room's TightVNC, best first: the one that last worked, the one in config.json, the generated one.
// A failed sign-in moves to the next one on the next press of Full access, so one wrong setting can no longer break Full access for good.
const vncCands = room => { const out = []; for (const p of [room.vncGood, CFG.vncPassword, room.vncPass]) { const v = p ? String(p) : ''; if (v && !out.some(x => x.slice(0, 8) === v.slice(0, 8))) out.push(v); } if (!out.length) out.push(vncPassOf(room)); return out; };
const vncPick = room => { const c = vncCands(room), L = live[room.id] || {}; return c[(L.vncTry || 0) % c.length]; };
const vncPort = () => +CFG.vncPort > 0 && +CFG.vncPort < 65536 ? +CFG.vncPort : 5900;
const lanIps = () => process.env.MCSCMS_VNC_ALLOW ? String(process.env.MCSCMS_VNC_ALLOW).replace(/[^\d.,/]/g, '') : [...new Set(Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address))].join(',');
// Is the VNC service of this room's PC reachable from the server? (a plain connect, nothing is sent)
function probeVnc(id) {
  const room = rooms.find(x => x.id === id); if (!room || !room.ip || !agents[id]) return;
  const L = live[id] = live[id] || {}, sk = net.connect({ host: room.ip, port: vncPort() }); let done = false;
  const fin = ok => { if (done) return; done = true; sk.destroy(); if (!!L.vnc !== ok) { L.vnc = ok; push(); } };
  sk.setTimeout(1500, () => fin(false)); sk.on('connect', () => fin(true)); sk.on('error', () => fin(false));
}
const roomByIp = ip => rooms.find(r => r.ip === ip);
const isTeacher = s => s.u.role === 'teacher';
const sessionsOf = user => [...sessions.values()].filter(s => s.u.user === user);
const facultyAt = id => [...sessions.values()].find(s => s.room === id && isTeacher(s));
const presenting = s => !!(s.room && live[s.room] && live[s.room].session && live[s.room].owner && live[s.room].owner.user === s.u.user);
// A faculty login "holds" its LR while the browser is open, recently seen, or a lecture is running.
const holds = s => s.socks.size > 0 || Date.now() - s.last < GRACE || presenting(s);
const send = (w, o) => { if (w.readyState === 1) w.send(JSON.stringify(o)); };
// Short per-room timeline for the central monitor (newest last).
const evt = (roomId, who, text) => { if (!roomId) return; const L = live[roomId] = live[roomId] || {}; L.events = (L.events || []).concat({ t: Date.now(), who, text }).slice(-15); };

/* ---------- what each user may see ---------- */
const snapshot = withId => rooms.map(({ key, vncPass, vncGood, ...r }) => {
  const { frame, vncBad, vncTry, ...p } = live[r.id] || {};
  const f = facultyAt(r.id);
  return { ...r, ...(withId ? { agentId: key } : {}), online: false, ...p, ...(vncBad > Date.now() ? { vnc: false, vncAuthBad: true } : {}), assist: tickets.some(t => t.room === r.id && t.status === 'open'), faculty: f ? { user: f.u.user, name: f.u.name, remote: !!f.remote } : null };
});
const snapFor = s => isTeacher(s)
  ? snapshot().filter(r => r.id === s.room).map(({ ip, seen, last, faculty, events, ...r }) => r)
  : snapshot(true);
// A remote faculty login with no room yet sees a short list of rooms to pick from (no names, addresses or keys).
const taken = (id, s) => [...sessions.values()].some(x => x !== s && x.room === id && isTeacher(x) && x.u.user !== s.u.user && holds(x)) || !!(live[id] && live[id].owner && live[id].owner.user !== s.u.user);
const choicesFor = s => rooms.map(r => ({ id: r.id, floor: r.floor, online: !!agents[r.id], busy: taken(r.id, s) }));
const wantsChoices = s => isTeacher(s) && s.remote && !s.room;
const push = () => uis.forEach(w => send(w, { t: 'rooms', rooms: snapFor(w.s), ...(wantsChoices(w.s) ? { choices: choicesFor(w.s) } : {}) }));

/* ---------- sessions ---------- */
function newSession(u, ip, room, remote) {
  const s = { remote: !!remote, token: crypto.randomBytes(24).toString('hex'), sid: crypto.randomBytes(4).toString('hex'), u, ip, room: room || null, at: Date.now(), last: Date.now(), socks: new Set() };
  sessions.set(s.token, s);
  return s;
}
function closeSocks(s, why) { s.socks.forEach(w => { send(w, { t: 'bye', why }); try { w.close(); } catch { } uis.delete(w); }); s.socks.clear(); }
// Sign-out: ends the lecture this faculty member started and frees the LR PC.
function endSession(s, why) {
  if (!sessions.delete(s.token)) return;
  const L = s.room && live[s.room];
  if (L && L.owner && L.owner.user === s.u.user) {
    if (agents[s.room]) send(agents[s.room], { t: 'cmd', a: 'stop' });
    L.owner = null; L.session = null; L.done = true; L.lecture = null; L.serve = null; clearDeck(s.room);
  }
  closeSocks(s, why);
  audit(s.u.user, `signed out${s.room ? ' of ' + s.room : ''} (${why})`);
  evt(s.room, s.u.name, 'Signed out');
  push();
}
// Same person signing in again on the same LR PC: hand over without touching the running lecture.
function dropSession(s, why) { if (sessions.delete(s.token)) closeSocks(s, why); }

/* ---------- login throttle ---------- */
const throttled = ip => { const f = fails.get(ip); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; };
const fail = ip => { const f = fails.get(ip) || { n: 0, until: 0 }; f.n++; if (f.n >= 6) { f.until = Date.now() + 120000; f.n = 0; } fails.set(ip, f); };

/* ---------- HTTP ---------- */
const app = express();
app.disable('x-powered-by');
const TLS = !!(process.env.MCSCMS_TLS_KEY && process.env.MCSCMS_TLS_CERT);   // optional built-in HTTPS/WSS (or terminate TLS in a reverse proxy and set MCSCMS_PUBLIC_SCHEME=https)
const schemeOf = q => process.env.MCSCMS_PUBLIC_SCHEME === 'https' || TLS || (q && q.socket && q.socket.encrypted) ? 'https' : 'http';
app.use((q, r, n) => { if (TLS) r.setHeader('Strict-Transport-Security', 'max-age=31536000'); r.setHeader('X-Content-Type-Options', 'nosniff'); r.setHeader('X-Frame-Options', 'DENY'); r.setHeader('Referrer-Policy', 'no-referrer'); n(); });
app.use((q, r, n) => q.method === 'POST' && (q.path === '/api/lectures' || /^\/api\/rooms\/[^/]+\/transfer$/.test(q.path)) ? n() : express.json()(q, r, n));
app.use(express.static(path.join(__dirname, 'public')));

const auth = (roles, opt = {}) => (q, r, n) => {
  const s = sessions.get((q.headers.authorization || '').slice(7));
  if (!s || (isTeacher(s) && !s.remote && s.ip !== ipOf(q.socket))) return r.status(401).json({ error: 'Please sign in again.', code: 'auth' });
  if (roles && !roles.includes(s.u.role)) return r.status(403).json({ error: 'Not allowed' });
  if (s.u.mustChange && !opt.pw) return r.status(403).json({ error: 'Set a new password to continue.', code: 'must_change' });
  s.last = Date.now(); q.s = s; q.u = s.u; n();
};

const sessionInfo = s => ({ maxUploadMB: CFG.maxUploadMB || 2048, sid: s.sid, role: s.u.role, name: s.u.name, user: s.u.user, room: s.room, remote: !!s.remote, mustChange: !!s.u.mustChange, ctl: !isTeacher(s) || (!!s.remote && !!CFG.allowFacultyControl), xfer: !isTeacher(s) || !!CFG.allowFacultyTransfer, xfolders: XFOLDERS, xmaxMB: CFG.transferMaxMB || 500 });

// Which LR is this device? Shown on the sign-in page.
app.get('/api/lr', (q, r) => {
  const ip = ipOf(q.socket), room = roomByIp(ip);
  if (!room) return r.json({ ip, room: null, remote: !!CFG.allowRemoteFaculty });
  const f = facultyAt(room.id);
  r.json({ ip, room: room.id, floor: room.floor, online: !!agents[room.id], busy: !!(f && holds(f)) });
});

app.post('/api/login', (q, r) => {
  const ip = ipOf(q.socket), b = q.body || {}, name = String(b.user || '').trim().slice(0, 60);
  const wait = throttled(ip);
  if (wait) return r.status(429).json({ error: `Too many failed attempts. Try again in ${wait} seconds.`, code: 'throttled' });
  const u = users.find(x => x.user.toLowerCase() === name.toLowerCase());
  if (!u || !checkPw(u, String(b.pass || ''))) { fail(ip); audit('unknown', `failed sign-in for "${name}" from ${ip}`); return r.status(401).json({ error: 'Invalid username or password.' }); }
  fails.delete(ip);
  if (!u.pass.startsWith('scrypt$')) { u.pass = hashPw(String(b.pass)); wr('users.json', users); }

  let room = null, remote = false;
  if (u.role === 'teacher') {
    const deny = (code, status, error) => { audit(u.user, `sign-in refused (${code}) from ${ip}`); return r.status(status).json({ error, code }); };
    room = roomByIp(ip);
    if (room) {
      // On a lecture room PC: the login is tied to this room.
      if (!agents[room.id]) return deny('agent_offline', 403, `The agent on ${room.id} is not running. Please call AV staff.`);
      for (const s of sessionsOf(u.user)) {
        if (s.room === room.id) continue;
        if (!s.room) { endSession(s, 'replaced'); continue; }
        if (holds(s)) return deny('already_signed_in', 409, `This account is already signed in on ${s.room}. Sign out there first, or ask AV staff to release it.`);
        endSession(s, 'replaced');
      }
      for (const s of sessions.values()) {
        if (s.room !== room.id || s.u.user === u.user) continue;
        if (holds(s)) return deny('room_busy', 409, `${room.id} is in use by ${s.u.name}. Please use a free lecture room.`);
        endSession(s, 'replaced');
      }
      sessionsOf(u.user).forEach(s => dropSession(s, 'replaced'));
    } else {
      // Phone or personal laptop: a remote login. The faculty member picks the lecture room after signing in.
      if (!CFG.allowRemoteFaculty) return deny('not_lr', 403, `Faculty sign-in works only on a Lecture Room PC. This device (${ip}) is not a lecture room, or its agent has not connected yet.`);
      remote = true;
      for (const s of sessionsOf(u.user)) {
        if (s.remote) { if (s.room && !room) room = rooms.find(x => x.id === s.room) || null; dropSession(s, 'replaced'); continue; } // same person on another device: hand over, keep the room
        if (s.room && holds(s)) return deny('already_signed_in', 409, `This account is already signed in on ${s.room}. Sign out there first, or ask AV staff to release it.`);
        endSession(s, 'replaced');
      }
    }
  }
  const s = newSession(u, ip, room && room.id, remote);
  audit(u.user, `signed in${remote ? ' remotely' : ''}${room ? ' at ' + room.id : ''} from ${ip}`);
  if (room) evt(room.id, u.name, remote ? 'Signed in from their own device' : 'Signed in');
  push();
  r.json({ token: s.token, ...sessionInfo(s) });
});

app.get('/api/me', auth(null, { pw: true }), (q, r) => r.json(sessionInfo(q.s)));
app.post('/api/logout', auth(null, { pw: true }), (q, r) => { endSession(q.s, 'signed out'); r.json({ ok: 1 }); });
app.post('/api/password', auth(null, { pw: true }), (q, r) => {
  const b = q.body || {}, pw = String(b.pass || '');
  if (!checkPw(q.u, String(b.old || ''))) return r.status(400).json({ error: 'Your current password is not correct.' });
  if (pw.length < MIN_PW) return r.status(400).json({ error: `New password must be at least ${MIN_PW} characters.` });
  if (pw === String(b.old)) return r.status(400).json({ error: 'Choose a password different from the current one.' });
  q.u.pass = hashPw(pw); delete q.u.mustChange; wr('users.json', users); audit(q.u.user, 'changed own password'); r.json({ ok: 1 });
});

/* remote sharing: pick (or leave) the one lecture room that this faculty login sends slides to */
app.post('/api/remote/room', auth(['teacher']), (q, r) => {
  const s = q.s, id = String((q.body || {}).room || ''), no = (c, m) => r.status(c).json({ error: m });
  if (!s.remote) return no(400, 'This sign-in is already tied to the lecture room PC you are using.');
  const room = rooms.find(x => x.id === id);
  if (!room) return no(404, 'Unknown lecture room.');
  if (s.room === room.id) return r.json({ ok: 1, room: room.id });
  if (presenting(s)) return no(409, `End your lecture in ${s.room} before choosing another room.`);
  if (!agents[room.id]) return no(409, `The computer in ${room.id} is offline. Choose another room or call AV staff.`);
  const L = live[room.id] || {};
  if (L.owner && L.owner.user !== s.u.user) return no(409, `${room.id} is in use by ${L.owner.name}. Please choose a free lecture room.`);
  for (const x of [...sessions.values()]) {
    if (x === s || x.room !== room.id || !isTeacher(x)) continue;
    if (holds(x)) return no(409, `${room.id} is in use by ${x.u.name}. Please choose a free lecture room.`);
    endSession(x, 'replaced');
  }
  const prev = s.room; s.room = room.id; s.last = Date.now();
  audit(s.u.user, `chose ${room.id} to share slides from their own device`);
  evt(room.id, s.u.name, 'Connected from their own device'); if (prev) evt(prev, s.u.name, 'Disconnected');
  push(); if (L.frame) s.socks.forEach(w => send(w, { t: 'frame', room: room.id, data: L.frame }));
  s.socks.forEach(w => send(w, deckMsg(room.id)));
  r.json({ ok: 1, room: room.id });
});
app.post('/api/remote/leave', auth(['teacher']), (q, r) => {
  const s = q.s;
  if (!s.remote) return r.status(400).json({ error: 'This sign-in is tied to the lecture room PC you are using.' });
  if (presenting(s)) return r.status(409).json({ error: 'End your lecture before leaving the room.' });
  const prev = s.room; s.room = null;
  if (prev) { audit(s.u.user, `disconnected from ${prev}`); evt(prev, s.u.name, 'Disconnected'); }
  push(); r.json({ ok: 1 });
});

/* lectures */
app.get('/api/lectures', auth(), (q, r) => r.json(lectures.filter(l => q.u.role !== 'teacher' || l.user === q.u.user).map(l => ({ ...l, kind: kindOf(l.file) }))));
// The file is streamed to disk (a video can be gigabytes, so it is never held in memory) and size-limited.
app.post('/api/lectures', auth(), (q, r) => {
  let t; try { t = decodeURIComponent(q.headers['x-filename'] || 'lecture.pptx'); } catch { t = 'lecture.pptx'; }
  t = path.basename(t).slice(0, 120);
  const ext = path.extname(t).toLowerCase(), refuse = (c, m) => { r.set('Connection', 'close'); return r.status(c).json({ error: m }); };
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) return refuse(400, 'The file needs a normal extension, for example .pptx, .pdf or .mp4.');
  if (BLOCKED.has(ext)) return refuse(400, `${ext} files cannot be uploaded: programs, scripts and macro files are not allowed on lecture room PCs.`);
  if (+q.headers['content-length'] > MAX_UPLOAD) return refuse(413, `The file is larger than ${CFG.maxUploadMB || 2048} MB.`);
  const id = crypto.randomBytes(6).toString('hex'), file = id + ext, tmp = path.join(D, 'lectures', file + '.part'), out = fs.createWriteStream(tmp);
  let n = 0, over = false, dead = false;
  const drop = () => { dead = true; out.destroy(); fs.unlink(tmp, () => { }); };
  q.on('data', c => { n += c.length; if (n > MAX_UPLOAD && !over) { over = true; q.unpipe(out); drop(); refuse(413, `The file is larger than ${CFG.maxUploadMB || 2048} MB.`); } });
  q.on('aborted', drop); q.on('error', drop);
  out.on('error', () => { if (!dead) { drop(); if (!r.headersSent) refuse(500, 'The file could not be saved on the server.'); } });
  out.on('finish', () => {
    if (dead) return;
    if (!n) { fs.unlink(tmp, () => { }); return refuse(400, 'The file is empty.'); }
    fs.renameSync(tmp, path.join(D, 'lectures', file));
    lectures.push({ id, file, title: t.replace(/\.[^.]+$/, ''), by: q.u.name, user: q.u.user, at: new Date().toISOString(), size: n });
    wr('lectures.json', lectures); audit(q.u.user, `uploaded ${t} (${kindOf(file)}, ${Math.round(n / 1024)} KB)`); r.json({ ok: 1, id, kind: kindOf(file) });
  });
  q.pipe(out);
});
app.delete('/api/lectures/:id', auth(), (q, r) => {
  const l = lectures.find(x => x.id === q.params.id);
  if (!l || (q.u.role === 'teacher' && l.user !== q.u.user)) return r.status(404).json({ error: 'Lecture not found.' });
  if (Object.values(live).some(L => L.session && L.lecture === l.id)) return r.status(400).json({ error: 'This lecture is being presented right now.' });
  lectures = lectures.filter(x => x !== l); wr('lectures.json', lectures);
  try { fs.unlinkSync(path.join(D, 'lectures', path.basename(l.file))); } catch { }
  audit(q.u.user, `deleted lecture "${l.title}"`); r.json({ ok: 1 });
});

/* logs */
const readLog = () => { try { return fs.readFileSync(path.join(D, 'audit.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
app.get('/api/logs', auth(['admin', 'av']), (q, r) => {
  const L = readLog();
  if (q.query.download) return r.type('text/plain').attachment('audit-log.txt').send(L.join('\r\n'));
  r.json(L.slice(-500).reverse().map(l => { const m = l.match(/^(\S+) (\S+) (.*)$/); return m ? { t: m[1], u: m[2], m: m[3] } : { t: '', u: '', m: l }; }));
});

/* users and sign-ins */
app.get('/api/users', auth(['admin']), (q, r) => r.json(users.map(({ user, name, role, mustChange }) => ({ user, name, role, mustChange: !!mustChange, room: (sessionsOf(user).find(s => s.room) || {}).room || null }))));
app.post('/api/users', auth(['admin']), (q, r) => {
  const b = q.body || {}, bad = m => r.status(400).json({ error: m });
  if (!/^[A-Za-z0-9._+@-]{3,60}$/.test(b.user || '') || (b.user.includes('@') && !/^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(b.user))) return bad('Username: an email address (name@college.edu) or 3 to 60 letters, numbers, dot, dash or underscore.');
  if (String(b.pass || '').length < MIN_PW) return bad(`Password must be at least ${MIN_PW} characters.`);
  if (!['teacher', 'av', 'admin'].includes(b.role)) return bad('Choose a role.');
  if (users.some(x => x.user.toLowerCase() === b.user.toLowerCase())) return bad('That username already exists.');
  users.push({ user: b.user, pass: hashPw(String(b.pass)), role: b.role, name: String(b.name || b.user).slice(0, 60), mustChange: true });
  wr('users.json', users); audit(q.u.user, `created ${b.role} account ${b.user}`); r.json({ ok: 1 });
});
app.put('/api/users/:u/password', auth(['admin']), (q, r) => {
  const x = users.find(y => y.user === q.params.u), pw = String((q.body || {}).pass || '');
  if (!x || pw.length < MIN_PW) return r.status(400).json({ error: `Password must be at least ${MIN_PW} characters.` });
  x.pass = hashPw(pw); x.mustChange = true; wr('users.json', users);
  sessionsOf(x.user).forEach(s => endSession(s, 'password reset'));
  audit(q.u.user, 'reset the password of ' + x.user); r.json({ ok: 1 });
});
app.delete('/api/users/:u', auth(['admin']), (q, r) => {
  const i = users.findIndex(y => y.user === q.params.u);
  if (i < 0 || q.params.u === q.u.user) return r.status(400).json({ error: 'This account cannot be removed.' });
  users.splice(i, 1); wr('users.json', users);
  sessionsOf(q.params.u).forEach(s => endSession(s, 'account removed'));
  audit(q.u.user, 'removed account ' + q.params.u); r.json({ ok: 1 });
});
app.get('/api/sessions', auth(['admin', 'av']), (q, r) => r.json([...sessions.values()].map(s => ({
  sid: s.sid, user: s.u.user, name: s.u.name, role: s.u.role, room: s.room, ip: s.ip, remote: !!s.remote, since: s.at, last: s.last, presenting: presenting(s), online: s.socks.size > 0,
})).sort((a, b) => b.since - a.since)));
app.delete('/api/sessions/:sid', auth(['admin', 'av']), (q, r) => {
  const s = [...sessions.values()].find(x => x.sid === q.params.sid);
  if (!s) return r.status(404).json({ error: 'That sign-in has already ended.' });
  if (s === q.s) return r.status(400).json({ error: 'Use Sign out to end your own session.' });
  endSession(s, `released by ${q.u.name}`); audit(q.u.user, `released the sign-in of ${s.u.user}`); r.json({ ok: 1 });
});


/* ---------- AV help requests ---------- */
const CATS = { display: 'Projector or display', sound: 'Sound or microphone', pc: 'PC or software', slides: 'Slides will not open', other: 'Something else' };
const helpFor = s => (isTeacher(s) ? tickets.filter(t => t.user === s.u.user).slice(-5).map(({ mail, ...t }) => t) : tickets.slice(-300)).slice().reverse();
const pushHelp = () => uis.forEach(w => send(w, { t: 'help', tickets: helpFor(w.s) }));
const tell = (pred, m) => uis.forEach(w => pred(w.s) && send(w, { t: 'note', m }));
const findTicket = (q, r) => {
  const t = tickets.find(x => x.id === +q.params.id);
  if (!t || (isTeacher(q.s) && t.user !== q.u.user)) { r.status(404).json({ error: 'Request not found.' }); return null; }
  return t;
};
const mailTransport = () => {
  const m = CFG.mail;
  if (!m.host || !m.to) return null;
  return nodemailer.createTransport({ host: m.host, port: +m.port || 587, secure: !!m.secure, auth: m.user ? { user: m.user, pass: m.pass } : undefined, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, tls: m.insecureTls ? { rejectUnauthorized: false } : undefined });
};
const mailFrom = () => CFG.mail.from || CFG.mail.user || 'lecture-room-control@localhost';
const oneLine = x => String(x).replace(/[\r\n]+/g, ' ');
async function emailTicket(t, host) {
  const tr = mailTransport();
  if (!tr) t.mail = 'Email is not set up yet (Settings)';
  else {
    try {
      await tr.sendMail({
        from: mailFrom(), to: CFG.mail.to,
        subject: oneLine(`[AV help] ${t.room}: ${CATS[t.category]} (${t.name})`),
        text: `AV help was requested in ${t.room}${t.floor ? ' (' + t.floor + ')' : ''}.\n\nRequested by: ${t.name}\nProblem: ${CATS[t.category]}\nDetails: ${t.message || 'none given'}\nTime: ${new Date(t.at).toLocaleString()}\n\nOpen the AV dashboard to comment and resolve it:\nhttp://${host}/\n`,
      });
      t.mail = 'Emailed to ' + CFG.mail.to;
    } catch (e) { t.mail = 'Email failed: ' + oneLine(e.message).slice(0, 140); }
  }
  saveHelp(); audit('system', `help request #${t.id}: ${t.mail}`); pushHelp();
}
app.get('/api/help', auth(), (q, r) => r.json(helpFor(q.s)));
app.post('/api/help', auth(['teacher']), (q, r) => {
  const b = q.body || {}, room = rooms.find(x => x.id === q.s.room);
  if (!room) return r.status(400).json({ error: 'Your sign-in is not tied to a lecture room.' });
  const open = tickets.find(x => x.room === room.id && x.status === 'open');
  if (open) return r.status(409).json({ error: `AV help for ${room.id} was already requested (#${open.id}). AV staff have been notified.` });
  const t = { id: tickets.reduce((m, x) => Math.max(m, x.id), 0) + 1, room: room.id, floor: room.floor, user: q.u.user, name: q.u.name,
    category: CATS[b.category] ? b.category : 'other', message: String(b.message || '').trim().slice(0, 500), status: 'open', at: Date.now(), comments: [], mail: 'Sending email…' };
  tickets.push(t); saveHelp(); audit(q.u.user, `requested AV help in ${room.id} (#${t.id}, ${CATS[t.category]})`);
  evt(room.id, q.u.name, `Asked for AV help: ${CATS[t.category]}`);
  push(); pushHelp(); tell(s => !isTeacher(s), `New AV request from ${room.id}: ${CATS[t.category]}`);
  emailTicket(t, hostOf(q)).catch(() => { });
  r.json({ ok: 1, id: t.id });
});
app.post('/api/help/:id/comments', auth(), (q, r) => {
  const t = findTicket(q, r); if (!t) return;
  const text = String((q.body || {}).text || '').trim().slice(0, 1000);
  if (!text) return r.status(400).json({ error: 'Write a comment first.' });
  t.comments.push({ at: Date.now(), by: q.u.name, role: q.u.role, text }); saveHelp();
  audit(q.u.user, `commented on help request #${t.id}`); pushHelp();
  if (isTeacher(q.s)) tell(s => !isTeacher(s), `${q.u.name} added a note to the ${t.room} request`);
  else tell(s => isTeacher(s) && s.u.user === t.user, `AV staff replied: ${text.slice(0, 120)}`);
  r.json({ ok: 1 });
});
app.post('/api/help/:id/resolve', auth(['admin', 'av']), (q, r) => {
  const t = findTicket(q, r); if (!t) return;
  if (t.status === 'resolved') return r.status(400).json({ error: 'This request is already resolved.' });
  const note = String((q.body || {}).note || '').trim().slice(0, 1000);
  if (note) t.comments.push({ at: Date.now(), by: q.u.name, role: q.u.role, text: note });
  t.status = 'resolved'; t.resolvedAt = Date.now(); t.resolvedBy = q.u.name; saveHelp();
  audit(q.u.user, `resolved help request #${t.id} (${t.room})`); evt(t.room, q.u.name, 'Resolved the AV help request'); push(); pushHelp();
  tell(s => isTeacher(s) && s.u.user === t.user, `AV staff resolved your request.${note ? ' ' + note.slice(0, 120) : ''}`);
  r.json({ ok: 1 });
});
app.post('/api/help/:id/reopen', auth(['admin', 'av']), (q, r) => {
  const t = findTicket(q, r); if (!t) return;
  if (tickets.some(x => x.room === t.room && x.status === 'open')) return r.status(400).json({ error: `${t.room} already has an open request.` });
  t.status = 'open'; delete t.resolvedAt; delete t.resolvedBy; saveHelp();
  audit(q.u.user, `reopened help request #${t.id}`); push(); pushHelp(); r.json({ ok: 1 });
});

/* email settings (admin) */
/* ---------- branding: system name + logo (data/logo.png|jpg|webp) ---------- */
const LOGO_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const logoFile = () => Object.keys(LOGO_TYPES).map(e => path.join(D, 'logo.' + e)).find(f => fs.existsSync(f));
const brandInfo = () => { const f = logoFile(); return { name: String(CFG.systemName || DEFAULTS.systemName), logo: f ? Math.round(fs.statSync(f).mtimeMs) : 0 }; };
const logoKind = b => b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'png' : b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpg' : b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' ? 'webp' : '';
app.get('/api/branding', (q, r) => { r.set('Cache-Control', 'no-store'); r.json(brandInfo()); });   // public: the sign-in screen needs it
app.get('/logo', (q, r) => {
  const f = logoFile(); if (!f) return r.status(404).end();
  r.set({ 'Content-Type': LOGO_TYPES[path.extname(f).slice(1)], 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'" }); r.send(fs.readFileSync(f));
});
app.put('/api/settings/logo', auth(['admin']), express.raw({ type: () => true, limit: '2mb' }), (q, r) => {
  const b = q.body, kind = Buffer.isBuffer(b) ? logoKind(b) : '';
  if (!kind) return r.status(400).json({ error: 'Choose a PNG, JPG or WebP picture of at most 2 MB.' });
  for (const e in LOGO_TYPES) try { fs.unlinkSync(path.join(D, 'logo.' + e)); } catch { }
  fs.writeFileSync(path.join(D, 'logo.' + kind), b); audit(q.u.user, 'changed the system logo'); r.json({ ok: 1, ...brandInfo() });
});
app.delete('/api/settings/logo', auth(['admin']), (q, r) => { for (const e in LOGO_TYPES) try { fs.unlinkSync(path.join(D, 'logo.' + e)); } catch { } audit(q.u.user, 'removed the system logo'); r.json({ ok: 1, ...brandInfo() }); });
app.put('/api/settings/name', auth(['admin']), (q, r) => {
  const n = String((q.body || {}).name || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60);
  CFG.systemName = n || DEFAULTS.systemName; wr('config.json', CFG); audit(q.u.user, 'changed the system name to "' + CFG.systemName + '"'); r.json({ ok: 1, ...brandInfo() });
});
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const cleanTo = v => String(v || '').split(/[,;\s]+/).filter(Boolean);
app.get('/api/settings/mail', auth(['admin']), (q, r) => { const { pass, ...m } = CFG.mail; r.json({ ...m, hasPass: !!pass }); });
app.put('/api/settings/mail', auth(['admin']), (q, r) => {
  const b = q.body || {}, to = cleanTo(b.to), bad = m => r.status(400).json({ error: m });
  if (to.some(x => !EMAIL.test(x))) return bad('One of the recipient addresses is not valid.');
  if (b.from && !/^[^<>]*<[^\s@]+@[^\s@]+>$|^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.from).trim())) return bad('The "From" address is not valid.');
  const port = +b.port; if (b.host && !(port > 0 && port < 65536)) return bad('Enter a valid port number, e.g. 587.');
  CFG.mail = { host: String(b.host || '').trim(), port: port || 587, secure: !!b.secure, insecureTls: !!b.insecureTls, user: String(b.user || '').trim(), pass: b.pass ? String(b.pass) : CFG.mail.pass, from: String(b.from || '').trim(), to: to.join(', ') };
  wr('config.json', CFG); audit(q.u.user, 'updated the email settings'); r.json({ ok: 1 });
});
app.post('/api/settings/mail/test', auth(['admin']), async (q, r) => {
  const tr = mailTransport(); if (!tr) return r.status(400).json({ error: 'Save the mail server and at least one recipient first.' });
  try { await tr.sendMail({ from: mailFrom(), to: CFG.mail.to, subject: 'Lecture Room Control: test email', text: 'This is a test. AV help requests will be emailed to this address.' }); audit(q.u.user, 'sent a test email'); r.json({ ok: 1, to: CFG.mail.to }); }
  catch (e) { r.status(400).json({ error: 'Could not send: ' + oneLine(e.message).slice(0, 200) }); }
});

/* lecture rooms and agents */
app.post('/api/rooms/:id/rekey', auth(['admin', 'av']), (q, r) => {
  const x = rooms.find(y => y.id === q.params.id);
  if (!x) return r.status(404).json({ error: 'Unknown lecture room.' });
  x.key = newAgentId(); wr('rooms.json', rooms);
  if (agents[x.id]) agents[x.id].close();
  audit(q.u.user, 'created a new Agent ID for ' + x.id); r.json({ ok: 1 });
});
app.use('/vendor/novnc', express.static(path.join(__dirname, 'node_modules', '@novnc', 'novnc'), { index: false, dotfiles: 'deny', maxAge: '1d' }));
app.get('/vnc-setup.msi', (q, r) => {
  const f = path.join(__dirname, 'agent', 'vnc', 'tightvnc.msi');
  rooms.some(x => x.key === q.query.key) && fs.existsSync(f) ? r.sendFile(f) : r.sendStatus(404);
});
app.get('/api/vnc-installer', auth(['admin', 'av']), (q, r) => {
  const room = rooms.find(x => x.id === q.query.room);
  if (!room) return r.status(404).json({ error: 'Choose a lecture room.' });
  if (!fs.existsSync(path.join(__dirname, 'agent', 'vnc', 'tightvnc.msi'))) return r.status(409).json({ error: 'Put the TightVNC installer (64-bit .msi from tightvnc.com) in the server folder agent/vnc and name it tightvnc.msi, then try again.' });
  audit(q.u.user, 'downloaded the VNC installer for ' + room.id);
  const bat = fs.readFileSync(path.join(__dirname, 'agent', 'vnc-installer-template.bat'), 'utf8')
    .replace(/{{SCHEME}}/g, schemeOf(q)).replace(/{{HOST}}/g, hostOf(q)).replace(/{{KEY}}/g, room.key).replace(/{{VNCPASS}}/g, vncPassOf(room))
    .replace(/{{CTLPASS}}/g, Array.from(crypto.randomBytes(10), b => AL32[b % 32]).join('')).replace(/{{PORT}}/g, String(vncPort())).replace(/{{ALLOW}}/g, lanIps()).replace(/\r?\n/g, '\r\n');
  r.type('text/plain').attachment('install-vnc-' + room.id + '.bat').send(bat);
});
app.get('/agent.py', (q, r) => rooms.some(x => x.key === q.query.key) ? r.sendFile(path.join(__dirname, 'agent', 'agent.py')) : r.sendStatus(403));
app.get('/api/installer', auth(['admin', 'av']), (q, r) => {
  const room = rooms.find(x => x.id === q.query.room);
  if (!room) return r.status(404).json({ error: 'Choose a lecture room.' });
  audit(q.u.user, 'downloaded the agent installer for ' + room.id);
  const bat = fs.readFileSync(path.join(__dirname, 'agent', 'installer-template.bat'), 'utf8')
    .replace(/{{SCHEME}}/g, schemeOf(q)).replace(/{{WSSCHEME}}/g, schemeOf(q) === 'https' ? 'wss' : 'ws').replace(/{{HOST}}/g, hostOf(q)).replace(/{{KEY}}/g, room.key).replace(/\r?\n/g, '\r\n');
  r.type('text/plain').attachment('install-agent-' + room.id + '.bat').send(bat);
});
// The agent of a room uploads the pictures of the slides of the lecture opened on ITS room only.
app.post('/deck/:gen/:n', (q, r) => {
  const room = rooms.find(x => x.key === String(q.query.key || '')), gen = +q.params.gen, n = +q.params.n, total = +q.query.total, L = room && live[room.id];
  if (!room || !L || !L.serve || !agents[room.id]) return r.sendStatus(403);
  if (![gen, n, total].every(Number.isInteger) || n < 1 || n > 5000 || total < 1 || total > 5000 || n > total) return r.sendStatus(400);
  let dk = decks[room.id];
  if (dk && gen < dk.gen) return r.sendStatus(409);                       // a late picture of an earlier lecture
  if (!dk || dk.gen !== gen) { clearDeck(room.id, true); dk = decks[room.id] = { gen, total, have: new Set() }; }
  const chunks = []; let size = 0, dead = false;
  q.on('data', c => { size += c.length; if (size > MAX_SLIDE) { dead = true; q.destroy(); } else chunks.push(c); });
  q.on('error', () => { dead = true; });
  q.on('end', () => {
    if (dead) return r.sendStatus(413);
    const buf = Buffer.concat(chunks);
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return r.sendStatus(400);   // PNG pictures only
    if (decks[room.id] !== dk) return r.sendStatus(409);                  // the lecture ended while this was uploading
    fs.mkdirSync(deckDir(room.id), { recursive: true });
    fs.writeFile(path.join(deckDir(room.id), n + '.png'), buf, e => { if (e || decks[room.id] !== dk) return r.sendStatus(500); dk.have.add(n); notifyDeck(room.id); r.json({ ok: 1 }); });
  });
});
// A slide picture goes only to the faculty login of that room, or to staff.
app.get('/api/slide/:room/:n', (q, r) => {
  const s = sessions.get((q.headers.authorization || '').slice(7) || String(q.query.t || '')), id = q.params.room, n = +q.params.n;
  if (!s || s.u.mustChange || (isTeacher(s) && !s.remote && s.ip !== ipOf(q.socket))) return r.sendStatus(401);
  if (isTeacher(s) && s.room !== id) return r.sendStatus(403);
  const dk = decks[id];
  if (!rooms.some(x => x.id === id) || !dk || !Number.isInteger(n) || !dk.have.has(n)) return r.sendStatus(404);
  r.setHeader('Cache-Control', 'private, max-age=3600');   // the page asks with the lecture's number, so a picture never goes stale
  r.type('image/png'); r.sendFile(path.join(deckDir(id), n + '.png'));
});
// An agent may download only the lecture that was opened on ITS room (not any other room's lecture).
app.get('/files/:f', (q, r) => {
  const room = rooms.find(x => x.key === String(q.query.key || '')), name = path.basename(q.params.f), L = room && live[room.id];
  if (!room || !L || L.serve !== name) return r.sendStatus(403);
  r.sendFile(path.resolve(D, 'lectures', name));
});
app.post('/api/rooms', auth(['admin', 'av']), (q, r) => {
  const b = q.body || {}, bad = m => r.status(400).json({ error: m });
  if (!/^[A-Za-z0-9-]{1,20}$/.test(b.id || '')) return bad('Name: letters, numbers and hyphens, e.g. LR-3.');
  if (rooms.some(x => x.id.toLowerCase() === b.id.toLowerCase())) return bad('A lecture room with that name already exists.');
  const room = { id: b.id, ip: '', key: newAgentId(), floor: String(b.floor || 'Ground').slice(0, 30) };
  rooms.push(room);
  wr('rooms.json', rooms); audit(q.u.user, `added room ${b.id}`); push(); r.json({ ok: 1, agentId: room.key });
});
app.put('/api/rooms/:id', auth(['admin', 'av']), (q, r) => {
  const x = rooms.find(y => y.id === q.params.id), b = q.body || {};
  if (!x) return r.status(404).json({ error: 'Unknown lecture room.' });
  if (b.floor !== undefined) x.floor = String(b.floor || 'Ground').slice(0, 30);
  wr('rooms.json', rooms); audit(q.u.user, `updated room ${x.id}`); push(); r.json({ ok: 1 });
});
app.delete('/api/rooms/:id', auth(['admin', 'av']), (q, r) => {
  const f = facultyAt(q.params.id); if (f) endSession(f, 'room removed');
  if (agents[q.params.id]) agents[q.params.id].close();
  rooms = rooms.filter(x => x.id !== q.params.id); wr('rooms.json', rooms); delete live[q.params.id]; clearDeck(q.params.id, true);
  audit(q.u.user, 'removed room ' + q.params.id); push(); r.json({ ok: 1 });
});


/* ---------- remote control bookkeeping ---------- */
// A room PC obeys the mouse and keyboard only while at least one browser socket holds remote control of it.
const vsocks = new Set();     // live VNC links: { owner (browser ws), ws, tcp, room, end(why) }
const vtickets = new Map();   // one-time tickets: token -> { ws (browser that holds Full access), room, exp }
const killVnc = (owner, why) => { for (const v of [...vsocks]) if (v.owner === owner) v.end(why); };
const rcOn = id => [...uis].some(w => w.rc === id);
function endRc(ws, why) {
  const id = ws.rc; if (!id) return;
  ws.rc = null; killVnc(ws, why);
  const secs = Math.round((Date.now() - (ws.rcAt || Date.now())) / 1000);
  audit(ws.s.u.user, `remote control of ${id} ended (${why}; ${secs} s, ${ws.rcN || 0} input events)`); evt(id, ws.s.u.name, 'Ended remote control of the PC');
  if (!rcOn(id)) { if (agents[id]) send(agents[id], { t: 'cmd', a: 'rc', on: false }); if (live[id]) live[id].rc = null; push(); }
}

/* ---------- file transfer to the room PC ----------
// A teacher (on their own device) or staff member sends a file to ONE room PC. The server checks who they are, which room they
// may use, the file type and size, then the room's agent downloads it (one token, that room's Agent ID only) into
// <Public Documents>\MCSCMS Files\<folder>\<user> on the PC. Only the folders listed in config transferFolders exist. */
const XEXT = new Set(Object.values(EXT).join(' ').split(' '));   // slides, PDF, video, audio, images, Word / Excel / text documents
const XMAX = Math.max(1, +CFG.transferMaxMB || 500) * 1048576;
const xdir = path.join(D, 'transfers');
try { fs.rmSync(xdir, { recursive: true, force: true }); } catch { }
fs.mkdirSync(xdir, { recursive: true });
const xpending = new Map();   // token -> { room, file, exp }
const xreq = new Map();       // request id -> { room, done, t }
const cleanName = n => { n = path.basename(String(n)).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 120); return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n) ? '_' + n : n; };
const MAGIC = { '.pdf': '%PDF', '.png': '\x89PNG', '.jpg': '\xff\xd8', '.jpeg': '\xff\xd8', '.gif': 'GIF8', '.bmp': 'BM', '.pptx': 'PK', '.ppsx': 'PK', '.docx': 'PK', '.xlsx': 'PK', '.odt': 'PK', '.ods': 'PK', '.odp': 'PK' };
const looksLike = (ext, head) => !MAGIC[ext] || head.toString('latin1').startsWith(MAGIC[ext]);
function xdrop(token) { const p = xpending.get(token); xpending.delete(token); if (p) fs.unlink(p.file, () => { }); }
app.get('/xfer/:token', (q, r) => {
  const room = rooms.find(x => x.key === String(q.query.key || '')), p = xpending.get(q.params.token);
  if (!room || !p || p.room !== room.id || !agents[room.id] || p.exp < Date.now()) return r.sendStatus(403);
  r.sendFile(p.file);
});
app.post('/api/rooms/:id/transfer', auth(), (q, r) => {
  const s = q.s, u = q.u, staff = !isTeacher(s), id = staff ? q.params.id : s.room;
  const refuse = (c, m) => { r.set('Connection', 'close'); return r.status(c).json({ error: m }); };
  if (!staff && !CFG.allowFacultyTransfer) return refuse(403, 'Sending files to the room PC is switched off for faculty. Please ask AV staff.');
  if (!staff && (!id || q.params.id !== id)) return refuse(403, 'You can send files only to the lecture room you are connected to.');
  const room = rooms.find(x => x.id === id), L = room && live[id];
  if (!room || !L) return refuse(404, 'Unknown lecture room.');
  if (!agents[id]) return refuse(409, `The computer in ${id} is offline.`);
  if (L.owner && L.owner.user !== u.user) return refuse(409, `${L.owner.name} is in control of ${id}.${staff ? ' Press Take control first.' : ''}`);
  if (L.xbusy && Date.now() - L.xbusy < 300000) return refuse(409, `Another file is being sent to ${id}. Please wait a moment.`);
  const folder = String(q.query.folder || '');
  if (!XFOLDERS.includes(folder)) return refuse(400, 'Choose one of the allowed folders.');
  let t; try { t = decodeURIComponent(q.headers['x-filename'] || ''); } catch { t = ''; }
  t = cleanName(t); const ext = path.extname(t).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(ext) || BLOCKED.has(ext) || !XEXT.has(ext)) return refuse(400, `${ext || 'This'} files cannot be sent to a lecture room PC. Allowed: slides, PDF, Word, Excel, text, images, audio and video.`);
  if (+q.headers['content-length'] > XMAX) return refuse(413, `The file is larger than ${CFG.transferMaxMB || 500} MB.`);
  const token = crypto.randomBytes(18).toString('hex'), file = path.join(xdir, token + ext), out = fs.createWriteStream(file + '.part');
  let n = 0, dead = false;
  const drop = () => { dead = true; out.destroy(); fs.unlink(file + '.part', () => { }); L.xbusy = 0; };
  L.xbusy = Date.now();
  q.on('data', c => { n += c.length; if (n > XMAX && !dead) { q.unpipe(out); drop(); refuse(413, `The file is larger than ${CFG.transferMaxMB || 500} MB.`); } });
  q.on('aborted', drop); q.on('error', drop);
  out.on('error', () => { if (!dead) { drop(); if (!r.headersSent) refuse(500, 'The file could not be saved on the server.'); } });
  out.on('finish', () => {
    if (dead) return;
    const bad = m => { fs.unlink(file + '.part', () => { }); L.xbusy = 0; return refuse(400, m); };
    if (!n) return bad('The file is empty.');
    const head = Buffer.alloc(8); try { const fd = fs.openSync(file + '.part', 'r'); fs.readSync(fd, head, 0, 8, 0); fs.closeSync(fd); } catch { }
    if (!looksLike(ext, head)) { audit(u.user, `refused ${t}: content does not match ${ext}`); return bad(`This file does not look like a real ${ext} file.`); }
    fs.renameSync(file + '.part', file);
    xpending.set(token, { room: id, file, exp: Date.now() + 600000 });
    const rid = crypto.randomBytes(6).toString('hex'), ag = agents[id];
    const done = d => {
      xreq.delete(rid); xdrop(token); L.xbusy = 0;
      if (!d.ok) { audit(u.user, `file transfer of ${t} to ${id} failed: ${oneLine(d.error || '')}`); return r.status(502).json({ error: d.error || 'The room PC could not save the file.' }); }
      audit(u.user, `sent ${d.name} (${Math.round(n / 1024)} KB) to ${id} folder ${folder}`); evt(id, u.name, `Sent a file to the room PC: ${d.name}`);
      r.json({ ok: 1, name: d.name, folder });
    };
    xreq.set(rid, { room: id, done, t: Date.now() });
    if (!ag) return done({ ok: false, error: `The computer in ${id} went offline.` });
    send(ag, { t: 'cmd', a: 'xsave', id: rid, folder, user: cleanName(u.user), name: t, size: n, url: `/xfer/${token}?key=${room.key}` });
    setTimeout(() => { const x = xreq.get(rid); if (x) x.done({ ok: false, error: `The computer in ${id} did not confirm the file. Check that it is online and try again.` }); }, 240000);
  });
  q.pipe(out);
});

/* ---------- WebSocket hub ---------- */
console.log(CFG.vncPassword ? `VNC password: taken from data/config.json (${String(CFG.vncPassword).length} characters; only the first 8 are used)` : 'VNC password: generated per room (set "vncPassword" in data/config.json if TightVNC was installed by hand)');
const srv = TLS ? require('https').createServer({ key: fs.readFileSync(process.env.MCSCMS_TLS_KEY), cert: fs.readFileSync(process.env.MCSCMS_TLS_CERT) }, app) : http.createServer(app), wss = new WebSocketServer({ noServer: true, maxPayload: 8e6 }), vwss = new WebSocketServer({ noServer: true, maxPayload: 1e6 });
srv.on('upgrade', (req, sock, head) => {
  let u; try { u = new URL(req.url, 'http://x'); } catch { return sock.destroy(); }
  if (u.pathname === '/ws') wss.handleUpgrade(req, sock, head, w => wss.emit('connection', w, req));
  else if (u.pathname === '/vnc') vncUpgrade(req, sock, head, String(u.searchParams.get('ticket') || ''));
  else sock.destroy();
});
/* Full access over VNC: the browser (noVNC) talks RFB over this WebSocket and the server relays it to the room PC's TightVNC.
   A link needs a one-time ticket that was issued to a browser which holds Full access of that room (same rules as before). */
function vncUpgrade(req, sock, head, ticket) {
  const t = vtickets.get(ticket); vtickets.delete(ticket);
  const room = t && rooms.find(x => x.id === t.room);
  if (!t || t.exp < Date.now() || !room || !room.ip || !agents[room.id] || t.ws.readyState !== 1 || t.ws.rc !== room.id) { sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return sock.destroy(); }
  vwss.handleUpgrade(req, sock, head, ws => {
    const tcp = net.connect({ host: room.ip, port: vncPort() }), v = { owner: t.ws, ws, tcp, room: room.id, t0: Date.now(), up: 0, down: 0, over: false, head: '' };
    let seen = 0;
    v.end = (why, warn) => {
      if (v.over) return; v.over = true; vsocks.delete(v); if (warn) send(t.ws, { t: 'rcfail', m: warn }); try { ws.close(); } catch { } tcp.destroy();
      audit(t.ws.s.u.user, `VNC link to ${room.id} closed (${why}; ${Math.round((Date.now() - v.t0) / 1000)} s, ${v.up} bytes sent, ${v.down} received)`);
    };
    vsocks.add(v); tcp.setNoDelay(true); tcp.setTimeout(8000, () => tcp.destroy(new Error('timeout')));
    tcp.on('connect', () => tcp.setTimeout(0));
    const okT = setTimeout(() => { const L = live[room.id]; if (L && !v.over && v.down > 200) { L.vncBad = 0; const pw = vncPick(room); L.vncTry = 0; if (room.vncGood !== pw) { room.vncGood = pw; wr('rooms.json', rooms); } } }, 4000);   // still alive after 4 s with a screen coming in: the password is fine
    ws.on('close', () => clearTimeout(okT));
    tcp.on('data', d => { if (v.head.length < 600) v.head += d.toString('latin1'); v.down += d.length; ws.send(d, { binary: true }, () => { if (tcp.isPaused() && ws.bufferedAmount < 1e6) tcp.resume(); }); if (ws.bufferedAmount > 4e6) tcp.pause(); });
    tcp.on('error', e => v.end('PC unreachable: ' + (e.code || e.message), `The server could not open VNC on ${room.id} (${e.code || e.message}). Check that TightVNC is running and the firewall allows the server.`));
    tcp.on('close', () => {
      const L = live[room.id] = live[room.id] || {}, early = Date.now() - v.t0 < 15000, h = v.head;
      let warn = '';
      if (/too many|blacklist|banned/i.test(h) || (v.down === 0 && early)) {
        warn = `TightVNC on ${room.id} is not accepting this server right now (${v.down === 0 ? 'it closed the link at once' : 'too many failed sign-ins'}). It blocks an address for a few minutes after repeated wrong passwords: restart the "TightVNC Server" service on that PC (or wait ~10 minutes). Also check that the server is not the same computer as the room PC.`;
        L.vncBad = Date.now() + 5 * 60000;
      } else if (/fail|denied|invalid|incorrect/i.test(h) || (v.down < 80 && early)) {
        const n = vncCands(room).length; L.vncTry = (L.vncTry || 0) + 1;
        if (L.vncTry < n) { warn = `TightVNC on ${room.id} did not accept password ${L.vncTry} of ${n}. Press Full access again: the next saved password will be tried.`; }
        else { L.vncTry = 0; warn = `TightVNC on ${room.id} refused every password MCSCMS knows. Run this room's VNC installer (Lecture rooms tab) again on that PC. Until then Full access uses the older remote control.`; L.vncBad = Date.now() + 5 * 60000; }
      }
      if (warn) { audit(t.ws.s.u.user, `VNC sign-in problem on ${room.id}: ${warn.slice(0, 60)}... (server said: ${JSON.stringify(h.replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 80))})`); push(); }
      v.end('the PC closed the link', warn);
    });
    ws.on('message', d => { v.up += d.length; tcp.write(d); const n = Date.now(); if (n - seen > 5000) { seen = n; const L = live[room.id]; if (L) L.last = n; t.ws.s.last = n; } });   // typing and clicking keep the lecture and the sign-in alive
    ws.on('close', () => v.end('browser closed')); ws.on('error', () => v.end('browser error'));
  });
}
wss.on('connection', (ws, req) => {
  const p = new URL(req.url, 'http://x').searchParams, ip = ipOf(req.socket);
  if (p.get('key')) return agentConnection(ws, p.get('key'), ip);
  const s = sessions.get(p.get('token'));
  if (!s || (isTeacher(s) && !s.remote && s.ip !== ip) || s.u.mustChange) return ws.close(4003, 'sign in');
  ws.s = s; s.socks.add(ws); s.last = Date.now(); uis.add(ws);
  send(ws, { t: 'rooms', rooms: snapFor(s), ...(wantsChoices(s) ? { choices: choicesFor(s) } : {}) }); send(ws, { t: 'help', tickets: helpFor(s) });
  if (!isTeacher(s)) { for (const id in live) if (live[id].frame) send(ws, { t: 'frame', room: id, data: live[id].frame }); }
  else if (s.remote && s.room && live[s.room] && live[s.room].frame) send(ws, { t: 'frame', room: s.room, data: live[s.room].frame });
  if (isTeacher(s) && s.room) send(ws, deckMsg(s.room));
  ws.on('message', m => { try { cmd(ws, JSON.parse(m)); } catch (e) { } });
  ws.on('close', () => { uis.delete(ws); s.socks.delete(ws); s.last = Date.now(); if (ws.rc) endRc(ws, 'browser closed or disconnected'); });
});

function agentConnection(ws, key, ip) {
  const room = rooms.find(x => x.key === key);
  if (!room) { console.log('Rejected agent from', ip, '- unknown Agent ID'); warnOnce('key' + ip, `Agent at ${ip} was refused: unknown Agent ID. If this room got a new ID, run its newest installer on that PC.`); return ws.close(4002, 'unknown agent id'); }
  // Two lecture rooms cannot share one PC address (it is how a browser is matched to its LR).
  const clash = rooms.find(x => x !== room && agents[x.id] && x.ip === ip);
  if (clash) {
    console.log('Rejected agent for', room.id, '- address', ip, 'is already used by', clash.id);
    const L0 = live[room.id] = live[room.id] || {}, why = `Refused: this PC's address (${ip}) is already used by ${clash.id}. Each lecture room PC needs its own address.`;
    if (!agents[room.id] && L0.problem !== why) { L0.problem = why; push(); }   // only worth showing while the room is Offline
    warnOnce('clash' + room.id + ip, `${room.id}: agent from ${ip} refused, address already used by ${clash.id}`);
    return ws.close(4001, 'address in use by ' + clash.id);
  }
  if (room.ip !== ip) { // learn (or update) this PC's address automatically
    rooms.forEach(x => { if (x !== room && x.ip === ip) x.ip = ''; });
    room.ip = ip; wr('rooms.json', rooms);
  }
  if (agents[room.id] && agents[room.id] !== ws) agents[room.id].close();
  const L = live[room.id] = live[room.id] || {};
  clearDeck(room.id, true);
  agents[room.id] = ws; L.online = true; L.seen = Date.now(); L.owner = null; L.session = null; L.serve = null; L.problem = null; L.ver = 0; setTimeout(() => probeVnc(room.id), 300);
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  push(); console.log('Agent online:', room.id, ip); audit('system', `${room.id} (${ip}) came online`); evt(room.id, 'System', 'PC came online');
  ws.on('message', m => {
    let d; try { d = JSON.parse(m); } catch { return; }
    L.seen = Date.now(); ws.alive = true;
    if (d.t === 'frame') {
      L.frame = d.data;
      if (d.mons && d.mons !== L.mons) { L.mons = d.mons; push(); }
      const f = JSON.stringify({ t: 'frame', room: room.id, data: d.data });
      // staff see every room; a remote faculty login sees only the one room it chose (to confirm the slides are on the right projector)
      uis.forEach(w => w.readyState === 1 && w.bufferedAmount < 3e6 && (!isTeacher(w.s) || (w.s.remote && w.s.room === room.id)) && w.send(f));   // a slow viewer skips pictures instead of lagging further behind
    } else if (d.t === 'hello') {
      L.ver = +d.ver || 0;
      if (L.ver < AGENT_VER) { send(ws, { t: 'cmd', a: 'update' }); audit('system', `${room.id}: agent version ${L.ver} is older than ${AGENT_VER}, asked it to update itself`); }
      else { const w = [...uis].find(x => x.rc === room.id); if (w) { if (!isTeacher(w.s)) L.owner = { user: w.s.u.user, name: w.s.u.name }; send(ws, { t: 'cmd', a: 'rc', on: true, who: w.s.u.name }); push(); } }   // the PC (or its network) blinked while someone was controlling it: carry on without a new Take control
    } else if (d.t === 'cur') {   // pointer position and input counter, only for whoever controls this PC
      const f = JSON.stringify({ t: 'cur', room: room.id, cur: Array.isArray(d.cur) ? d.cur.slice(0, 2).map(Number) : null, n: +d.n || 0, err: String(d.err || '').slice(0, 220) });
      uis.forEach(w => w.readyState === 1 && w.rc === room.id && w.send(f));
    } else if (d.t === 'xres') {
      const x = xreq.get(d.id); if (x && x.room === room.id) { x.done({ ok: !!d.ok, error: d.error ? String(d.error).slice(0, 200) : '', name: d.name ? String(d.name).slice(0, 130) : '', files: Array.isArray(d.files) ? d.files.slice(0, 200).map(f => ({ name: String(f.name).slice(0, 130), size: +f.size || 0 })) : undefined, op: d.op }); }
    } else if (d.t === 'rcready') {
      uis.forEach(w => w.rc === room.id && send(w, { t: 'rcready', room: room.id }));
    } else if (d.t === 'state') {
      let ns = (d.state && d.state.session) || null;
      if (ns) { const lf = lectures.find(l => l.file === ns.lecture); if (lf) L.lecture = lf.id; ns = { ...ns, lecture: lf ? lf.title : ns.lecture, kind: lf ? kindOf(lf.file) : null }; } // show the title, not the stored file name
      else if (!(L.started && Date.now() - L.started < 30000)) L.lecture = null;   // a 'nothing open' report that raced with the open command must not forget the lecture
      if (JSON.stringify(ns) !== JSON.stringify(L.session)) { L.session = ns; push(); }
    }
  });
  ws.on('close', () => {
    if (agents[room.id] !== ws) return;
    delete agents[room.id]; L.rc = null; audit('system', `${room.id} went offline`); evt(room.id, 'System', 'PC went offline');
    L.online = false; L.session = null; L.owner = null; L.lecture = null; L.serve = null; clearDeck(room.id); push();
  });
}

function cmd(ws, c) {
  const s = ws.s, u = s.u, staff = !isTeacher(s), roomId = staff ? c.room : s.room;
  const L = live[roomId], a = agents[roomId], deny = m => send(ws, { t: 'err', m });
  s.last = Date.now();
  if (!sessions.has(s.token)) return;
  if (c.a === 'rcstop') { if (ws.rc) endRc(ws, 'released by user'); return; }   // always allowed: letting go must never be refused
  if (!staff && !roomId) return deny('Choose a lecture room first.');   // faculty can only ever act on the room tied to their own login
  if (!L || !rooms.some(x => x.id === roomId)) return deny(`${roomId || 'This room'} is not connected. Please call AV staff.`);
  if (!a) return deny('The computer in this lecture room is offline. Please call AV staff.');
  if (c.a === 'take' && staff) { uis.forEach(w => w.rc === roomId && w.s !== s && (endRc(w, `control taken by ${u.name}`), send(w, { t: 'rcfail', m: `${u.name} took control of this room.` }))); L.owner = { user: u.user, name: u.name }; audit(u.user, 'took control of ' + roomId); evt(roomId, u.name, 'Took control of the room'); return push(); }
  if (L.owner && L.owner.user !== u.user) return c.a === 'input' ? undefined : deny(`${L.owner.name} is in control of this room.${staff ? ' Press Take control to continue.' : ''}`);
  if (c.a === 'release' && staff) { if (L.owner && L.owner.user === u.user) { if (ws.rc === roomId) endRc(ws, 'control released'); L.owner = null; audit(u.user, 'released control of ' + roomId); evt(roomId, u.name, 'Released control of the room'); push(); } return; }
  /* Remote control: the mouse and keyboard of the room PC (like Remote Desktop). Staff must hold Take control; a faculty login only ever acts on its own room,
     and only a socket that started remote control of THIS room (rcstart) can send input to it. */
  if (c.a === 'rcstart' || c.a === 'vncstart' || c.a === 'input' || c.a === 'mon') {
    const allowed = staff || (s.remote && CFG.allowFacultyControl);
    if ((c.a === 'rcstart' || c.a === 'vncstart') && !allowed) return deny('Remote control of the room PC is switched off for faculty. Please ask AV staff.');
    if (!allowed || (staff && !(L.owner && L.owner.user === u.user))) return c.a === 'rcstart' || c.a === 'vncstart' ? deny('Press Take control first.') : undefined;
    if (c.a === 'vncstart') {
      if (!L.vnc) return send(ws, { t: 'rcfail', m: `VNC is not reachable on ${roomId}. Run this room's VNC installer once on that PC (Lecture rooms tab).` });
      const other = [...uis].find(w => w !== ws && w.rc === roomId && w.s.u.user !== u.user);
      if (other) return send(ws, { t: 'rcfail', m: `${other.s.u.name} is already controlling ${roomId}.` });
      if (ws.rc && ws.rc !== roomId) endRc(ws, 'switched room');
      killVnc(ws, 'new link');
      if (ws.rc !== roomId) { ws.rc = roomId; ws.rcAt = Date.now(); ws.rcN = 0; audit(u.user, `started Full access (VNC) of ${roomId} (${u.role}, from ${s.ip}; password ${CFG.vncPassword ? 'from config.json' : 'generated'})`); evt(roomId, u.name, 'Started Full access to the PC'); }
      L.rc = { user: u.user, name: u.name, role: u.role, since: ws.rcAt }; L.last = Date.now();
      const now = Date.now(), tk = crypto.randomBytes(18).toString('hex'); for (const [k, x] of vtickets) if (x.exp < now) vtickets.delete(k);
      vtickets.set(tk, { ws, room: roomId, exp: now + 30000 });
      send(ws, { t: 'vnc', room: roomId, ticket: tk, pass: vncPick(rooms.find(x => x.id === roomId)) }); push(); return;
    }
    if (c.a === 'rcstart') {
      if (!(L.ver >= AGENT_VER)) return send(ws, { t: 'rcfail', m: L.ver ? `The agent on ${roomId} is updating itself. Please try again in about 20 seconds.` : `The agent on ${roomId} is an old version without remote control. On that PC, run this room's Installer once (Lecture rooms tab, Installer). After that it updates itself.` });
      const other = [...uis].find(w => w !== ws && w.rc === roomId && w.s.u.user !== u.user);
      if (other) return send(ws, { t: 'rcfail', m: `${other.s.u.name} is already controlling ${roomId}.` });
      if (ws.rc && ws.rc !== roomId) endRc(ws, 'switched room');
      if (ws.rc !== roomId) { ws.rc = roomId; ws.rcAt = Date.now(); ws.rcN = 0; audit(u.user, `started remote control of ${roomId} (${u.role}, from ${s.ip})`); evt(roomId, u.name, 'Started remote control of the PC'); }
      L.rc = { user: u.user, name: u.name, role: u.role, since: ws.rcAt }; L.last = Date.now();
      send(a, { t: 'cmd', a: 'rc', on: true, who: u.name }); push(); return;
    }
    if (ws.rc !== roomId) return;
    if (c.a === 'mon') { const n = Math.round(+c.n); if (Number.isInteger(n) && n >= 0 && n <= 8) send(a, { t: 'cmd', a: 'mon', n }); return; }
    const now = Date.now(); if (!ws.rl || now - ws.rl.t >= 1000) ws.rl = { t: now, n: 0 }; if (++ws.rl.n > 400) return;   // at most 400 input events a second
    const e = c.e || {}, k = String(e.k), num = (v, lo, hi) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0; }, o = { k };
    if (k === 'mv' || k === 'md' || k === 'mu' || k === 'dbl') { o.x = num(e.x, 0, 1); o.y = num(e.y, 0, 1); if (k === 'md' || k === 'mu') o.b = Math.round(num(e.b, 0, 2)); }
    else if (k === 'wh' || k === 'wx') o.dy = num(e.dy, -2000, 2000);
    else if (k === 'kd' || k === 'ku') { o.c = String(e.c || ''); if (!/^[A-Za-z0-9]{1,16}$/.test(o.c) || (!staff && /^Meta/.test(o.c))) return; }   // faculty cannot use the Windows key
    else if (k === 'tx') { o.t = String(e.t || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200); if (!o.t) return; }   // typed text (phone keyboards, pasted text)
    else if (k !== 'rel') return;
    ws.rcN = (ws.rcN || 0) + 1; L.last = now; send(a, { t: 'cmd', a: 'input', e: o });
    return;
  }
  /* File transfer helpers: list or open a file in the room's transfer folder (the upload itself is POST /api/rooms/:id/transfer). */
  if (c.a === 'xlist' || c.a === 'xopen') {
    if (!staff && !CFG.allowFacultyTransfer) return deny('Sending files to the room PC is switched off for faculty. Please ask AV staff.');
    const folder = String(c.folder || ''); if (!XFOLDERS.includes(folder)) return deny('Choose one of the allowed folders.');
    const name = c.a === 'xopen' ? cleanName(c.name || '') : '', ext = path.extname(name).toLowerCase();
    if (c.a === 'xopen' && (!XEXT.has(ext) || BLOCKED.has(ext))) return deny('That file type cannot be opened from here.');
    const rid = crypto.randomBytes(6).toString('hex');
    xreq.set(rid, { room: roomId, t: Date.now(), done: d => { xreq.delete(rid); send(ws, { t: 'xres', room: roomId, op: c.a, folder, name: d.name || name, ok: d.ok, error: d.error, files: d.files }); } });
    L.last = Date.now(); send(a, { t: 'cmd', a: c.a, id: rid, folder, user: cleanName(u.user), name });
    if (c.a === 'xopen') { audit(u.user, `opened ${name} on ${roomId} (folder ${folder})`); evt(roomId, u.name, `Opened ${name} on the room PC`); }
    return;
  }
  if (c.a === 'open') {
    const f = lectures.find(x => x.id === c.lecture);
    if (!f || (!staff && f.user !== u.user)) return deny('Choose one of your lectures first.');
    clearDeck(roomId);
    L.owner = { user: u.user, name: u.name }; L.done = false; L.started = L.last = Date.now(); L.lecture = f.id; L.serve = f.file;
    send(a, { t: 'cmd', a: 'open', full: !!c.full, name: f.file, url: `/files/${f.file}?key=${rooms.find(x => x.id === roomId).key}` });   // full: the teacher is in Full screen, so fill the LR display
    audit(u.user, `opened "${f.title}" in ${roomId}`); evt(roomId, u.name, `Started "${f.title}"`); push();
  } else if (c.a === 'goto') {
    const n = +c.n; if (!Number.isInteger(n) || n < 1 || n > 5000) return;   // jump to a slide from the teacher's own device
    L.last = Date.now(); send(a, { t: 'cmd', a: 'goto', n }); audit(u.user, `went to slide ${n} in ${roomId}`);
  } else if (c.a === 'stream') {
    send(a, { t: 'cmd', a: 'stream', hi: !!c.hi });   // bigger, faster picture while the teacher is in Full screen on their own device
  } else if (c.a === 'key') {
    if (!['right', 'left', 'up', 'down', 'pgup', 'pgdn', 'home', 'end', 'space', 'volup', 'voldown', 'mute'].includes(c.k)) return;
    L.last = Date.now(); send(a, { t: 'cmd', a: 'key', k: c.k });   // remote keys for PDF, video and other non-slide files
  } else if (['next', 'prev', 'blank', 'stop', 'playpause', 'fullscreen', 'exitfull'].includes(c.a)) {
    L.last = Date.now(); send(a, { t: 'cmd', a: c.a });
    if (c.a !== 'blank' && c.a !== 'playpause') audit(u.user, `${c.a === 'fullscreen' ? 'full screen on the room display' : c.a === 'exitfull' ? 'left full screen on the room display' : c.a} in ${roomId}`);
    if (c.a === 'stop') { evt(roomId, u.name, 'Ended the lecture'); L.owner = null; L.done = true; L.session = null; L.lecture = null; L.serve = null; clearDeck(roomId, true); push(); notifyDeck(roomId); }
  }
}

/* ---------- housekeeping ---------- */
setInterval(() => {
  const now = Date.now();
  for (const [t, p] of xpending) if (p.exp < now) xdrop(t);
  for (const [k, x] of xreq) if (now - x.t > 300000) xreq.delete(k);
  for (const id in live) {
    const L = live[id];
    if (!agents[id] || !L.session || !L.owner || now - L.last <= IDLE) continue;
    send(agents[id], { t: 'cmd', a: 'stop' }); audit('system', `Ended the presentation in ${id} (no activity)`); evt(id, 'System', 'Lecture ended automatically (no activity)');
    const f = facultyAt(id); if (f) f.last = now;
    L.owner = null; L.done = true; L.session = null; L.serve = null; clearDeck(id); push();
  }
  for (const s of [...sessions.values()]) {
    if (isTeacher(s)) {
      if (presenting(s)) continue;
      if (!s.socks.size && now - s.last > GRACE) endSession(s, 'browser closed');
      else if (now - s.last > T_IDLE) endSession(s, 'inactive');
    } else if (now - s.last > S_IDLE) endSession(s, 'expired');
  }
}, CFG.checkSeconds * 1000);

setInterval(() => Object.keys(agents).forEach(probeVnc), 20000);
// Heartbeat: ping every agent. A PC that went silent (cable pulled, Wi-Fi dropped, PC asleep) is closed and shown Offline
// promptly, and a PC whose agent is alive and answering stays Online.
setInterval(() => {
  for (const id in agents) { const w = agents[id]; if (w.alive === false) { console.log('Agent not answering, closing:', id); w.terminate(); continue; } w.alive = false; try { w.ping(); } catch { } }
}, Math.max(5, CFG.agentPingSeconds) * 1000);

const PORT = process.env.PORT || 3000;
srv.listen(PORT, '0.0.0.0', () => {
  console.log(`\nLecture Room Control is running on port ${PORT}`);
  Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).forEach(i => console.log(`  Open  http://${i.address}:${PORT}`));
  console.log('');
});

/*
 * Pacer Club · Heart Rate Booth
 *
 * Up to three people at once, one armband each, on one shared countdown: sit
 * still, high knees, recover. Each lane is measured on its own, so
 * one armband slipping costs only that person their result. Everything runs in
 * the page; results live in localStorage so a refresh mid-fair loses nothing.
 */
'use strict';

// The QR on the screen and the receipt opens this person's result here; the
// result itself rides in the link. CLUB is the club the booth is for, so
// pacer.club can offer the right houses when they sign up.
//
// To try the result page before it is deployed, open the booth once with
// ?site=http://<this Mac's address>:3100 and every QR points at that copy of
// the site instead. It's remembered, and a label in the top bar says so until
// it's cleared with ?site=reset.
const RESULT_URL = (() => {
  const KEY = 'pacer-hr-booth/site';
  try {
    const asked = new URLSearchParams(location.search).get('site');
    if (asked === 'reset') localStorage.removeItem(KEY);
    else if (asked && /^https?:\/\/[^\s/]+$/.test(asked.replace(/\/$/, ''))) localStorage.setItem(KEY, asked.replace(/\/$/, ''));
    const site = localStorage.getItem(KEY);
    if (site) return `${site}/hr`;
  } catch {}
  return 'https://pacer.club/hr';
})();
const CLUB = 'ykps';
// v2: recovery is now finish → 60 s later after 60 s of paced high knees,
// so results from the earlier version aren't mixed in.
const STORE_KEY = 'pacer-hr-booth/v2';
const PREFS_KEY = 'pacer-hr-booth/prefs';
const HOUSES = ['Spring', 'Summer', 'Autumn', 'Winter', 'Other'];

// The test, in order. `step` is which of the three numbered steps it belongs
// to; "ready" is a short beat between sitting and moving so nobody is caught out.
const PHASES = [
  { id: 'rest',     step: 0, secs: 20, label: 'Rest',
    title: 'Sit still and breathe normally', sub: 'We’re finding your resting heart rate.' },
  { id: 'ready',    step: 1, secs: 5,  label: 'Get ready',
    title: 'Stand up, high knees next', sub: 'Knees up to hip height, as fast as you can.' },
  { id: 'exercise', step: 1, secs: 60, label: 'High knees',
    title: 'High knees!', sub: 'Knees up to hip height, as fast as you can. Keep going!' },
  { id: 'recover',  step: 2, secs: 60, label: 'Recover',
    title: 'Sit down and relax', sub: 'Breathe normally while we see how far your heart rate drops in one minute.' },
];

// Resting = the average of the last stretch of the rest phase. If heart rate
// is still clearly falling by then, rest runs on a little until it settles.
const REST_WINDOW = 12000;
const SETTLE_STEP = 5000;
const SETTLE_MAX = 20000;
const SETTLE_SLOPE = -0.25;   // bpm per second

// Signal checks during a test. Any of these ends the test without a report.
const GAP_MS = 5000;          // no reading for this long
const JUMP_BPM = 30;          // change between two readings a second or two apart
const FREEZE_MS = { rest: 25000, other: 15000 };  // same number for this long

// The reading 60 s after the finish needs a sample on either side of it.
const FINISH_WAIT = 1500;

// Each test gets its own timeline, because rest can stretch.
function timeline(restExtra = 0) {
  let at = 0;
  return PHASES.map(p => {
    const ms = p.secs * 1000 + (p.id === 'rest' ? restExtra : 0);
    const q = { ...p, start: at, end: at + ms };
    at += ms;
    return q;
  });
}
const phaseOf = (t, id) => t.phases.find(p => p.id === id);
const testEnd = t => t.phases[t.phases.length - 1].end;

// The curve is drawn this far behind real time, so it can glide between
// samples (straps send about one a second) instead of jumping to each one.
const RENDER_DELAY = 1200;
const STALE_MS = 4000;

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/* ── State ───────────────────────────────────────────────── */

// Up to three people at once, one armband each. Lane numbers match the
// stickers on the armbands, so a lane is a physical thing, not a slot.
const LANES = 3;
const QUEUE_KEY = 'pacer-hr-booth/queue';

const S = {
  view: 'live',
  prevView: 'live',
  lanes: [],
  run: null,          // the shared test, while one is going
  queue: [],          // the next group, one person (or nobody) per lane
  group: null,        // the last group to finish
  report: null,
  reportFromGroup: false,
  freshId: null,
  entries: [],
  demo: false,
  prefs: { sound: true, theme: 'auto', autoPrint: true },
};

const blankPerson = () => ({ name: '', house: null, age: '', max: '', dist: 1000, time: '' });

function load() {
  try { S.entries = JSON.parse(localStorage.getItem(STORE_KEY))?.entries || []; } catch { S.entries = []; }
  try { Object.assign(S.prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch {}
  let queue = [];
  try { queue = JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch {}
  S.queue = Array.from({ length: LANES }, (_, i) => ({ ...blankPerson(), ...(queue[i] || {}) }));
}
function saveEntries() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ entries: S.entries })); } catch {}
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(S.prefs)); } catch {}
}
function saveQueue() {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(S.queue)); } catch {}
}
function ranked() {
  return [...S.entries].sort((a, b) => b.drop - a.drop || a.at - b.at);
}

/* ── Lanes and their armbands ────────────────────────────── */

function makeLane(i) {
  return {
    i,
    n: i + 1,
    source: null,       // 'ble' | 'demo' | null
    device: null,
    want: false,
    retry: 0,
    pending: false,
    demo: null,
    note: '',
    samples: [],        // live stream, absolute time: { t, hr }
    lastHr: null,
    lastAt: 0,
    person: null,       // who is in this lane for the run in progress
    t: null,            // this lane's part of that run
    ui: null,
    chart: null,
  };
}

const connected = lane => lane.source === 'demo' || (lane.source === 'ble' && !!lane.device?.gatt?.connected);
const fresh = lane => lane.lastHr != null && performance.now() - lane.lastAt < STALE_MS;

function onHr(lane, hr, src) {
  if (src !== lane.source) return;
  // Straps report 0 (or nonsense) while they're still finding skin contact.
  if (!(hr >= 30 && hr <= 230)) return;
  const now = performance.now();
  lane.lastHr = hr;
  lane.lastAt = now;
  lane.samples.push({ t: now, hr });
  while (lane.samples.length && now - lane.samples[0].t > 180000) lane.samples.shift();
  if (S.run && lane.t?.status === 'running') testSample(lane.t, now - S.run.start, hr);
}

async function connectLane(lane) {
  if (!navigator.bluetooth) return flash(lane, 'Bluetooth needs Chrome, opened from localhost.');
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
  } catch (err) {
    if (err?.name !== 'NotFoundError') flash(lane, `Couldn’t connect: ${err?.message || err}`);
    return;
  }
  const other = S.lanes.find(l => l !== lane && l.device?.id === device.id);
  if (other) return flash(lane, `That armband is already on lane ${other.n}.`);

  dropArmband(lane);
  lane.device = device;
  lane.source = 'ble';
  lane.want = true;
  lane.retry = 0;
  lane.samples = [];
  lane.lastHr = null;
  device.addEventListener('gattserverdisconnected', () => armbandLost(lane, device));
  renderLanes();
  try {
    await gattConnect(lane, device);
    wake();
  } catch (err) {
    flash(lane, `Couldn’t connect: ${err?.message || err}`);
    armbandLost(lane, device);
  }
  renderLanes();
}

async function gattConnect(lane, device) {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService('heart_rate');
  const ch = await service.getCharacteristic('heart_rate_measurement');
  ch.addEventListener('characteristicvaluechanged', e => {
    const v = e.target.value;
    // Bit 0 of the flags byte says whether the value is 8 or 16 bits.
    onHr(lane, v.getUint8(0) & 1 ? v.getUint16(1, true) : v.getUint8(1), 'ble');
  });
  await ch.startNotifications();
  lane.retry = 0;
}

// Armbands drop out when someone walks off or turns away; keep trying quietly.
// A lane in the middle of a test is already lost by then; reconnecting only
// gets it ready for the next group.
function armbandLost(lane, device) {
  if (lane.device !== device || !lane.want || lane.pending) return;
  lane.pending = true;
  const wait = Math.min(1000 * 2 ** lane.retry++, 8000);
  setTimeout(async () => {
    lane.pending = false;
    if (lane.device !== device || !lane.want || device.gatt.connected) return;
    try { await gattConnect(lane, device); } catch { armbandLost(lane, device); }
  }, wait);
}

function dropArmband(lane) {
  lane.want = false;
  try { if (lane.device?.gatt?.connected) lane.device.gatt.disconnect(); } catch {}
  lane.device = null;
  if (lane.source === 'ble') lane.source = S.demo ? 'demo' : null;
  if (lane.source === 'demo' && !lane.demo) lane.demo = makeDemo();
  lane.samples = [];
  lane.lastHr = null;
}

let flashTimers = [];
function flash(lane, text) {
  lane.note = text;
  clearTimeout(flashTimers[lane.i]);
  flashTimers[lane.i] = setTimeout(() => { lane.note = ''; renderLanes(); }, 6000);
  renderLanes();
}

// A pretend person per lane, so every screen can be tried without armbands.
// Each run gets a slightly different body so the board fills up varied.
function makeDemo() {
  const d = {
    hr: 76,
    quietUntil: 0,
    persona() {
      d.rest = 62 + Math.random() * 22;
      d.max = 158 + Math.random() * 32;
      d.floor = d.rest + 25 + Math.random() * 25;
      d.tau = 35 + Math.random() * 60;
    },
    tick(lane) {
      if (performance.now() < d.quietUntil) return;
      const phase = S.run && lane.t ? currentPhase().id : 'idle';
      let target = d.rest, tau = 12;
      if (phase === 'ready') { target = d.rest + 14; tau = 4; }
      if (phase === 'exercise') { target = d.max; tau = 16; }
      if (phase === 'recover') { target = d.floor; tau = d.tau; }
      d.hr += (target - d.hr) * (1 - Math.exp(-1 / tau));
      onHr(lane, Math.round(d.hr + (Math.random() - 0.5) * 2.6), 'demo');
    },
  };
  d.persona();
  d.hr = d.rest + 6;
  return d;
}

let demoTimer = null;
function setDemo(on) {
  S.demo = on;
  for (const lane of S.lanes) {
    if (on && lane.source !== 'ble') { lane.source = 'demo'; lane.demo = makeDemo(); lane.samples = []; lane.lastHr = null; }
    if (!on && lane.source === 'demo') { lane.source = null; lane.demo = null; lane.samples = []; lane.lastHr = null; }
  }
  clearInterval(demoTimer);
  // Staggered a little, so three pretend hearts don't beat in lockstep.
  if (on) demoTimer = setInterval(() => S.lanes.forEach((lane, i) => {
    if (lane.source === 'demo') setTimeout(() => lane.demo.tick(lane), i * 280);
  }), 1000);
  $('m-demo').setAttribute('aria-checked', String(on));
  if (on) wake();
  renderLanes();
}

/* ── Views ───────────────────────────────────────────────── */

function show(view) {
  if (view === 'board' && S.view !== 'board') S.prevView = S.view;
  S.view = view;
  for (const v of ['live', 'group', 'report', 'board']) $(`view-${v}`).hidden = v !== view;
  $('btn-board').setAttribute('aria-pressed', String(view === 'board'));
  if (view === 'board') renderBoard();
  if (view === 'live') { renderStage(); renderLanes(); S.lanes.forEach(l => l.chart?.resize()); }
  if (view === 'report') reportChart.resize();
}

function leaveBoard() {
  let back = S.prevView;
  if (back === 'board' || (back === 'report' && !S.report) || (back === 'group' && !S.group)) back = 'live';
  show(back);
}

/* ── The next group ──────────────────────────────────────── */

// "4:30", "4.30", "4 30" or "430" → seconds, if it's a believable time for the distance.
function parseRace(str, dist) {
  const s = str.trim();
  let m = s.match(/^(\d{1,2})\s*[:.'’\s]\s*(\d{1,2})$/);
  if (!m && /^\d{3,4}$/.test(s)) m = [s, s.slice(0, -2), s.slice(-2)];
  if (!m) return null;
  const secs = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[2]) > 59) return null;
  const [lo, hi] = dist === 800 ? [100, 600] : [130, 720];
  return secs >= lo && secs <= hi ? secs : null;
}

/** What's wrong with a queued person, field by field. Empty when ready. */
function problems(p) {
  if (!p.name.trim()) return {};
  const out = {};
  const age = Number(p.age);
  if (!p.house) out.house = true;
  if (!(age >= 6 && age <= 90)) out.age = true;
  if (p.max && !(Number(p.max) >= 120 && Number(p.max) <= 230)) out.max = true;
  if (p.time.trim() && parseRace(p.time, p.dist) == null) out.time = true;
  return out;
}

function toPerson(p) {
  return {
    name: p.name.trim(),
    house: p.house,
    age: Number(p.age),
    maxHr: p.max ? Number(p.max) : null,
    race: p.time.trim() ? { dist: p.dist, secs: parseRace(p.time, p.dist) } : null,
  };
}

// Somebody whose armband lost the signal goes back in the queue, same lane,
// unless that lane already has somebody waiting.
function requeue(lane) {
  if (S.queue[lane.i].name.trim()) return false;
  const p = lane.person;
  S.queue[lane.i] = {
    name: p.name, house: p.house, age: String(p.age), max: p.maxHr ? String(p.maxHr) : '',
    dist: p.race?.dist || 1000, time: p.race?.secs ? mmss(p.race.secs) : '',
  };
  saveQueue();
  return true;
}

function openDrawer() {
  renderDrawer();
  $('drawer').hidden = false;
  const first = $('drawer-lanes').querySelector('input[data-f="name"]');
  if (first && !S.queue.some(p => p.name)) first.focus();
}
function closeDrawer() {
  $('drawer').hidden = true;
  renderStage();
  renderLanes();
}

function renderDrawer() {
  const choice = (attr, value, label, on) => `<button class="choice" ${attr}="${value}" aria-pressed="${on}">${label}</button>`;
  $('drawer-lanes').innerHTML = S.queue.map((p, i) => {
    const bad = problems(p);
    return `
      <div class="dl" data-lane="${i}">
        <div class="dl-head"><span class="lane-n">${i + 1}</span><strong>Lane ${i + 1}</strong><button class="link-btn" data-clear>Clear</button></div>
        <div><div class="label">First name</div><input class="input" data-f="name" maxlength="20" autocomplete="off" spellcheck="false" value="${esc(p.name)}" placeholder="Nobody in this lane"></div>
        <div><div class="label">House</div><div class="choices">${HOUSES.map(h => choice('data-house', h, h, p.house === h)).join('')}</div></div>
        <div class="row-3">
          <div><div class="label">Age</div><input class="input" data-f="age" inputmode="numeric" maxlength="2" autocomplete="off" value="${esc(p.age)}" aria-invalid="${!!bad.age}"></div>
          <div><div class="label">Max heart rate <small>Optional</small></div><input class="input" data-f="max" inputmode="numeric" maxlength="3" autocomplete="off" value="${esc(p.max)}" aria-invalid="${!!bad.max}"></div>
        </div>
        <div><div class="label">1 km or 800 m time <small>Optional</small></div>
          <div class="time-row"><div class="choices two">${choice('data-dist', 1000, '1 km', p.dist === 1000)}${choice('data-dist', 800, '800 m', p.dist === 800)}</div>
          <input class="input" data-f="time" autocomplete="off" value="${esc(p.time)}" placeholder="m:ss" aria-invalid="${!!bad.time}"></div>
        </div>
      </div>`;
  }).join('');
}

function bindDrawer() {
  const box = $('drawer-lanes');
  const laneOf = el => Number(el.closest('.dl').dataset.lane);
  const changed = i => {
    saveQueue();
    const bad = problems(S.queue[i]);
    const col = box.querySelector(`.dl[data-lane="${i}"]`);
    for (const f of ['age', 'max', 'time']) col.querySelector(`[data-f="${f}"]`).setAttribute('aria-invalid', String(!!bad[f]));
    renderStage();
    renderLanes();
  };
  box.addEventListener('input', e => {
    const f = e.target.dataset.f;
    if (!f) return;
    const i = laneOf(e.target);
    if (f === 'age' || f === 'max') e.target.value = e.target.value.replace(/\D/g, '');
    S.queue[i][f] = e.target.value;
    changed(i);
  });
  box.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const i = laneOf(b);
    const col = b.closest('.dl');
    if (b.dataset.house) {
      S.queue[i].house = b.dataset.house;
      col.querySelectorAll('[data-house]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    } else if (b.dataset.dist) {
      S.queue[i].dist = Number(b.dataset.dist);
      col.querySelectorAll('[data-dist]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    } else if (b.hasAttribute('data-clear')) {
      S.queue[i] = blankPerson();
      renderDrawer();
    }
    changed(i);
  });
}

/* ── The test ────────────────────────────────────────────── */

const runners = () => S.lanes.filter(l => l.t?.status === 'running');
const inRun = () => S.lanes.filter(l => l.t);

/** Whether the queued group can start, and if not, the one thing to fix. */
function readiness() {
  const people = S.queue.map((p, i) => ({ p, lane: S.lanes[i] })).filter(x => x.p.name.trim());
  if (!people.length) {
    // The one-person case: an armband is on, nobody is named yet. Point at
    // that lane rather than leaving the operator to guess which column to fill.
    const worn = S.lanes.find(l => l.source);
    return { ok: false, fix: 'drawer', lane: worn?.i ?? 0, note: 'Press Start to add who’s running.' };
  }
  const unfinished = people.find(x => Object.keys(problems(x.p)).length);
  if (unfinished) {
    const bad = problems(unfinished.p);
    const what = [bad.house && 'a house', bad.age && 'an age', bad.max && 'a max heart rate from 120 to 230', bad.time && 'a run time like 4:30']
      .filter(Boolean).join(' and ');
    return { ok: false, fix: 'drawer', lane: unfinished.lane.i, note: `${unfinished.p.name.trim()} in lane ${unfinished.lane.n} needs ${what}.` };
  }
  const noBand = people.find(x => !connected(x.lane));
  if (noBand) {
    const other = S.lanes.find(l => l.source && !S.queue[l.i].name.trim());
    return {
      ok: false, fix: 'armband', lane: noBand.lane.i,
      note: other
        ? `${noBand.p.name.trim()} is in lane ${noBand.lane.n}, but the armband is on lane ${other.n}.`
        : `Connect armband ${noBand.lane.n} for ${noBand.p.name.trim()}.`,
    };
  }
  const quiet = people.find(x => !fresh(x.lane));
  if (quiet) return { ok: false, fix: 'wait', lane: quiet.lane.i, note: `Waiting for lane ${quiet.lane.n}’s heart rate. Check the armband is snug against skin.` };
  return { ok: true, note: people.length === 1 ? 'One person ready.' : `${people.length} people ready.` };
}

function currentPhase() {
  const el = performance.now() - S.run.start;
  return S.run.phases.find(p => el < p.end) || S.run.phases[S.run.phases.length - 1];
}

function startRun() {
  if (S.run) return;
  const ready = readiness();
  if (!ready.ok) return fixReadiness(ready);
  const now = performance.now();
  S.run = { start: now, phases: timeline(), restExtra: 0, phase: null, lastSec: null, lastStep: null };
  for (const lane of S.lanes) {
    const p = S.queue[lane.i];
    if (!p.name.trim()) { lane.person = null; lane.t = null; continue; }
    lane.person = toPerson(p);
    lane.t = { samples: [], phases: S.run.phases, problem: null, sameSince: null, status: 'running', reason: null, rest: null, shownPeak: null };
    S.queue[lane.i] = blankPerson();
    // A demo visitor arrives a little out of breath, so rest sometimes runs on.
    if (lane.source === 'demo') { lane.demo.persona(); lane.demo.hr = lane.demo.rest + 6 + Math.random() * 18; }
  }
  saveQueue();
  S.group = null;
  if (!$('drawer').hidden) renderDrawer();
  renderStage();
  renderLanes();
  wake();
  chime([660, 880]);
}

// Start pressed before everything is in place: go to the thing that's missing.
function fixReadiness(r) {
  if (r.fix === 'drawer') {
    openDrawer();
    const col = $('drawer-lanes').querySelector(`.dl[data-lane="${r.lane}"]`);
    const p = S.queue[r.lane];
    const bad = problems(p);
    const field = !p.name.trim() ? 'name' : bad.age ? 'age' : bad.max ? 'max' : bad.time ? 'time' : null;
    if (field) col.querySelector(`[data-f="${field}"]`).focus();
    else col.querySelector('[data-house]').focus();
    return;
  }
  const lane = S.lanes[r.lane];
  flash(lane, r.fix === 'armband' ? `Connect armband ${lane.n} here.` : 'Waiting for a heartbeat.');
}

// Stopped by hand: nobody gets a result, and everybody goes back in the queue.
function stopRun() {
  if (!S.run) return;
  S.run = null;
  for (const lane of inRun()) { requeue(lane); lane.t = null; lane.person = null; }
  renderStage();
  renderLanes();
}

// Every reading during a test goes through here, so bad signal is caught as it happens.
function testSample(t, at, hr) {
  const prev = t.samples[t.samples.length - 1];
  t.samples.push({ t: at, hr });
  if (!prev) { t.sameSince = at; return; }
  if (Math.abs(hr - prev.hr) > JUMP_BPM && at - prev.t < 2500) t.problem ??= 'jump';
  if (hr !== prev.hr) t.sameSince = at;
  const limit = S.run.phase === 'rest' ? FREEZE_MS.rest : FREEZE_MS.other;
  if (at - t.sameSince > limit) t.problem ??= 'frozen';
}

function laneProblem(lane, el) {
  if (lane.source === 'ble' && !lane.device?.gatt?.connected) return 'disconnected';
  const last = lane.t.samples[lane.t.samples.length - 1];
  if (el - (last ? last.t : 0) > GAP_MS) return 'stalled';
  return lane.t.problem;
}

const LOST_WHY = {
  disconnected: 'The armband disconnected.',
  stalled: 'The heart rate stopped coming through.',
  frozen: 'The heart rate got stuck on one number.',
  jump: 'The heart rate jumped further than a heart can in a second.',
};

// Only this lane stops. Everybody else carries on to a result.
function laneLostSignal(lane, reason) {
  lane.t.status = 'lost';
  lane.t.reason = reason;
  lane.t.lostAt = performance.now() - S.run.start;
  beep(330, 0.35);
  renderLanes();
}

function updatePhaseUi() {
  const r = S.run;
  const ph = currentPhase();
  r.phase = ph.id;
  drawTrack(performance.now() - r.start);
  const settling = ph.id === 'rest' && r.restExtra > 0;
  $('stage').dataset.phase = ph.id;
  $('st-title').textContent = settling ? 'Almost there. Keep still' : ph.title;
  $('st-sub').textContent = settling ? 'Heart rates are still settling.' : ph.sub;
  $('t-label').textContent = ph.id === 'ready' ? 'get ready' : 'seconds';
  document.querySelectorAll('#st-track .seg').forEach(el => {
    const i = Number(el.dataset.step);
    el.dataset.state = i < ph.step ? 'done' : i === ph.step ? 'now' : 'next';
  });
}

// Called every frame while a test is running.
function tickRun(now) {
  const r = S.run;
  const el = now - r.start;

  for (const lane of runners()) {
    const problem = laneProblem(lane, el);
    if (problem) laneLostSignal(lane, problem);
  }
  if (!runners().length) return finishRun();

  if (el >= testEnd(r)) {
    if (el >= testEnd(r) + FINISH_WAIT) return finishRun();
    $('t-num').textContent = '0';
    return;
  }

  let ph = currentPhase();

  // End of rest: if anybody's heart rate is still clearly falling, give it a few more seconds.
  if (r.phase === 'rest' && ph.id !== 'rest' && r.restExtra < SETTLE_MAX && runners().some(l => stillDropping(l.t))) {
    r.restExtra += SETTLE_STEP;
    r.phases = timeline(r.restExtra);
    for (const lane of inRun()) lane.t.phases = r.phases;
    ph = currentPhase();
    updatePhaseUi();
  }

  if (ph.id !== r.phase) {
    if (r.phase === 'rest') for (const lane of runners()) lane.t.rest = restingFrom(lane.t);
    updatePhaseUi();
    renderLanes();
    if (ph.id !== 'exercise') chime([660, 880]);
  }

  const left = ph.end - el;
  const sec = Math.ceil(left / 1000);
  drawTrack(el);
  if (sec !== r.lastSec) {
    r.lastSec = sec;
    $('t-num').textContent = sec;
    const box = $('t-count');
    box.dataset.urgent = 'false';
    if (sec <= 3) { void box.offsetWidth; box.dataset.urgent = 'true'; beep(520, 0.09); }
  }
}

// One bar across the stage for the whole test, in three parts sized by how long
// each lasts. "Get ready" belongs to high knees, as it does in the steps.
function drawTrack(el) {
  const ph = S.run.phases;
  const parts = [[ph[0]], [ph[1], ph[2]], [ph[3]]];
  document.querySelectorAll('#st-track .seg').forEach((seg, i) => {
    const start = parts[i][0].start, end = parts[i][parts[i].length - 1].end;
    seg.style.flexGrow = String(end - start);
    seg.querySelector('b').style.width = `${clamp((el - start) / (end - start), 0, 1) * 100}%`;
  });
}

function finishRun() {
  const r = S.run;
  S.run = null;

  // Every group is a heat, numbered through the day, and every result gets a
  // running number. Both go on the receipt, so a stack of them reads like a meet.
  const heat = (S.prefs.heat || 0) + 1;
  S.prefs.heat = heat;
  savePrefs();

  const members = inRun().map(lane => {
    const res = lane.t.status === 'running' ? results(lane.t) : null;
    const base = { lane: lane.n, person: lane.person };
    if (!res) {
      return { ...base, lost: true, reason: lane.t.reason || 'stalled', requeued: requeue(lane) };
    }
    const rid = crypto.getRandomValues(new Uint8Array(6));
    const entry = {
      id: Array.from(rid, b => b.toString(16).padStart(2, '0')).join(''),
      at: Date.now(),
      lane: lane.n,
      heat,
      no: S.entries.length + 1,
      ...lane.person,
      rest: res.rest, peak: res.peak, endHr: res.endHr, recHr: res.recHr, drop: res.drop, beats: res.beats,
    };
    S.entries.push(entry);
    S.freshId = entry.id;
    return { ...base, rid, report: { entry, samples: lane.t.samples, marks: res.marks, phases: r.phases } };
  });
  saveEntries();
  for (const lane of S.lanes) { lane.t = null; lane.person = null; }

  // Places, once everyone in the heat is in: within the heat, and among
  // everybody tested today. The link is made last so it carries them.
  const finished = members.filter(m => m.report).sort((a, b) => b.report.entry.drop - a.report.entry.drop);
  const today = new Date().toDateString();
  const day = S.entries.filter(x => new Date(x.at).toDateString() === today);
  finished.forEach((m, i) => {
    const e = m.report.entry;
    e.heatRank = i + 1;
    e.heatSize = finished.length;
    e.dayRank = 1 + day.filter(x => x.drop > e.drop).length;
    e.dayCount = day.length;
    e.code = encodeResult({ ...e, id: m.rid, club: CLUB, samples: m.report.samples, phases: r.phases });
  });
  saveEntries();
  S.group = { members };
  const done = members.filter(m => m.report);
  if (members.length === 1 && done.length === 1) openReport(done[0].report, false);
  else { renderGroup(); show('group'); }
  armReportTimeout();
  chime([660, 880, 1100]);
  if (!$('drawer').hidden) renderDrawer();
  if (S.prefs.autoPrint && done.length) printReports(done.map(m => m.report));
}

/* ── Stage and lanes on screen ───────────────────────────── */

const IDLE_TITLE = 'How fast does your heart recover?';
const IDLE_SUB = 'Up to three at once. Sit still, a minute of high knees, then see how far your heart rate drops in the next minute.';

function renderStage() {
  const running = !!S.run;
  $('st-track').hidden = !running;
  $('st-idle').hidden = running;
  $('st-run').hidden = !running;
  if (running) return updatePhaseUi();
  $('stage').dataset.phase = '';
  $('st-title').textContent = IDLE_TITLE;
  $('st-sub').textContent = IDLE_SUB;
  updateReadiness();
}

let readyKey = '';
function updateReadiness() {
  const r = readiness();
  const key = `${r.ok}|${r.note}`;
  if (key === readyKey) return;
  readyKey = key;
  $('st-start').dataset.ready = String(r.ok);
  $('st-note').textContent = r.note;
  $('st-note').dataset.ready = String(r.ok);
}

function buildLanes() {
  const box = $('lanes');
  box.innerHTML = '';
  for (const lane of S.lanes) {
    const el = document.createElement('article');
    el.className = 'card lane';
    el.innerHTML = `
      <div class="lane-empty">
        <span class="lane-n">${lane.n}</span>
        <p class="lane-empty-who"></p>
        <button class="btn" data-connect>Connect armband ${lane.n}</button>
        <p class="lane-note"></p>
      </div>
      <header class="lane-head">
        <span class="lane-n">${lane.n}</span>
        <div class="lane-who"><span class="lane-name"></span><span class="lane-house"></span></div>
        <div class="lane-tools"><span class="lane-dev"></span><button class="lane-x" data-drop title="Disconnect this armband">×</button></div>
      </header>
      <div class="lane-hr">
        <div class="lane-bpm"><span class="hr" data-empty="true">--</span><span class="unit">bpm</span></div>
        <div class="lane-stats" hidden>
          <div data-s1><div class="k"></div><div class="v"></div></div>
          <div data-s2><div class="k"></div><div class="v"></div></div>
        </div>
      </div>
      <div class="lane-chart"><canvas></canvas></div>
      <div class="lane-msg" hidden><strong></strong><span></span></div>`;
    el.querySelector('[data-connect]').addEventListener('click', () => connectLane(lane));
    el.querySelector('[data-drop]').addEventListener('click', () => { dropArmband(lane); renderLanes(); });
    box.append(el);
    lane.ui = {
      el,
      empty: el.querySelector('.lane-empty'),
      emptyWho: el.querySelector('.lane-empty-who'),
      note: el.querySelector('.lane-note'),
      parts: [el.querySelector('.lane-head'), el.querySelector('.lane-hr'), el.querySelector('.lane-chart')],
      name: el.querySelector('.lane-name'),
      house: el.querySelector('.lane-house'),
      dev: el.querySelector('.lane-dev'),
      hr: el.querySelector('.hr'),
      stats: el.querySelector('.lane-stats'),
      s1: el.querySelector('[data-s1]'),
      s2: el.querySelector('[data-s2]'),
      msg: el.querySelector('.lane-msg'),
      msgTitle: el.querySelector('.lane-msg strong'),
      msgBody: el.querySelector('.lane-msg span'),
    };
    lane.chart = makeChart(el.querySelector('canvas'));
  }
}

/** Who a lane shows: the person running in it, or else the one queued for it. */
function laneWho(lane) {
  if (S.run) return lane.person;
  const q = S.queue[lane.i];
  return q.name.trim() ? { name: q.name.trim(), house: q.house } : null;
}

function renderLanes() {
  for (const lane of S.lanes) {
    const u = lane.ui;
    const has = lane.source !== null;
    const who = laneWho(lane);
    u.empty.hidden = has;
    u.parts.forEach(p => { p.hidden = !has; });
    u.note.textContent = lane.note;
    u.emptyWho.textContent = who ? `${who.name} is up next in this lane.` : 'Put on armband ' + lane.n + ', then connect it.';

    u.name.textContent = who ? who.name : S.run ? 'Sitting this one out' : 'Free lane';
    u.name.classList.toggle('empty', !who);
    u.house.textContent = who?.house || '';
    u.dev.textContent = lane.source === 'demo' ? 'Demo' : shortDevice(lane.device?.name);
    u.el.querySelector('[data-drop]').hidden = lane.source !== 'ble' || !!lane.t;
    u.stats.hidden = !lane.t;
    u.el.dataset.state = !lane.t ? (S.run ? 'out' : 'idle') : lane.t.status;
    laneMessage(lane);
  }
  updateStatus();
  if (!S.run) updateReadiness();
}

// "COROS HEART RATE 14FA76" → "Coros 14FA76". Enough to match the sticker,
// without a shouting model name on every lane.
function shortDevice(name) {
  if (!name) return '';
  const words = name.trim().split(/\s+/);
  if (name === name.toUpperCase()) {
    const brand = words[0].charAt(0) + words[0].slice(1).toLowerCase();
    const id = words.length > 1 && /^[0-9A-F]{4,}$/.test(words[words.length - 1]) ? ` ${words[words.length - 1]}` : '';
    return brand + id;
  }
  return name.length > 16 ? `${name.slice(0, 15)}…` : name;
}

/**
 * The two small numbers beside a lane's heart rate follow the test: resting
 * while sitting, resting and peak while moving, then during recovery where
 * they finished and how far they've come down, live, so a group can watch
 * each other's numbers drop.
 */
function laneStats(lane) {
  const t = lane.t;
  const ex = phaseOf(t, 'exercise');
  let a = ['Resting', t.rest?.hr ?? '--'], b = null;
  if (S.run.phase === 'exercise' || S.run.phase === 'ready') {
    const moving = t.samples.filter(s => s.t >= ex.start).map(s => s.hr);
    b = ['Peak', moving.length ? Math.max(...moving) : '--'];
  }
  if (S.run.phase === 'recover' || (!S.run.phase && t.samples.length)) {
    const finish = hrAt(t.samples, ex.end);
    if (finish != null) {
      a = ['Finish', Math.round(finish)];
      const down = fresh(lane) && t.status === 'running' ? Math.round(finish) - lane.lastHr : null;
      b = ['Down', down == null ? '--' : down];
    }
  }
  return [a, b];
}

function setStat(slot, pair) {
  slot.hidden = !pair;
  if (!pair) return;
  const [k, v] = [slot.firstElementChild, slot.lastElementChild];
  if (k.textContent !== pair[0]) k.textContent = pair[0];
  if (v.textContent !== String(pair[1])) v.textContent = String(pair[1]);
  slot.dataset.key = pair[0];
}

function laneMessage(lane) {
  const u = lane.ui;
  let title = '', body = '';
  if (lane.t?.status === 'lost') {
    title = 'Signal lost, try again';
    body = `${LOST_WHY[lane.t.reason] || ''} Check the armband is snug on the upper arm.`;
  } else if (lane.source && !fresh(lane) && (!S.run || lane.t)) {
    title = 'Looking for a heartbeat…';
    body = 'Make sure the armband is snug against skin.';
  }
  u.msg.hidden = !title;
  if (u.msgTitle.textContent !== title) u.msgTitle.textContent = title;
  if (u.msgBody.textContent !== body) u.msgBody.textContent = body;
}

/* ── Head to head ────────────────────────────────────────── */

function renderGroup() {
  const members = S.group.members;
  const done = members.filter(m => m.report).sort((a, b) => b.report.entry.drop - a.report.entry.drop);
  const lost = members.filter(m => !m.report);
  const heat = done[0]?.report.entry.heat;
  $('g-title').textContent = heat ? `Heat ${heat}` : 'Results';
  $('group-list').style.setProperty('--cols', String(Math.max(1, done.length + lost.length)));

  $('group-list').innerHTML = [
    ...done.map((m, i) => {
      const e = m.report.entry;
      return `
        <button class="h2h${i === 0 && done.length > 1 ? ' first' : ''}" data-lane="${m.lane}">
          <div class="h2h-top"><span class="h2h-rank">${ordinal(i + 1)}</span><span class="lane-n">${m.lane}</span></div>
          <div class="h2h-name">${esc(e.name)}</div>
          <div class="h2h-house">${esc(e.house)}</div>
          <div class="h2h-num">${e.drop}<small>bpm</small></div>
          <div class="h2h-label">Recovery in 60 seconds</div>
          <div class="h2h-path">${e.endHr} → ${e.recHr}</div>
          ${miniCurve(m.report)}
          <div class="h2h-foot"><span>Resting ${e.rest} · Peak ${e.peak}</span><span class="h2h-open">Full result →</span></div>
        </button>`;
    }),
    ...lost.map(m => `
      <div class="h2h lost">
        <div class="h2h-top"><span class="h2h-rank">–</span><span class="lane-n">${m.lane}</span></div>
        <div class="h2h-name">${esc(m.person.name)}</div>
        <div class="h2h-house">${esc(m.person.house)}</div>
        <div class="h2h-lost"><strong>Signal lost, try again</strong><span>${m.requeued ? `Back in the next group, lane ${m.lane}.` : LOST_WHY[m.reason] || ''}</span></div>
      </div>`),
  ].join('');
  $('g-print-note').textContent = '';
}

// A person's whole test as one small line, the high-knees stretch shaded.
function miniCurve(rep) {
  const w = 300, h = 90;
  const end = rep.phases[rep.phases.length - 1].end;
  const hrs = rep.samples.map(s => s.hr);
  const lo = Math.min(...hrs) - 5, hi = Math.max(...hrs) + 5;
  const xy = rep.samples.filter(s => s.t <= end).map(s => [(s.t / end) * w, h - ((s.hr - lo) / (hi - lo)) * h]);
  const path = svgPath();
  if (xy.length > 1) smoothPath(path, xy);
  const ex = rep.phases.find(p => p.id === 'exercise');
  return `<svg class="h2h-curve" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <rect x="${(ex.start / end) * w}" y="0" width="${((ex.end - ex.start) / end) * w}" height="${h}" class="band"/>
    <path d="${path.d}" fill="none" stroke="currentColor" stroke-width="3" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
  </svg>`;
}

function openReport(rep, fromGroup) {
  S.report = rep;
  S.reportFromGroup = fromGroup;
  renderReport();
  $('r-back').hidden = !fromGroup;
  show('report');
}

let printingAll = false;
async function printReports(reports) {
  if (printingAll) return;
  printingAll = true;
  const note = $('g-print-note');
  const failed = [];
  for (const [i, rep] of reports.entries()) {
    note.textContent = reports.length > 1 ? `Printing ${i + 1} of ${reports.length}…` : 'Printing…';
    const r = await printReceipt(rep).catch(err => ({ ok: false, error: err.message }));
    if (!r.ok) failed.push(`${rep.entry.name}: ${r.error}`);
  }
  note.textContent = failed.length ? `Couldn’t print ${failed.join('; ')}` : reports.length > 1 ? `Printed ${reports.length} receipts` : 'Printed';
  printingAll = false;
}

/* ── Measuring ───────────────────────────────────────────── */

function restWindow(t) {
  const end = phaseOf(t, 'rest').end;
  return t.samples.filter(s => s.t >= end - REST_WINDOW && s.t <= end);
}

// Least-squares slope of the rest window, in bpm per second.
function stillDropping(t) {
  const w = restWindow(t);
  if (w.length < 5) return false;
  const n = w.length;
  const mx = w.reduce((a, s) => a + s.t, 0) / n, my = w.reduce((a, s) => a + s.hr, 0) / n;
  let num = 0, den = 0;
  for (const s of w) { num += (s.t - mx) * (s.hr - my); den += (s.t - mx) ** 2; }
  return den > 0 && (num / den) * 1000 < SETTLE_SLOPE;
}

function restingFrom(t) {
  const w = restWindow(t);
  if (w.length < 3) return null;
  const end = phaseOf(t, 'rest').end;
  return { hr: Math.round(w.reduce((a, s) => a + s.hr, 0) / w.length), t: end - REST_WINDOW / 2 };
}

// Heart rate at an exact moment, read between the readings either side of it.
function hrAt(samples, at) {
  let before = null, after = null;
  for (const s of samples) {
    if (s.t <= at) before = s;
    else { after = s; break; }
  }
  if (before && after && after.t - before.t <= 4000) {
    return before.hr + (after.hr - before.hr) * (at - before.t) / (after.t - before.t);
  }
  const near = [before, after].filter(s => s && Math.abs(s.t - at) <= 1500);
  return near.length ? near[0].hr : null;
}

let printing = false;
async function printNow() {
  if (!S.report || printing) return;
  printing = true;
  const b = $('r-print');
  b.disabled = true;
  b.textContent = 'Printing…';
  const r = await printReceipt(S.report).catch(err => ({ ok: false, error: err.message }));
  printing = false;
  b.disabled = false;
  b.textContent = r.ok ? 'Print again' : 'Try printing again';
  $('r-print-note').textContent = r.ok ? '' : `Couldn’t print: ${r.error}`;
}

// Recovery = heart rate the moment high knees end, minus heart rate exactly
// 60 seconds later. Peak is shown alongside but not scored.
function results(t) {
  const s = t.samples;
  const ex = phaseOf(t, 'exercise');
  const rest = restingFrom(t);
  const end = hrAt(s, ex.end);
  const later = hrAt(s, ex.end + 60000);
  const moving = s.filter(x => x.t >= ex.start && x.t <= ex.end + 60000);
  if (!rest || end == null || later == null || !moving.length) return null;

  const endHr = Math.round(end), recHr = Math.round(later);
  const peakS = moving.reduce((a, b) => (b.hr > a.hr ? b : a));
  const marks = [
    { t: rest.t, hr: rest.hr, label: `Resting ${rest.hr}` },
    { t: ex.end, hr: endHr, label: `Finish ${endHr}` },
    { t: ex.end + 60000, hr: recHr, label: `60 s later ${recHr}`, below: true },
  ];
  if (peakS.hr > endHr + 1 && Math.abs(peakS.t - ex.end) > 8000) marks.push({ t: peakS.t, hr: peakS.hr, label: `Peak ${peakS.hr}` });
  // How many times the heart beat over the whole test: bpm summed over time.
  let beats = 0;
  for (let i = 1; i < s.length; i++) {
    const dt = s[i].t - s[i - 1].t;
    if (dt > 0 && dt < 5000) beats += ((s[i].hr + s[i - 1].hr) / 2) * dt / 60000;
  }
  return { rest: rest.hr, peak: peakS.hr, endHr, recHr, drop: endHr - recHr, beats: Math.round(beats), marks };
}

/* ── Zones and pace ──────────────────────────────────────── */

// Zones from heart rate reserve (Karvonen): personal to both resting and max.
// Max is what they told us, or estimated from age (Tanaka) if they didn't say.
function zonesFor(age, rest, known) {
  const max = known || Math.round(208 - 0.7 * age);
  const reserve = Math.max(20, max - rest);
  const pct = [0.5, 0.6, 0.7, 0.8, 0.9, 1];
  const names = ['Very easy', 'Easy', 'Steady', 'Hard', 'Max'];
  return {
    max,
    estimated: !known,
    zones: names.map((name, i) => ({
      n: i + 1,
      name,
      lo: Math.round(rest + reserve * pct[i]),
      hi: i === 4 ? max : Math.round(rest + reserve * pct[i + 1]) - 1,
    })),
  };
}

// Daniels' running formula: oxygen cost of running at v m/min, and the share
// of max that can be held for t minutes. Only used with a real run time.
const vo2At = v => -4.6 + 0.182258 * v + 0.000104 * v * v;
const speedFor = vo2 => { const a = 0.000104, b = 0.182258, c = -(vo2 + 4.6); return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a); };
const fracFor = min => 0.8 + 0.1894393 * Math.exp(-0.012778 * min) + 0.2989558 * Math.exp(-0.1932605 * min);

function paceFor(race) {
  if (!race?.secs) return null;
  const min = race.secs / 60;
  const vdot = clamp(vo2At(race.dist / min) / fracFor(min), 25, 80);
  // Easy running sits around 62–70% of that.
  const secPerKm = f => 60000 / speedFor(vdot * f);
  const round5 = s => Math.round(s / 5) * 5;
  return { fast: round5(secPerKm(0.70)), slow: round5(secPerKm(0.62)) };
}

const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const range = (lo, hi) => `${lo}⁠–⁠${hi}`;

/* ── Report ──────────────────────────────────────────────── */

const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

function rankNote(e) {
  const order = ranked();
  const i = order.findIndex(x => x.id === e.id);
  const where = i < 0 ? 'not on the leaderboard' : `${ordinal(i + 1)} of ${order.length}`;
  return `${e.endHr} → ${e.recHr} bpm · ${where}`;
}

function renderReport() {
  const { entry: e } = S.report;

  $('r-name').textContent = `Nice work, ${e.name}`;
  $('r-meta').textContent = `${e.house} · Age ${e.age}`;
  $('r-rest').textContent = e.rest;
  $('r-peak').textContent = e.peak;
  $('r-drop').textContent = e.drop;
  $('r-drop-note').textContent = rankNote(e);

  const { max, estimated, zones } = zonesFor(e.age, e.rest, e.maxHr);
  $('r-zones').innerHTML = zones.map(z => `
    <div class="zone${z.n === 2 ? ' is-easy' : ''}">
      <span class="n">${z.n}</span><span>${z.name}</span><span class="range">${range(z.lo, z.hi)}</span>
    </div>`).join('');
  $('r-zone-basis').textContent = estimated
    ? `Max ${max}, estimated from your age.`
    : `Max ${max}, as you entered.`;

  const z2 = zones[1];
  const p = paceFor(e.race);
  if (p) {
    $('r-guide-title').firstChild.textContent = 'Easy run pace ';
    $('r-guide').innerHTML = `${mmss(p.fast)}–${mmss(p.slow)}<small>/km</small>`;
    $('r-guide-note').textContent = `Slow enough to talk in full sentences, around ${range(z2.lo, z2.hi)} bpm.`;
    $('r-guide-basis').textContent = `From your ${e.race.dist === 800 ? '800 m' : '1 km'} time of ${mmss(e.race.secs)}.`;
  } else {
    $('r-guide-title').firstChild.textContent = 'Easy runs ';
    $('r-guide').innerHTML = `${range(z2.lo, z2.hi)}<small>bpm</small>`;
    $('r-guide-note').textContent = 'Any pace that keeps you here. You should be able to talk.';
    $('r-guide-basis').textContent = 'Your zone 2. A 1 km or 800 m time gives a pace.';
  }
  renderQr(e);
  $('r-print').textContent = 'Print again';
  $('r-print-note').textContent = '';
}

let reportTimer = null;
function armReportTimeout() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => {
    if (S.view !== 'report') return;
    S.report = null;
    show('live');
  }, 180000);
}

// For a bad reading (strap slipped, someone wandered off): operator menu only.
function removeLast() {
  const e = S.entries.find(x => x.id === S.freshId);
  if (!e) return;
  S.entries = S.entries.filter(x => x !== e);
  saveEntries();
  S.freshId = null;
  refreshMenu();
  if (S.view === 'report' && S.report?.entry.id === e.id) $('r-drop-note').textContent = rankNote(e);
  if (S.view === 'board') renderBoard();
}

function renderQr(entry) {
  $('r-qr').innerHTML = qrSvg(resultUrl(entry));
}

/* ── Leaderboard ─────────────────────────────────────────── */

function renderBoard() {
  const rows = ranked();
  const box = $('board');
  if (!rows.length) {
    box.innerHTML = '<div class="board-empty">No results yet. The first person to finish the test goes here.</div>';
    return;
  }
  box.innerHTML = `
    <div class="board-row head"><span>#</span><span>Name</span><span class="sm">Resting</span><span class="sm">Peak</span><span class="sm">Recovery</span></div>
    ${rows.map((e, i) => `
      <div class="board-row${i < 3 ? ' top' : ''}${e.id === S.freshId ? ' fresh' : ''}">
        <span class="rank">${i + 1}</span>
        <span class="who"><span>${esc(e.name)}</span><span class="house">${esc(e.house)}</span></span>
        <span class="sm">${e.rest}</span>
        <span class="sm">${e.peak}</span>
        <span class="drop">${e.drop}<small>bpm</small></span>
      </div>`).join('')}`;
}

function exportCsv() {
  const head = ['name', 'house', 'age', 'resting_bpm', 'peak_bpm', 'finish_bpm', 'after_60s_bpm', 'recovery_bpm', 'max_hr', 'max_hr_source', 'race_distance_m', 'race_time', 'time'];
  const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const lines = ranked().map(e => [
    e.name, e.house, e.age, e.rest, e.peak, e.endHr, e.recHr, e.drop,
    e.maxHr || Math.round(208 - 0.7 * e.age), e.maxHr ? 'entered' : 'estimated',
    e.race?.dist ?? '', e.race?.secs ? mmss(e.race.secs) : '', new Date(e.at).toISOString(),
  ].map(q).join(','));
  const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pacer-hr-booth-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ── Chart ───────────────────────────────────────────────── */

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

let palette = null;
function readPalette() {
  const content = cssVar('--content');
  const dark = content.toLowerCase() === '#fff' || content.toLowerCase() === '#ffffff';
  palette = {
    content,
    rgb: dark ? '255,255,255' : '0,0,0',
    muted: cssVar('--content-muted'),
    subtle: cssVar('--content-subtle'),
    line: cssVar('--line'),
    lineStrong: cssVar('--line-strong'),
    band: cssVar('--band'),
    raised: cssVar('--surface-raised'),
    font: getComputedStyle(document.body).fontFamily,
  };
}

function makeChart(canvas) {
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, dpr = 1;
  let yLo = 50, yHi = 130;
  let marksDrawn = false;

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    w = r.width; h = r.height;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
  }
  new ResizeObserver(resize).observe(canvas);

  // o: { samples, x0, x1, at, phases?, current?, marks?, snap?, head? }
  function draw(o) {
    if (!w || !h) return;
    const P = palette;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    // `bare`: a lane's small chart. The stage already says which part of the
    // test this is, so no phase labels, and fewer, quieter lines.
    const pad = o.bare
      ? { t: rem * 0.6, r: rem * 2.4, b: rem * 0.6, l: rem * 0.25 }
      : { t: rem * (o.compact ? 2.2 : 3.2), r: rem * 3, b: rem * 0.9, l: rem * 0.25 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Points up to the render time, plus one interpolated head at exactly that time.
    const pts = [];
    const S0 = o.samples;
    for (let i = 0; i < S0.length; i++) {
      const s = S0[i];
      if (s.t > o.at) {
        const prev = S0[i - 1];
        if (prev) {
          const k = (o.at - prev.t) / (s.t - prev.t);
          pts.push({ t: o.at, hr: prev.hr + (s.hr - prev.hr) * k });
        }
        break;
      }
      if (s.t >= o.x0 - 3000) pts.push(s);
    }

    // Y range follows the data, eased so it breathes rather than snaps.
    let lo = 60, hi = 120;
    if (pts.length) {
      const hrs = pts.map(p => p.hr);
      lo = Math.min(...hrs) - 12; hi = Math.max(...hrs) + 12;
      if (o.marks) { lo = Math.min(lo, ...o.marks.map(m => m.hr) ) - 4; hi = Math.max(hi, ...o.marks.map(m => m.hr)) + 14; }
      if (hi - lo < 60) { const mid = (hi + lo) / 2; lo = mid - 30; hi = mid + 30; }
      lo = Math.floor(lo / 10) * 10; hi = Math.ceil(hi / 10) * 10;
    }
    if (o.snap) { yLo = lo; yHi = hi; }
    else { yLo += (lo - yLo) * 0.06; yHi += (hi - yHi) * 0.06; }

    const X = t => pad.l + ((t - o.x0) / (o.x1 - o.x0)) * pw;
    const Y = v => pad.t + (1 - (v - yLo) / (yHi - yLo)) * ph;

    // Phases of the test, laid out ahead of time so people can see what's coming.
    if (o.phases) {
      ctx.font = `500 ${rem * 0.85}px ${P.font}`;
      ctx.textBaseline = 'alphabetic';
      o.phases.forEach((p, i) => {
        const a = X(p.start), b = X(p.end);
        const top = o.bare ? pad.t : pad.t - rem * 1.3;
        if (p.id === 'exercise') { ctx.fillStyle = P.band; ctx.fillRect(a, top, b - a, ph + pad.t - top); }
        if (o.bare) return;
        const now = o.current === p.id;
        ctx.fillStyle = now ? P.content : P.subtle;
        ctx.font = `${now ? 650 : 500} ${rem * 0.85}px ${P.font}`;
        if (b - a > rem * 3) ctx.fillText(p.label, a + rem * 0.6, pad.t - rem * 0.4);
      });
    }

    // Grid
    const span = yHi - yLo;
    const step = o.bare ? (span > 110 ? 40 : 20) : span > 140 ? 40 : span > 70 ? 20 : 10;
    ctx.font = `500 ${rem * 0.8}px ${P.font}`;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let v = Math.ceil(yLo / step) * step; v <= yHi; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      if (y < pad.t - 2 || y > pad.t + ph + 2) continue;
      ctx.strokeStyle = P.line;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
      ctx.fillStyle = P.subtle;
      ctx.fillText(String(v), pad.l + pw + rem * 0.6, y);
    }

    if (pts.length < 2) return;
    const xy = pts.map(p => [X(p.t), Y(p.hr)]);

    // Area, then line
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
    grad.addColorStop(0, `rgba(${P.rgb},.10)`);
    grad.addColorStop(1, `rgba(${P.rgb},0)`);
    ctx.save();
    ctx.beginPath(); ctx.rect(pad.l, pad.t - rem, pw, ph + rem); ctx.clip();
    ctx.beginPath();
    smoothPath(ctx, xy);
    ctx.lineTo(xy[xy.length - 1][0], pad.t + ph);
    ctx.lineTo(xy[0][0], pad.t + ph);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    smoothPath(ctx, xy);
    ctx.strokeStyle = P.content;
    ctx.lineWidth = rem * 0.2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();

    if (o.head) {
      const [hx, hy] = xy[xy.length - 1];
      ctx.beginPath(); ctx.arc(hx, hy, rem * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = P.raised; ctx.fill();
      ctx.beginPath(); ctx.arc(hx, hy, rem * 0.36, 0, Math.PI * 2);
      ctx.fillStyle = P.content; ctx.fill();
    }

    if (o.marks) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      for (const m of o.marks) {
        const x = X(m.t), y = Y(m.hr);
        ctx.beginPath(); ctx.arc(x, y, rem * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = P.raised; ctx.fill();
        ctx.lineWidth = rem * 0.17; ctx.strokeStyle = P.content; ctx.stroke();
        ctx.font = `650 ${rem * 0.95}px ${P.font}`;
        const tw = ctx.measureText(m.label).width;
        const lx = clamp(x, pad.l + tw / 2, pad.l + pw - tw / 2), ly = m.below ? y + rem * 1.75 : y - rem * 0.95;
        ctx.lineWidth = rem * 0.4; ctx.lineJoin = 'round'; ctx.strokeStyle = P.raised;
        ctx.strokeText(m.label, lx, ly);
        ctx.fillStyle = P.content;
        ctx.fillText(m.label, lx, ly);
      }
      ctx.textAlign = 'start';
    }
  }

  return { draw, resize };
}

// Monotone cubic through the points: smooth, but never overshoots a reading.
function smoothPath(ctx, p) {
  const n = p.length;
  ctx.moveTo(p[0][0], p[0][1]);
  if (n === 2) { ctx.lineTo(p[1][0], p[1][1]); return; }
  const dx = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = p[i + 1][0] - p[i][0];
    m[i] = dx[i] ? (p[i + 1][1] - p[i][1]) / dx[i] : 0;
  }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    ctx.bezierCurveTo(p[i][0] + h, p[i][1] + t[i] * h, p[i + 1][0] - h, p[i + 1][1] - t[i + 1] * h, p[i + 1][0], p[i + 1][1]);
  }
}

const reportChart = makeChart($('r-chart'));

/* ── Frame loop ──────────────────────────────────────────── */

let statusKey = '';
function updateStatus() {
  const bands = S.lanes.filter(l => l.source);
  const live = bands.filter(l => connected(l) && fresh(l));
  let state = 'off', text = 'No armbands';
  if (bands.length) {
    state = live.length === bands.length ? 'live' : 'waiting';
    const what = S.demo && bands.every(l => l.source === 'demo') ? 'demo armband' : 'armband';
    text = live.length === bands.length
      ? `${bands.length} ${what}${bands.length === 1 ? '' : 's'}`
      : `${live.length} of ${bands.length} ${what}s live`;
  }
  const key = state + text;
  if (key === statusKey) return;
  statusKey = key;
  $('status').dataset.state = state;
  $('status-text').textContent = text;
}

let slow = 0;
function frame() {
  const now = performance.now();
  if (S.run) tickRun(now);

  if (S.view === 'live') {
    const at = now - RENDER_DELAY;
    for (const lane of S.lanes) {
      if (!lane.source) continue;
      const u = lane.ui;
      const ok = fresh(lane) && lane.t?.status !== 'lost';
      const text = ok ? String(lane.lastHr) : '--';
      if (u.hr.textContent !== text) { u.hr.textContent = text; u.hr.dataset.empty = String(!ok); }
      if (lane.t && S.run) {
        const t = lane.t;
        const until = t.status === 'lost' ? t.lostAt : at - S.run.start;
        const [a, b] = laneStats(lane);
        setStat(u.s1, a);
        setStat(u.s2, b);
        lane.chart.draw({
          samples: t.samples, x0: 0, x1: testEnd(S.run), at: until,
          phases: S.run.phases, current: S.run.phase, head: t.status === 'running', bare: true,
        });
      } else {
        lane.chart.draw({ samples: lane.samples, x0: at - 60000, x1: at, at, head: true, bare: true });
      }
    }
    // Twice a second is plenty for words.
    if (now - slow > 500) {
      slow = now;
      S.lanes.forEach(laneMessage);
      updateStatus();
      if (!S.run) updateReadiness();
    }
  } else if (S.view === 'report' && S.report) {
    reportChart.draw({
      samples: S.report.samples,
      x0: 0, x1: S.report.phases[S.report.phases.length - 1].end, at: Infinity,
      phases: S.report.phases,
      marks: S.report.marks,
      snap: true,
      compact: true,
    });
  }
  requestAnimationFrame(frame);
}

/* ── Sound, wake lock, full screen ───────────────────────── */

let audio = null;
function beep(freq, dur, when = 0, level = 0.18) {
  if (!S.prefs.sound) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    const t0 = audio.currentTime + when;
    const osc = audio.createOscillator(), g = audio.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(audio.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  } catch {}
}
function chime(freqs) { freqs.forEach((f, i) => beep(f, 0.22, i * 0.13)); }

let lock = null;
async function wake() {
  try { if (!lock && 'wakeLock' in navigator) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.lanes.some(l => l.source)) wake(); });

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  $('fs-enter').hidden = on;
  $('fs-exit').hidden = !on;
});

/* ── Menu ────────────────────────────────────────────────── */

function refreshMenu() {
  const last = S.entries.find(x => x.id === S.freshId);
  $('m-undo').disabled = !last;
  $('m-undo').style.opacity = last ? '' : '.4';
  $('m-undo-hint').textContent = last ? last.name : 'None';
  $('m-drop').hidden = !S.demo;
  $('m-preview').disabled = !S.report;
  $('m-preview').style.opacity = S.report ? '' : '.4';
  disarmReset();
}

function setMenu(open) {
  if (open) refreshMenu();
  $('menu').hidden = !open;
  $('btn-menu').setAttribute('aria-expanded', String(open));
  if (!open) disarmReset();
}

function applyTheme() {
  const t = S.prefs.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
  readPalette();
  $('m-dark').setAttribute('aria-checked', String(palette.rgb === '255,255,255'));
}

let resetTimer = null;
function disarmReset() {
  clearTimeout(resetTimer);
  $('m-reset').dataset.armed = 'false';
  $('m-reset-hint').textContent = S.entries.length ? `${S.entries.length} results` : '';
}
function resetBoard() {
  const b = $('m-reset');
  if (b.dataset.armed !== 'true') {
    b.dataset.armed = 'true';
    $('m-reset-hint').textContent = 'Click again to confirm';
    clearTimeout(resetTimer);
    resetTimer = setTimeout(disarmReset, 4000);
    return;
  }
  S.entries = [];
  saveEntries();
  disarmReset();
  $('m-reset-hint').textContent = 'Cleared';
  if (S.view === 'board') renderBoard();
}

/* ── Wiring ──────────────────────────────────────────────── */

function init() {
  load();
  applyTheme();
  S.lanes = Array.from({ length: LANES }, (_, i) => makeLane(i));
  buildLanes();
  bindDrawer();
  $('m-sound').setAttribute('aria-checked', String(S.prefs.sound));
  $('m-autoprint').setAttribute('aria-checked', String(S.prefs.autoPrint));
  disarmReset();

  $('st-start').addEventListener('click', startRun);
  $('t-stop').addEventListener('click', stopRun);
  $('btn-next').addEventListener('click', () => ($('drawer').hidden ? openDrawer() : closeDrawer()));
  $('d-done').addEventListener('click', closeDrawer);
  $('drawer').addEventListener('click', e => { if (e.target === $('drawer')) closeDrawer(); });

  $('btn-fs').addEventListener('click', toggleFullscreen);
  $('btn-board').addEventListener('click', () => (S.view === 'board' ? leaveBoard() : show('board')));
  $('b-back').addEventListener('click', leaveBoard);

  const nextGroup = () => {
    S.report = null;
    show('live');
    if (!S.queue.some(p => p.name.trim())) openDrawer();
  };
  $('r-next').addEventListener('click', nextGroup);
  $('g-done').addEventListener('click', nextGroup);
  $('r-back').addEventListener('click', () => show('group'));
  $('r-board').addEventListener('click', () => show('board'));
  $('r-print').addEventListener('click', printNow);
  $('g-print').addEventListener('click', () => printReports(S.group.members.filter(m => m.report).map(m => m.report)));
  $('group-list').addEventListener('click', e => {
    const row = e.target.closest('button.h2h');
    const m = row && S.group.members.find(x => String(x.lane) === row.dataset.lane);
    if (m?.report) openReport(m.report, true);
  });

  $('btn-menu').addEventListener('click', e => { e.stopPropagation(); setMenu($('menu').hidden); });
  $('menu').addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => setMenu(false));

  $('m-demo').addEventListener('click', () => setDemo(!S.demo));
  $('m-sound').addEventListener('click', () => {
    S.prefs.sound = !S.prefs.sound; savePrefs();
    $('m-sound').setAttribute('aria-checked', String(S.prefs.sound));
  });
  $('m-dark').addEventListener('click', () => {
    S.prefs.theme = palette.rgb === '255,255,255' ? 'light' : 'dark';
    savePrefs(); applyTheme();
  });
  $('m-autoprint').addEventListener('click', () => {
    S.prefs.autoPrint = !S.prefs.autoPrint; savePrefs();
    $('m-autoprint').setAttribute('aria-checked', String(S.prefs.autoPrint));
  });
  $('m-preview').addEventListener('click', () => { setMenu(false); if (S.report) previewReceipt(S.report); });
  $('m-export').addEventListener('click', () => { exportCsv(); setMenu(false); });
  $('m-undo').addEventListener('click', removeLast);
  $('m-reset').addEventListener('click', resetBoard);
  $('m-drop').addEventListener('click', e => {
    const b = e.target.closest('[data-drop]');
    const lane = b && S.lanes[Number(b.dataset.drop)];
    if (lane?.demo) { lane.demo.quietUntil = performance.now() + 8000; setMenu(false); }
  });
  $('receipt-preview').addEventListener('click', () => { $('receipt-preview').hidden = true; });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  document.addEventListener('keydown', e => {
    const typing = e.target.matches?.('input');
    if (e.key === 'Escape') {
      if (!$('menu').hidden) return setMenu(false);
      if (!$('receipt-preview').hidden) { $('receipt-preview').hidden = true; return; }
      if (!$('drawer').hidden) return closeDrawer();
      if (S.view === 'board') return leaveBoard();
      if (S.view === 'report') return S.reportFromGroup ? show('group') : show('live');
      if (S.view === 'group') return show('live');
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    if (e.key === 'l' || e.key === 'L') S.view === 'board' ? leaveBoard() : show('board');
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); $('drawer').hidden ? openDrawer() : closeDrawer(); }
  });

  // A result left on screen goes back to the lanes after a few quiet minutes.
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => {
    if (S.view === 'report' || S.view === 'group') armReportTimeout();
  }));

  if (!RESULT_URL.startsWith('https://pacer.club/')) {
    const tag = $('site-tag');
    tag.hidden = false;
    tag.textContent = `QR → ${RESULT_URL.replace(/^https?:\/\//, '').replace(/\/hr$/, '')}`;
    tag.title = 'QR codes point at this copy of the site. Open the booth with ?site=reset to go back to pacer.club.';
  }

  show('live');
  requestAnimationFrame(frame);
}

init();

/*
 * The printed receipt.
 *
 * It is laid out as an ordinary web page, 576 px wide — the printable width of
 * 80 mm thermal paper at 203 dpi (72 mm, 8 dots per mm) — then drawn onto a
 * canvas and reduced to 1-bit black and white with dithering, which is what a
 * thermal head can actually make. The same bitmap goes to every printer, so a
 * test print on A4 is the receipt the Epson will produce.
 *
 * The QR code carries the whole result in the link (after the #, which a
 * browser never sends to a server). pacer.club decodes it; nothing is stored
 * until the person signs up and chooses to save it.
 */
'use strict';

const RECEIPT = {
  dots: 576,          // printable width in dots
  dpmm: 8,            // 203 dpi
  paperMm: 80,
};

/* ── Result link ─────────────────────────────────────────────
 * Format v2, all integers little-endian, then base64url without padding.
 * The decoder in pacer-club-v2 (src/lib/booth-result.ts) mirrors this exactly.
 *
 *   u8   version (2; v1 is the same without the places and beats below)
 *   6B   id, random — lets a person save the same receipt twice without a duplicate
 *   u32  test time, minutes since the Unix epoch
 *   str  club slug          (str = u8 byte length + UTF-8)
 *   str  first name
 *   str  house              ('' when they chose Other)
 *   u8   age
 *   u8   resting, peak, at finish, 60 s later   (bpm, measured)
 *   u8   max heart rate they entered (0 = not given)
 *   u8   race distance (0 none, 1 = 1 km, 2 = 800 m), u16 race seconds
 *   u8   rest, get-ready, high knees, recovery lengths (s)
 *   u8   curve step (s), u8 count, then count × u8 bpm (0 = no reading)
 *   u8   place in heat, heat size     (0 = unknown)
 *   u16  place today, people today
 *   u16  heartbeats over the whole test
 *   u8   checksum: sum of every byte before it, mod 256
 */
const CURVE_STEP = 2;

function encodeResult(r) {
  const bytes = [];
  const u8 = v => bytes.push(clamp(Math.round(v) || 0, 0, 255));
  const u16 = v => { v = clamp(Math.round(v) || 0, 0, 65535); bytes.push(v & 255, v >> 8); };
  const u32 = v => { for (let i = 0; i < 4; i++) bytes.push((v >>> (8 * i)) & 255); };
  // Cut by whole characters, never mid-character, so a long name still decodes.
  const str = s => {
    let chars = Array.from(s);
    let b = new TextEncoder().encode(s);
    while (b.length > 60) { chars = chars.slice(0, -1); b = new TextEncoder().encode(chars.join('')); }
    u8(b.length); bytes.push(...b);
  };

  u8(2);
  bytes.push(...r.id);
  u32(Math.floor(r.at / 60000));
  str(r.club);
  str(r.name);
  str(r.house === 'Other' ? '' : r.house);
  u8(r.age);
  u8(r.rest); u8(r.peak); u8(r.endHr); u8(r.recHr);
  u8(r.maxHr || 0);
  u8(!r.race ? 0 : r.race.dist === 800 ? 2 : 1); u16(r.race?.secs || 0);
  for (const id of ['rest', 'ready', 'exercise', 'recover']) {
    const p = r.phases.find(q => q.id === id);
    u8((p.end - p.start) / 1000);
  }
  const end = r.phases[r.phases.length - 1].end;
  const curve = [];
  for (let t = 0; t <= end; t += CURVE_STEP * 1000) curve.push(hrAt(r.samples, t) ?? 0);
  u8(CURVE_STEP); u8(curve.length); curve.forEach(u8);
  u8(r.heatRank || 0); u8(r.heatSize || 0); u16(r.dayRank || 0); u16(r.dayCount || 0);
  u16(r.beats || 0);
  u8(bytes.reduce((a, b) => a + b, 0) % 256);

  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function resultUrl(entry) {
  return `${RESULT_URL}#${entry.code}`;
}

/* ── Receipt layout ──────────────────────────────────────────
 * Set like a race-day printout: black bands top and bottom, one condensed
 * face as big as the paper allows, and mono for every label and reading.
 * Solid black is kept for what matters; grays exist only where the dither
 * should turn them into dot texture.
 */
const D = '"Archivo", "Helvetica Neue", Arial, sans-serif';
const M = '"JetBrains Mono", "SF Mono", Menlo, monospace';

// The fonts go into the image itself: a page drawn as an SVG image can't
// reach the booth's own font files.
let fontCss = null;
async function receiptFonts() {
  if (fontCss !== null) return fontCss;
  const inline = async url => {
    const blob = await (await fetch(url)).blob();
    return new Promise(res => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(blob); });
  };
  try {
    const [a, m] = await Promise.all([inline('vendor/fonts/archivo.woff2'), inline('vendor/fonts/jetbrains-mono.woff2')]);
    fontCss = `@font-face{font-family:"Archivo";src:url(${a}) format("woff2");font-weight:100 900;font-stretch:62% 125%}`
      + `@font-face{font-family:"JetBrains Mono";src:url(${m}) format("woff2");font-weight:400 800}`;
  } catch { fontCss = ''; }
  await Promise.all([document.fonts.load(`850 40px ${D}`), document.fonts.load(`600 16px ${M}`)]).catch(() => {});
  return fontCss;
}

// Everybody tested the same day as this result, for "you against today".
function sameDay(e) {
  const day = new Date(e.at).toDateString();
  return S.entries.filter(x => new Date(x.at).toDateString() === day);
}

/**
 * Where you sit among everyone tested today: a ruler, a tick for each of
 * them, and a solid marker for you. It says where, not whether that's good.
 */
function scaleRow(label, value, others, lo, hi, note) {
  const pos = v => clamp((v - lo) / (hi - lo), 0, 1) * 100;
  const ticks = others.length >= 3 ? others.map(v => `<i style="left:${pos(v).toFixed(2)}%"></i>`).join('') : '';
  return `
    <div class="sr">
      <div class="sr-k"><b>${label}</b><span>${note}</span></div>
      <div class="sr-bar"><div class="sr-line">${ticks}<em style="left:${pos(value).toFixed(2)}%"></em></div><div class="sr-ends"><span>${lo}</span><span>${hi}</span></div></div>
      <div class="sr-v">${value}</div>
    </div>`;
}

function receiptHtml(rep, fonts = '') {
  const e = rep.entry;
  const { max, estimated, zones } = zonesFor(e.age, e.rest, e.maxHr);
  const z2 = zones[1];
  const pace = paceFor(e.race);
  const at = new Date(e.at);
  const date = at.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = sameDay(e);
  const others = key => today.filter(x => x.id !== e.id).map(x => x[key]).filter(v => typeof v === 'number');
  const total = rep.phases[rep.phases.length - 1].end / 1000;
  const pad2 = n => String(n).padStart(2, '0');

  const places = [];
  if (e.heatSize > 1) places.push(`${ordinal(e.heatRank)} of ${e.heatSize} in heat ${e.heat}`);
  if (e.dayCount >= 5) {
    places.push(e.dayRank === 1
      ? `Best of ${e.dayCount} today`
      : `Faster than ${Math.round(((e.dayCount - e.dayRank) / (e.dayCount - 1)) * 100)}% of ${e.dayCount} today`);
  } else if (e.dayCount > 1 && e.dayCount !== e.heatSize) places.push(`${ordinal(e.dayRank)} of ${e.dayCount} today`);

  const name = e.name.toUpperCase();
  const nameSize = Math.round(clamp(540 / (Math.max(name.length, 3) * 0.5), 64, 150));
  const dropMax = Math.ceil(Math.max(60, e.drop + 5, ...others('drop').map(v => v + 5)) / 10) * 10;
  const wordmark = document.getElementById('p-wordmark').innerHTML.replace('<use href="#p-P"></use>', document.getElementById('p-P').outerHTML);

  return `
<div class="r">
<style>
  ${fonts}
  .r { box-sizing: border-box; width: ${RECEIPT.dots}px; padding: 0 0 22px; background: #fff; color: #000; font: 500 19px/1.35 ${D}; }
  .r * { box-sizing: border-box; margin: 0; }
  .r .d { font-family: ${D}; font-stretch: 62%; font-weight: 850; text-transform: uppercase; line-height: .8; }
  .r .m { font-family: ${M}; font-weight: 700; font-size: 15px; letter-spacing: 1.6px; text-transform: uppercase; line-height: 1.3; }
  .r .in { padding: 0 12px; }

  .r .band { display: flex; align-items: center; justify-content: space-between; padding: 18px 16px; background: #000; color: #fff; }
  .r .band svg { display: block; width: 214px; height: auto; }
  .r .band .m { text-align: right; font-size: 14px; }
  .r .meta { display: flex; justify-content: space-between; padding: 9px 12px 8px; border-bottom: 3px solid #000; }

  .r .who { padding: 22px 12px 0; }
  .r .who .d { font-size: ${nameSize}px; letter-spacing: -.5px; white-space: nowrap; overflow: hidden; }
  .r .who .m { margin-top: 10px; }

  .r .sec { display: flex; justify-content: space-between; align-items: baseline; margin: 26px 12px 0; padding-top: 8px; border-top: 6px solid #000; }

  .r .hero { display: flex; align-items: flex-end; gap: 14px; padding: 16px 12px 0; }
  .r .hero .n { font-size: 300px; line-height: .74; letter-spacing: -4px; }
  .r .hero .u { padding-bottom: 6px; }
  .r .hero .u .d { font-size: 62px; line-height: .84; }
  .r .hero .u .m { margin-top: 10px; }
  .r .calc { display: grid; grid-template-columns: 1fr auto 1fr; align-items: end; margin: 18px 12px 0; padding: 12px 0; border-top: 2px solid #000; border-bottom: 2px solid #000; }
  .r .calc .d { font-size: 58px; }
  .r .calc .m { font-size: 13px; margin-bottom: 6px; }
  .r .calc .mid { padding: 0 10px 6px; text-align: center; }
  .r .calc .mid .m { margin: 0; }
  .r .calc .mid .arrow { font: 700 30px/1 ${M}; }
  .r .calc > div:last-child { text-align: right; }

  .r .places { margin: 14px 12px 0; }
  .r .places div { padding: 11px 14px 9px; background: #000; color: #fff; font-size: 34px; }
  .r .places div + div { margin-top: 6px; background: #fff; color: #000; box-shadow: inset 0 0 0 3px #000; }

  .r .stats { display: grid; grid-template-columns: 1fr 1fr 1fr; margin: 0 12px; }
  .r .stats > div { padding: 14px 0 4px; }
  .r .stats > div + div { padding-left: 14px; border-left: 2px solid #000; }
  .r .stats .d { margin-top: 8px; font-size: 64px; }
  .r .stats small { font: 700 13px ${M}; letter-spacing: 1px; margin-left: 4px; }
  .r .stats .note { margin-top: 6px; font: 500 14px/1.25 ${D}; }

  .r .trace { display: block; margin: 12px 12px 0; }

  .r .sr { display: grid; grid-template-columns: 112px 1fr 74px; align-items: center; gap: 14px; margin: 0 12px; padding: 12px 0; border-bottom: 2px solid #000; }
  .r .sr-k b { display: block; font: 700 15px/1.2 ${M}; letter-spacing: 1.4px; text-transform: uppercase; }
  .r .sr-k span { display: block; margin-top: 3px; font: 500 14px/1.2 ${D}; }
  .r .sr-line { position: relative; height: 22px; background: linear-gradient(#000, #000) center / 100% 3px no-repeat; }
  .r .sr-line i { position: absolute; top: 4px; bottom: 4px; width: 3px; margin-left: -1px; background: #777; }
  .r .sr-line em { position: absolute; top: 0; bottom: 0; width: 10px; margin-left: -5px; background: #000; }
  .r .sr-ends { display: flex; justify-content: space-between; margin-top: 3px; font: 600 12px/1 ${M}; }
  .r .sr-v { text-align: right; font-family: ${D}; font-stretch: 62%; font-weight: 850; font-size: 54px; line-height: .8; }
  .r .legend { margin: 8px 12px 0; font: 600 13px/1.35 ${M}; letter-spacing: .6px; text-transform: uppercase; }

  .r .zbar { display: grid; grid-template-columns: repeat(5, 1fr); margin: 14px 12px 0; border: 3px solid #000; }
  .r .zbar > div { height: 58px; display: flex; align-items: flex-end; padding: 0 0 5px 7px; font: 800 20px/1 ${M}; }
  .r .zbar > div + div { border-left: 3px solid #000; }
  .r .zr { display: grid; grid-template-columns: repeat(5, 1fr); margin: 6px 12px 0; font: 700 14px/1.2 ${M}; }
  .r .zr div { padding-left: 2px; }
  .r .zr b { display: block; font: 500 13px/1.2 ${D}; text-transform: none; }
  .r .zr .on b { font-weight: 800; }
  .r .zr .on b::before { content: "▲ "; }
  .r .zbasis { margin: 10px 12px 0; font: 500 14px/1.3 ${D}; }

  .r .easy { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; margin: 14px 12px 0; }
  .r .easy .d { font-size: 80px; white-space: nowrap; }
  .r .easy .d small { font: 700 15px ${M}; letter-spacing: 1px; margin-left: 6px; }
  .r .easy p { max-width: 210px; padding-bottom: 4px; text-align: right; font: 500 16px/1.3 ${D}; }
  .r .copy { margin: 14px 12px 0; font: 500 18px/1.4 ${D}; }

  .r .end { display: flex; gap: 18px; align-items: center; margin-top: 28px; padding: 18px 16px; background: #000; color: #fff; }
  .r .end .q { flex: none; padding: 8px; background: #fff; line-height: 0; }
  .r .end .d { font-size: 64px; line-height: .84; }
  .r .end .m { margin-top: 12px; font-size: 13px; }
  .r .foot { display: flex; justify-content: space-between; margin: 10px 12px 0; font: 700 12px/1.3 ${M}; letter-spacing: 1px; text-transform: uppercase; }
</style>

<div class="band"><svg viewBox="0 0 2044 241" fill="#fff">${wordmark}</svg><div class="m">Heart rate<br>recovery test</div></div>
<div class="meta m"><span>No. ${String(e.no || 1).padStart(4, '0')}</span><span>${date} ${time}</span><span>${e.heat ? `Heat ${pad2(e.heat)}${e.lane ? ` · L${e.lane}` : ''}` : ''}</span></div>

<div class="who"><div class="d">${esc(name)}</div><div class="m">${[e.house, `Age ${e.age}`].filter(Boolean).map(esc).join(' · ')}</div></div>

<div class="sec m"><span>Recovery score</span><span>● Measured</span></div>
<div class="hero"><div class="d n">${e.drop}</div><div class="u"><div class="d">BPM<br>drop</div><div class="m">in 60 sec</div></div></div>
<div class="calc">
  <div><div class="m">At the finish</div><div class="d">${e.endHr}</div></div>
  <div class="mid"><div class="arrow">→</div><div class="m">60 s</div></div>
  <div><div class="m">A minute later</div><div class="d">${e.recHr}</div></div>
</div>
${places.length ? `<div class="places">${places.map(p => `<div class="d">${esc(p)}</div>`).join('')}</div>` : ''}

<div class="stats">
  <div><div class="m">Resting</div><div class="d">${e.rest}<small>BPM</small></div><div class="note">Sitting still</div></div>
  <div><div class="m">Peak</div><div class="d">${e.peak}<small>BPM</small></div><div class="note">Not scored</div></div>
  <div><div class="m">Heartbeats</div><div class="d">${e.beats || '-'}</div><div class="note">In ${mmss(total)}</div></div>
</div>

<div class="sec m"><span>Heart rate trace</span><span>● Measured</span></div>
${traceSvg(rep, RECEIPT.dots - 24, 320)}

<div class="sec m"><span>You vs today</span><span>${today.length} tested</span></div>
${scaleRow('Recovery', e.drop, others('drop'), 0, dropMax, 'Higher is faster')}
${scaleRow('Resting', e.rest, others('rest'), 40, 120, 'Sitting still')}
${scaleRow('Peak', e.peak, others('peak'), 100, 220, 'Not scored')}
<p class="legend">█ You &nbsp; ▏ Everyone else today${today.length < 4 ? ' (from 4 people)' : ''}</p>

<div class="sec m"><span>Training zones</span><span>○ Estimated</span></div>
<div class="zbar">${zones.map((z, i) => `<div style="background:${['#fff', '#d4d4d4', '#9a9a9a', '#4a4a4a', '#000'][i]};color:${i > 2 ? '#fff' : '#000'}">${z.n}</div>`).join('')}</div>
<div class="zr">${zones.map(z => `<div class="${z.n === 2 ? 'on' : ''}">${z.lo}–${z.hi}<b>${z.n === 2 ? 'Easy runs' : z.name}</b></div>`).join('')}</div>
<p class="zbasis">Beats per minute, from your resting ${e.rest} and a max of ${max}${estimated ? ' estimated from age' : ' as entered'}.</p>

<div class="sec m"><span>${pace ? 'Easy run pace' : 'Easy runs'}</span><span>○ Estimated</span></div>
<div class="easy">
  <div class="d">${pace ? `${mmss(pace.fast)}–${mmss(pace.slow)}<small>/KM</small>` : `${z2.lo}–${z2.hi}<small>BPM</small>`}</div>
  <p>${pace ? `From your ${e.race.dist === 800 ? '800 m' : '1 km'} in ${mmss(e.race.secs)}. Around ${z2.lo}–${z2.hi} bpm.` : 'Any pace that keeps you in zone 2.'} Slow enough to talk.</p>
</div>
<p class="copy">Recovery climbs as you get fitter. Three easy runs a week is the simplest way to move it.</p>

<div class="end">
  <div class="q">${qrSvg(resultUrl(e), 184)}</div>
  <div><div class="d">Beat ${Math.max(e.drop, 0)}<br>next time</div><div class="m">Scan to save it on pacer.club</div></div>
</div>
<div class="foot"><span>● Measured ○ Estimated</span><span>For fun, not medical advice</span></div>
</div>`;
}

// The trace: high knees as a solid black block with the line running white
// through it, and the drop measured off like a dimension on a drawing.
function traceSvg(rep, w, h) {
  const { samples, phases, marks } = rep;
  const end = phases[phases.length - 1].end;
  const pad = { t: 48, r: 100, b: 40, l: 4 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const hrs = samples.map(s => s.hr).concat(marks.map(m => m.hr));
  const lo = Math.floor((Math.min(...hrs) - 6) / 10) * 10, hi = Math.ceil((Math.max(...hrs) + 6) / 10) * 10;
  const X = t => pad.l + (t / end) * pw;
  const Y = v => pad.t + (1 - (v - lo) / (hi - lo)) * ph;
  const xy = samples.filter(s => s.t <= end).map(s => [X(s.t), Y(s.hr)]);
  const path = svgPath();
  if (xy.length > 1) smoothPath(path, xy);

  const ex = phases.find(p => p.id === 'exercise');
  const rec = phases.find(p => p.id === 'recover');
  const finish = marks.find(m => m.label.startsWith('Finish'));
  const later = marks.find(m => m.label.startsWith('60 s'));
  const rest = marks.find(m => m.label.startsWith('Resting'));
  const bx = X(ex.start), bw = X(ex.end) - bx;

  let grid = '';
  for (let v = Math.ceil(lo / 20) * 20; v <= hi; v += 20) {
    grid += `<line x1="${pad.l}" x2="${pad.l + pw}" y1="${Y(v)}" y2="${Y(v)}" stroke="#000" stroke-width="2" stroke-dasharray="2 6"/>`;
  }
  const dot = (m, fill) => `<circle cx="${X(m.t)}" cy="${Y(m.hr)}" r="8" fill="${fill}" stroke="#000" stroke-width="4"/>`;
  const fx = X(finish.t), fy = Y(finish.hr), lx = X(later.t), ly = Y(later.hr);
  const dimX = pad.l + pw + 18;
  const tag = (x, text, anchor = 'start') => `<text x="${x}" y="${h - 12}" text-anchor="${anchor}" font-family='${M}' font-size="14" font-weight="700" letter-spacing="1.4">${text}</text>`;

  return `<svg class="trace" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><clipPath id="ex"><rect x="${bx}" y="0" width="${bw}" height="${h - pad.b + 6}"/></clipPath></defs>
    ${grid}
    <rect x="${bx}" y="0" width="${bw}" height="${h - pad.b + 6}" fill="#000"/>
    <path d="${path.d}" fill="none" stroke="#000" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="${path.d}" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#ex)"/>
    ${dot(rest, '#fff')}${dot(later, '#000')}
    <circle cx="${fx}" cy="${fy}" r="9" fill="#fff" stroke="#000" stroke-width="4"/>
    <text x="${X(rest.t)}" y="${Y(rest.hr) - 18}" text-anchor="middle" font-family='${M}' font-size="15" font-weight="800">${rest.hr}</text>
    <text x="${fx + 14}" y="${fy - 14}" font-family='${M}' font-size="15" font-weight="800">${finish.hr}</text>
    <text x="${lx - 4}" y="${ly + 30}" text-anchor="end" font-family='${M}' font-size="15" font-weight="800">${later.hr}</text>
    <line x1="${fx}" x2="${dimX + 8}" y1="${fy}" y2="${fy}" stroke="#000" stroke-width="2" stroke-dasharray="4 4"/>
    <line x1="${lx}" x2="${dimX + 8}" y1="${ly}" y2="${ly}" stroke="#000" stroke-width="2" stroke-dasharray="4 4"/>
    <line x1="${dimX}" x2="${dimX}" y1="${fy}" y2="${ly}" stroke="#000" stroke-width="3"/>
    <path d="M${dimX - 7} ${ly - 12}L${dimX} ${ly}L${dimX + 7} ${ly - 12}" fill="none" stroke="#000" stroke-width="3"/>
    <text x="${dimX + 10}" y="${(fy + ly) / 2 + 15}" font-family='${D}' font-stretch="62%" font-weight="850" font-size="42">−${Math.max(finish.hr - later.hr, 0)}</text>
    <line x1="0" x2="${w}" y1="${h - pad.b + 6}" y2="${h - pad.b + 6}" stroke="#000" stroke-width="3"/>
    ${tag(pad.l, '01 REST')}${tag(bx + 8, '02 HIGH KNEES')}${tag(X(rec.start) + 8, '03 RECOVER')}
  </svg>`;
}

function qrSvg(text, size) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  const px = size ? Math.floor(size / (n + 4)) * (n + 4) : null;
  const dims = px ? ` width="${px}" height="${px}" style="width:${px}px;height:${px}px"` : '';
  return `<svg viewBox="-2 -2 ${n + 4} ${n + 4}"${dims} shape-rendering="crispEdges"><path d="${d}" fill="#000"/></svg>`;
}

// A stand-in for a canvas context, so the chart's smoothing writes SVG too.
function svgPath() {
  const f = n => n.toFixed(1);
  return {
    d: '',
    moveTo(x, y) { this.d += `M${f(x)} ${f(y)}`; },
    lineTo(x, y) { this.d += `L${f(x)} ${f(y)}`; },
    bezierCurveTo(a, b, c, d, x, y) { this.d += `C${f(a)} ${f(b)} ${f(c)} ${f(d)} ${f(x)} ${f(y)}`; },
  };
}

/* ── Page → 1-bit bitmap ─────────────────────────────────── */

async function renderReceipt(rep) {
  // Lay it out for real first, to learn how tall it is.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;';
  host.innerHTML = receiptHtml(rep, await receiptFonts());
  document.body.append(host);
  const node = host.firstElementChild;
  const height = Math.ceil(node.getBoundingClientRect().height);
  const xhtml = new XMLSerializer().serializeToString(node);
  host.remove();

  // Laid out again inside the image, text can wrap a pixel differently than it
  // did on the page, so draw with room to spare and trim the blank paper after.
  const room = height + 600;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${RECEIPT.dots}" height="${room}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();

  const canvas = document.createElement('canvas');
  canvas.width = RECEIPT.dots;
  canvas.height = room;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  const full = ctx.getImageData(0, 0, canvas.width, room);
  let last = room - 1;
  outer: for (; last > 0; last--) {
    for (let x = 0; x < RECEIPT.dots; x++) if (full.data[(last * RECEIPT.dots + x) * 4] < 200) break outer;
  }
  const end = Math.min(room, last + 36);   // a little paper under the last line
  return dither(ctx.getImageData(0, 0, canvas.width, end));
}

// Floyd–Steinberg. Near-black and near-white snap first so type stays crisp
// and paper stays clean; only real mid-tones get the dot texture.
function dither(image) {
  const { width: w, height: h, data } = image;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const v = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    g[i] = v < 70 ? 0 : v > 236 ? 255 : v;
  }
  const rowBytes = Math.ceil(w / 8);
  const bits = new Uint8Array(rowBytes * h);   // 1 = black, the printer's convention
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = g[i];
      const black = old < 128;
      const err = old - (black ? 0 : 255);
      if (black) bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      if (x + 1 < w) g[i + 1] += err * 7 / 16;
      if (y + 1 < h) {
        if (x > 0) g[i + w - 1] += err * 3 / 16;
        g[i + w] += err * 5 / 16;
        if (x + 1 < w) g[i + w + 1] += err * 1 / 16;
      }
    }
  }
  return { width: w, height: h, rowBytes, bits };
}

function bitmapToCanvas(bm) {
  const c = document.createElement('canvas');
  c.width = bm.width;
  c.height = bm.height;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(bm.width, bm.height);
  for (let y = 0; y < bm.height; y++) {
    for (let x = 0; x < bm.width; x++) {
      const on = bm.bits[y * bm.rowBytes + (x >> 3)] & (0x80 >> (x & 7));
      const o = (y * bm.width + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = on ? 0 : 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ── Printing ────────────────────────────────────────────────
 * booth.py (the local server this page runs from) owns the printer and the
 * printer setting in printer.json, so the page sends the same bitmap whatever
 * is plugged in. Opened any other way, the page falls back to the browser's
 * own print dialog on A4.
 */
async function printReceipt(rep) {
  const bm = await renderReceipt(rep);
  try {
    const res = await fetch('/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        width: bm.width, height: bm.height,
        bits: btoa(Array.from(bm.bits, b => String.fromCharCode(b)).join('')),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Printer said ${res.status}`);
    return { ok: true, via: body.printer };
  } catch (err) {
    if (location.protocol === 'file:' || err instanceof TypeError) {
      browserPrint(bm);
      return { ok: true, via: 'browser' };
    }
    return { ok: false, error: err.message };
  }
}

// A4 through the browser: the strip is the 80 mm paper, the image inside it the
// 72 mm the head can reach, both at true size. Zero page margins leave Chrome
// nowhere to put its headers, footers and page numbers.
function browserPrint(bm) {
  const url = bitmapToCanvas(bm).toDataURL('image/png');
  let box = document.getElementById('print-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'print-box';
    document.body.append(box);
  }
  box.innerHTML = `<div class="strip"><img src="${url}" alt=""></div>`;
  box.querySelector('img').decode().then(() => window.print());
}

async function previewReceipt(rep) {
  const bm = await renderReceipt(rep);
  const box = $('receipt-preview');
  box.querySelector('.receipt-paper').replaceChildren(bitmapToCanvas(bm));
  box.hidden = false;
}

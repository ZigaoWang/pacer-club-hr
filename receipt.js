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
 * Thermal paper is what heart monitors print on, so the receipt is a strip of
 * one: the trace on a millimeter grid, edge to edge, under a stamped number.
 * Labels are set in mono like a printout; numbers are set big and condensed.
 * Grays exist only where the dither should turn them into dot texture.
 */
const MONO = '"SF Mono", ui-monospace, Menlo, monospace';
const BIG = '"Helvetica Neue", "SF Pro Display", Arial, sans-serif';

// Everybody tested the same day as this result, for "you against today".
function sameDay(e) {
  const day = new Date(e.at).toDateString();
  return S.entries.filter(x => new Date(x.at).toDateString() === day);
}

/**
 * A gym-report row: a scale, everybody tested today as thin ticks on it, and
 * this person as the solid marker. It says where you sit, not whether that's
 * good; nothing on it is labeled normal or otherwise.
 */
function scaleRow(label, value, unit, others, lo, hi, note) {
  const pos = v => clamp((v - lo) / (hi - lo), 0, 1) * 100;
  const ticks = others.length >= 3 ? others.map(v => `<i style="left:${pos(v)}%"></i>`).join('') : '';
  return `
    <div class="row">
      <div class="rk"><b>${label}</b>${note ? `<span>${note}</span>` : ''}</div>
      <div class="rbar">
        <div class="track">${ticks}<em style="left:${pos(value)}%"></em></div>
        <div class="ends"><span>${lo}</span><span>${hi}</span></div>
      </div>
      <div class="rv"><b>${value}</b><span>${unit}</span></div>
    </div>`;
}

function receiptHtml(rep) {
  const e = rep.entry;
  const { max, estimated, zones } = zonesFor(e.age, e.rest, e.maxHr);
  const z2 = zones[1];
  const pace = paceFor(e.race);
  const at = new Date(e.at);
  const date = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = sameDay(e);
  const others = key => today.map(x => x[key]).filter(v => typeof v === 'number');
  const total = rep.phases[rep.phases.length - 1].end / 1000;

  const dayLine = e.dayCount >= 5
    ? (e.dayRank === 1
      ? `Best recovery of the ${e.dayCount} people tested today so far.`
      : `Faster than ${Math.round(((e.dayCount - e.dayRank) / (e.dayCount - 1)) * 100)}% of the ${e.dayCount} people tested today.`)
    : e.dayCount > 1 && e.dayCount !== e.heatSize ? `${ordinal(e.dayRank)} of ${e.dayCount} people tested today.` : '';
  const heatLine = e.heatSize > 1 ? `${ordinal(e.heatRank)} of ${e.heatSize} in heat ${e.heat}.` : '';
  const dropMax = Math.ceil(Math.max(60, ...others('drop').map(v => v + 5)) / 10) * 10;

  return `
<div class="r">
<style>
  .r { box-sizing: border-box; width: ${RECEIPT.dots}px; padding: 24px 12px 26px; background: #fff; color: #000;
       font: 500 20px/1.3 ${BIG}; }
  .r * { box-sizing: border-box; margin: 0; }
  .top { display: flex; align-items: flex-end; justify-content: space-between; padding-bottom: 12px; border-bottom: 5px solid #000; }
  .logo { display: block; width: 210px; height: auto; margin-bottom: 4px; }
  .title { text-align: right; font: 800 34px/.95 ${BIG}; font-stretch: condensed; text-transform: uppercase; letter-spacing: .3px; }
  .info { display: grid; grid-template-columns: 1.5fr 1fr .7fr; border-bottom: 2px solid #000; }
  .info > div { padding: 9px 0 8px; min-width: 0; }
  .info > div + div { padding-left: 12px; border-left: 2px solid #000; }
  .k { display: block; font: 600 14px/1 ${BIG}; text-transform: uppercase; letter-spacing: 1px; }
  .v { display: block; margin-top: 5px; font: 800 30px/1 ${BIG}; font-stretch: condensed; text-transform: uppercase; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sec { margin-top: 26px; display: flex; justify-content: space-between; align-items: baseline; padding-bottom: 6px; border-bottom: 2px solid #000; }
  .sec h2 { font: 800 30px/1 ${BIG}; font-stretch: condensed; text-transform: uppercase; letter-spacing: .3px; }
  .sec span { font: 600 15px/1 ${BIG}; text-transform: uppercase; letter-spacing: 1px; }
  .hero { display: flex; align-items: flex-end; gap: 18px; margin-top: 14px; }
  .hero b { font: 800 190px/.76 ${BIG}; font-stretch: condensed; letter-spacing: -7px; }
  .hero div { padding-bottom: 4px; }
  .hero strong { display: block; font: 800 34px/1 ${BIG}; font-stretch: condensed; }
  .hero p { margin-top: 6px; font: 500 19px/1.3 ${BIG}; }
  .facts { margin-top: 14px; font: 600 19px/1.4 ${BIG}; }
  .row { display: grid; grid-template-columns: 128px 1fr 104px; align-items: center; gap: 14px; padding: 12px 0; border-bottom: 1px solid #000; }
  .rk b { display: block; font: 700 20px/1.1 ${BIG}; }
  .rk span { display: block; margin-top: 2px; font: 500 14px/1.15 ${BIG}; }
  .track { position: relative; height: 16px; border: 2px solid #000; background: #fff; }
  .track i { position: absolute; top: 3px; bottom: 3px; width: 3px; margin-left: -1px; background: #8a8a8a; }
  .track em { position: absolute; top: -9px; width: 14px; height: 30px; margin-left: -7px; background: #000; border: 3px solid #fff; outline: 2px solid #000; }
  .ends { display: flex; justify-content: space-between; margin-top: 4px; font: 600 13px/1 ${BIG}; }
  .rv { text-align: right; }
  .rv b { display: block; font: 800 44px/.9 ${BIG}; font-stretch: condensed; }
  .rv span { font: 600 14px/1 ${BIG}; text-transform: uppercase; }
  .legend { margin-top: 8px; font: 500 14px/1.3 ${BIG}; }
  .strip { display: block; margin-top: 12px; }
  .zt { width: 100%; margin-top: 4px; border-collapse: collapse; font: 600 20px/1 ${BIG}; }
  .zt td { padding: 9px 0; border-bottom: 1px solid #000; }
  .zt td:first-child { width: 40px; font-weight: 800; }
  .zt td.sw { width: 66px; }
  .zt td.sw i { display: block; width: 52px; height: 20px; border: 2px solid #000; }
  .zt td:last-child { text-align: right; font: 800 28px/1 ${BIG}; font-stretch: condensed; }
  .zt tr.on td { font-weight: 800; }
  .zt .tip { font-weight: 600; font-size: 16px; }
  .guide { display: flex; justify-content: space-between; align-items: flex-end; gap: 14px; margin-top: 12px; }
  .guide b { display: block; font: 800 64px/.88 ${BIG}; font-stretch: condensed; letter-spacing: -1px; white-space: nowrap; }
  .guide b small { font: 700 20px ${BIG}; margin-left: 4px; letter-spacing: 0; }
  .guide p { max-width: 240px; text-align: right; font: 500 17px/1.3 ${BIG}; }
  .copy { margin-top: 12px; font: 500 18px/1.38 ${BIG}; }
  .qr { display: flex; gap: 18px; align-items: center; margin-top: 22px; padding-top: 18px; border-top: 5px solid #000; }
  .qr svg { flex: none; }
  .qr .big { font: 800 44px/.92 ${BIG}; font-stretch: condensed; text-transform: uppercase; }
  .qr .small { margin-top: 10px; font: 500 17px/1.32 ${BIG}; }
  .foot { margin-top: 18px; padding-top: 10px; border-top: 2px solid #000; display: flex; justify-content: space-between; font: 600 13px/1.3 ${BIG}; text-transform: uppercase; letter-spacing: .5px; }
</style>

<div class="top">
  <svg class="logo" viewBox="0 0 2044 241" fill="#000">${document.getElementById('p-wordmark').innerHTML.replace('<use href="#p-P"></use>', document.getElementById('p-P').outerHTML)}</svg>
  <div class="title">Heart rate<br>report</div>
</div>
<div class="info">
  <div><span class="k">Name</span><span class="v">${esc(e.name)}</span></div>
  <div><span class="k">House</span><span class="v">${esc(e.house)}</span></div>
  <div><span class="k">Age</span><span class="v">${e.age}</span></div>
</div>
<div class="info">
  <div><span class="k">Date</span><span class="v">${esc(date)} · ${time}</span></div>
  <div><span class="k">Heat${e.lane ? ' · Lane' : ''}</span><span class="v">${e.heat || '-'}${e.lane ? ` · ${e.lane}` : ''}</span></div>
  <div><span class="k">No.</span><span class="v">${String(e.no || 1).padStart(4, '0')}</span></div>
</div>

<div class="sec"><h2>Recovery score</h2><span>● Measured</span></div>
<div class="hero">
  <b>${e.drop}</b>
  <div><strong>BPM DROP</strong><p>How far your heart rate fell in the first minute after high knees.</p></div>
</div>
<p class="facts">${e.endHr} bpm at the finish, ${e.recHr} bpm a minute later.${heatLine ? `<br>${heatLine}` : ''}${dayLine ? `<br>${dayLine}` : ''}</p>

<div class="sec"><h2>You vs today</h2><span>● Measured</span></div>
${scaleRow('Recovery', e.drop, 'bpm drop', others('drop'), 0, dropMax, 'higher = faster')}
${scaleRow('Resting', e.rest, 'bpm', others('rest'), 40, 120, 'sitting still')}
${scaleRow('Peak', e.peak, 'bpm', others('peak'), 100, 220, 'not scored')}
<p class="legend">■ You &nbsp; | Everyone else tested today${today.length < 3 ? ' (appears once three people have done it)' : ''}</p>

<div class="sec"><h2>Heart rate trace</h2><span>${e.beats ? `${e.beats} beats in ${mmss(total)}` : ''}</span></div>
${stripSvg(rep, RECEIPT.dots - 24, 300)}

<div class="sec"><h2>Training zones</h2><span>○ Estimated</span></div>
<table class="zt">${zones.map((z, i) => `<tr class="${z.n === 2 ? 'on' : ''}"><td>${z.n}</td><td class="sw"><i style="background:${['#fff', '#d0d0d0', '#a0a0a0', '#5a5a5a', '#000'][i]}"></i></td><td>${z.name}${z.n === 2 ? ' <span class="tip">← easy runs</span>' : ''}</td><td>${z.lo}–${z.hi}</td></tr>`).join('')}</table>
<p class="legend">From your resting heart rate and a max of ${max}${estimated ? ', estimated from age' : ', as entered'}.</p>

<div class="sec"><h2>${pace ? 'Easy run pace' : 'Easy runs'}</h2><span>○ Estimated</span></div>
<div class="guide">
  <b>${pace ? `${mmss(pace.fast)}–${mmss(pace.slow)}<small>/km</small>` : `${z2.lo}–${z2.hi}<small>bpm</small>`}</b>
  <p>${pace ? `From your ${e.race.dist === 800 ? '800 m' : '1 km'} in ${mmss(e.race.secs)}, around ${z2.lo}–${z2.hi} bpm.` : 'Any pace that keeps you in zone 2.'} Slow enough to talk.</p>
</div>
<p class="copy">Recovery tends to climb as you get fitter. Three easy runs a week is the simplest way to see it move.</p>

<div class="qr">
  ${qrSvg(resultUrl(e), 220)}
  <div><div class="big">Beat ${Math.max(e.drop, 0)} next time</div><div class="small">Scan to keep this report on pacer.club and set a weekly goal.</div></div>
</div>
<div class="foot"><span>● Measured ○ Estimated</span><span>For fun, not medical advice</span></div>
</div>`;
}

// The trace: a light 5 mm grid, the high-knees stretch shaded, and the three
// measured points called out.
function stripSvg(rep, w, h) {
  const { samples, phases, marks } = rep;
  const end = phases[phases.length - 1].end;
  const pad = { t: 46, r: 16, b: 34, l: 16 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const hrs = samples.map(s => s.hr).concat(marks.map(m => m.hr));
  const lo = Math.floor((Math.min(...hrs) - 8) / 10) * 10, hi = Math.ceil((Math.max(...hrs) + 14) / 10) * 10;
  const X = t => pad.l + (t / end) * pw;
  const Y = v => pad.t + (1 - (v - lo) / (hi - lo)) * ph;
  const xy = samples.filter(s => s.t <= end).map(s => [X(s.t), Y(s.hr)]);
  const path = svgPath();
  if (xy.length > 1) smoothPath(path, xy);

  // Light 5 mm lines, like a chart in a report rather than monitor paper.
  let grid = '';
  for (let x = 0; x <= w; x += RECEIPT.dpmm * 5) grid += `<line x1="${x}" x2="${x}" y1="0" y2="${h - pad.b + 4}" stroke="#c4c4c4" stroke-width="2"/>`;
  for (let y = 0; y <= h - pad.b; y += RECEIPT.dpmm * 5) grid += `<line x1="0" x2="${w}" y1="${y}" y2="${y}" stroke="#c4c4c4" stroke-width="2"/>`;
  const ex = phases.find(p => p.id === 'exercise');
  const rec = phases.find(p => p.id === 'recover');
  const tag = (x, text) => `<text x="${x}" y="${h - 10}" font-size="17" font-weight="700" letter-spacing="1">${text}</text>`;
  const callouts = marks.filter(m => !m.label.startsWith('Peak')).map(m => {
    const x = X(m.t), y = Y(m.hr);
    const short = m.label.replace('Resting ', 'REST ').replace('Finish ', 'END ').replace('60 s later ', '+60s ');
    const lx = clamp(x, pad.l + 56, pad.l + pw - 56), ly = m.below ? y + 34 : y - 16;
    return `<circle cx="${x}" cy="${y}" r="9" fill="#fff" stroke="#000" stroke-width="5"/>
      <text x="${lx}" y="${ly}" text-anchor="middle" font-size="20" font-weight="800" stroke="#fff" stroke-width="8" paint-order="stroke" stroke-linejoin="round">${short}</text>`;
  }).join('');

  return `<svg class="strip" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family='${BIG}'>
    ${grid}
    <rect x="${X(ex.start)}" y="0" width="${X(ex.end) - X(ex.start)}" height="${h - pad.b + 4}" fill="#000" fill-opacity=".09"/>
    <path d="${path.d}" fill="none" stroke="#000" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>
    ${callouts}
    <rect x="0" y="${h - pad.b + 4}" width="${w}" height="${pad.b}" fill="#fff"/>
    ${tag(X(0) + 2, 'REST')}${tag(X(ex.start) + 6, 'HIGH KNEES')}${tag(X(rec.start) + 6, 'RECOVER')}
    <line x1="0" x2="${w}" y1="${h - pad.b + 4}" y2="${h - pad.b + 4}" stroke="#000" stroke-width="3"/>
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
  host.innerHTML = receiptHtml(rep);
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

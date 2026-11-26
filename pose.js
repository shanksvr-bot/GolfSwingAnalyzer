// pose.js
// Flow: analyzeVideo() runs pose estimation once over the whole clip (seek-based),
// then detects swing phases from the full hand trajectory. drawPose() just reads
// the stored data, so scrubbing, replay and phase-jumping all work with no live inference.

const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

export const SAMPLE_FPS = 30; // analysis rate. Raise for slow-mo clips if you want finer impact timing.

// ---- Tunable detection constants (all distances are in "torso lengths") ----
const MIN_VISIBILITY = 0.35;
const STABLE_SECONDS = 0.4;   // hands must be still this long to count as address
const STABLE_TOL = 0.05;      // max wobble inside the address window
const TAKEAWAY_TOL = 0.12;    // how far hands move from address before it's "takeaway"
const TOP_RISE = 0.35;        // hands must rise this far above address to arm top detection
const TOP_DROP = 0.30;        // ...then fall this far below the peak to confirm the top
const IMPACT_DESCENT = 0.6;   // hands must come back down this fraction of the way to address height...
const IMPACT_RISE = 0.08;     // ...then rise this far from their low point (follow-through) to confirm impact

const CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [28, 30], [30, 32],
];

const PHASE_NAMES = {
  P1: 'Address',
  P2: 'Shaft parallel (back)',
  P3: 'Lead arm parallel (back)',
  P4: 'Top of backswing',
  P5: 'Lead arm parallel (down)',
  P6: 'Shaft parallel (down)',
  P7: 'Impact',
  P8: 'Shaft parallel (through)',
  P9: 'Lead arm parallel (through)',
  P10: 'Finish',
};
const CORE = ['P1', 'P4', 'P7', 'P10'];   // always kept; the rest are dropped if they land out of order
const P2_FRACTION = 0.35;                 // P2/P6/P8 estimate: hands this far up from address toward P3 height

// ---------------------------------------------------------------------------
// Model loading (cached; GPU first, CPU fallback)
// ---------------------------------------------------------------------------
let landmarker = null;
let lastTimestamp = 0; // detectForVideo needs strictly increasing timestamps across runs

async function getLandmarker() {
  if (landmarker) return landmarker;
  const { FilesetResolver, PoseLandmarker } = await import(`${VISION}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
  const make = delegate =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  try {
    landmarker = await make('GPU');
  } catch (e) {
    console.warn('GPU delegate failed, falling back to CPU', e);
    landmarker = await make('CPU');
  }
  return landmarker;
}

// ---------------------------------------------------------------------------
// Frame-by-frame analysis
// ---------------------------------------------------------------------------
function seekTo(video, t) {
  return new Promise(resolve => {
    if (Math.abs(video.currentTime - t) < 0.0005) return resolve();
    let timer;
    const onSeeked = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      setTimeout(resolve, 10); // let the decoded frame settle before inference
    };
    video.addEventListener('seeked', onSeeked);
    timer = setTimeout(onSeeked, 1500); // never hang on a missed event
    video.currentTime = t;
  });
}

export async function analyzeVideo(video, { view = '', lefty = false, onProgress = () => {}, signal } = {}) {
  if (!video.videoWidth || !isFinite(video.duration)) {
    throw new Error(
      'This video has no readable duration (some recorded WebM files lack it). Try an uploaded MP4/MOV.'
    );
  }

  onProgress(0, 'Loading model…');
  const lm = await getLandmarker();

  const wasPaused = video.paused;
  const startTime = video.currentTime;
  video.pause();

  const count = Math.floor(video.duration * SAMPLE_FPS) + 1;
  const frames = [];

  try {
    for (let i = 0; i < count; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

      const t = i / SAMPLE_FPS;
      await seekTo(video, Math.min(t, video.duration));

      lastTimestamp += 1000 / SAMPLE_FPS;
      const result = lm.detectForVideo(video, lastTimestamp);
      const pts = result.landmarks?.[0];

      frames.push({
        t,
        lm: pts ? pts.map(p => ({ x: p.x, y: p.y, v: p.visibility ?? 1 })) : null,
      });

      if (i % 3 === 0) onProgress((i + 1) / count, 'Analyzing');
    }
  } finally {
    video.currentTime = startTime;
    if (!wasPaused) video.play().catch(() => {});
  }

  onProgress(1, 'Analyzing');
  const aspect = video.videoWidth / video.videoHeight;
  return { frames, view, lefty, aspect, ...analyzeSwing(frames, view, aspect, lefty) };
}

// ---------------------------------------------------------------------------
// Swing analysis from the full trajectory
// ---------------------------------------------------------------------------
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const median = a => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

function buildSamples(frames, aspect = 1, lefty = false) {
  // Lead side = left for a right-handed golfer. (MediaPipe landmarks: 11/15 = left shoulder/wrist, 12/16 = right.)
  const LS = lefty ? 12 : 11, LW = lefty ? 16 : 15;
  const raw = [];
  frames.forEach((f, i) => {
    const L = f.lm;
    if (!L) return;
    for (const k of [11, 12, 15, 16, 23, 24]) {
      if (!L[k] || L[k].v < MIN_VISIBILITY) return;
    }
    const shoulderY = (L[11].y + L[12].y) / 2;
    const hipY = (L[23].y + L[24].y) / 2;
    raw.push({
      i,
      t: f.t,
      x: ((L[15].x + L[16].x) / 2) * aspect, // x scaled so distances are in true pixel proportions
      y: (L[15].y + L[16].y) / 2,
      shoulderY,
      hipY,
      torso: Math.max(0.05, hipY - shoulderY),
      lsy: L[LS].y, // lead shoulder height
      lwy: L[LW].y, // lead wrist height
    });
  });

  // 5-sample moving average to kill landmark jitter
  const W = 2;
  return raw.map((p, k) => {
    let sx = 0, sy = 0, sl = 0, sw = 0, c = 0;
    for (let j = Math.max(0, k - W); j <= Math.min(raw.length - 1, k + W); j++) {
      sx += raw[j].x; sy += raw[j].y; sl += raw[j].lsy; sw += raw[j].lwy;
      c++;
    }
    return { ...p, x: sx / c, y: sy / c, lsy: sl / c, lwy: sw / c };
  });
}

function angleBetween(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y;
  const cbx = c.x - b.x, cby = c.y - b.y;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (!mag) return 0;
  const v = Math.max(-1, Math.min(1, (abx * cbx + aby * cby) / mag));
  return (Math.acos(v) * 180) / Math.PI;
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const deg = r => (r * 180) / Math.PI;
const lerp = (a, b, u) => a + (b - a) * u;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const PHASE_ORDER = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];
const LEGACY_KEYS = { address: 'P1', top: 'P4', impact: 'P7', finish: 'P10' };

// ---- phases -------------------------------------------------------------
function nearestFrame(frames, t) {
  if (!frames.length) return -1;
  const c = clamp(Math.round(t * SAMPLE_FPS), 0, frames.length - 1);
  for (let d = 0; d <= 3; d++) {
    for (const i of [c - d, c + d]) if (frames[i]?.lm) return i;
  }
  return c;
}

export function makePhase(key, t, frames, manual = false, estimated = false) {
  return { key, label: `${key} ${PHASE_NAMES[key]}`, t, frame: nearestFrame(frames, t), manual, estimated };
}

// Tempo = P1→P4 (backswing) over P4→P7 (downswing).
export function tempoFromPhases(phases) {
  const get = k => phases.find(p => p.key === k);
  const a = get('P1'), top = get('P4'), imp = get('P7');
  if (!a || !top || !imp) return null;
  const back = top.t - a.t, down = imp.t - top.t;
  return back > 0 && down > 0 ? { backswing: back, downswing: down, ratio: back / down } : null;
}

// Move (or create) a phase by hand. Manual phases survive a tracking re-run.
export function setPhase(analysis, key, t) {
  const phase = makePhase(key, t, analysis.frames, true, false);
  const i = analysis.phases.findIndex(p => p.key === key);
  if (i >= 0) analysis.phases[i] = phase; else analysis.phases.push(phase);
  analysis.phases.sort((x, y) => PHASE_ORDER.indexOf(x.key) - PHASE_ORDER.indexOf(y.key));
  analysis.tempo = tempoFromPhases(analysis.phases);
}

export function keepManualPhases(analysis, previous) {
  for (const p of previous?.phases || []) if (p.manual) setPhase(analysis, p.key, p.t);
}

// Saved swings from before the P-system used address/top/impact/finish. Rename in place.
export function migrateLegacy(analysis, club) {
  for (const p of analysis?.phases || []) {
    if (LEGACY_KEYS[p.key]) { p.key = LEGACY_KEYS[p.key]; p.label = `${p.key} ${PHASE_NAMES[p.key]}`; }
  }
  if (club) {
    for (const [old, key] of Object.entries(LEGACY_KEYS)) {
      if (club[old]) { club[key] = club[old]; delete club[old]; }
    }
  }
}

// ---- body metrics (inputs are landmarks already scaled to true pixel proportions) ----
function spineAngle(L) {
  const sh = mid(L[11], L[12]), hip = mid(L[23], L[24]);
  return Math.abs(deg(Math.atan2(sh.x - hip.x, -(sh.y - hip.y))));
}
function shoulderTilt(L) {
  let d = deg(Math.atan2(L[12].y - L[11].y, L[12].x - L[11].x));
  if (d > 90) d -= 180;
  if (d < -90) d += 180;
  return Math.abs(d);
}
function kneeFlex(L) {
  // In a side-on view one leg hides the other, so use whichever side is more visible.
  const left = L[25].v + L[27].v >= L[26].v + L[28].v;
  const [h, k, an] = left ? [23, 25, 27] : [24, 26, 28];
  return 180 - angleBetween(L[h], L[k], L[an]); // 0 = straight leg
}

const scaleLm = (lm, A) => lm.map(p => ({ x: p.x * A, y: p.y, v: p.v }));

// Metrics depend on the camera view: each view can only measure what it can actually see in 2D.
//  Down the Line (side-on): spine angle, knee flex, head height, plane line, hands vs plane.
//  Face On: shoulder tilt, hip/head shift toward the target, stance width, shaft lean.
// Body metrics are taken at P1, P4 and P7. Club metrics at any P-position you've marked:
// `club` = { P1..P10: { t, grip:{x,y}, head:{x,y} } } in 0..1 video coords.
export function computeMetrics({ frames = [], phases = [], view = '', club = null, aspect = 1 }) {
  const A = aspect || 1; // landmarks/marks are 0..1 per axis; x must be scaled by aspect before measuring angles
  const BODY = ['P1', 'P4', 'P7'];

  const at = {};
  for (const p of phases) {
    if (!BODY.includes(p.key)) continue;
    const lm = frames[p.frame]?.lm;
    if (lm) at[p.key] = scaleLm(lm, A);
  }
  const marks = {};
  for (const k of PHASE_ORDER) {
    const c = club?.[k];
    if (c?.grip && c?.head) {
      marks[k] = { grip: { x: c.grip.x * A, y: c.grip.y }, head: { x: c.head.x * A, y: c.head.y } };
    }
  }

  const rows = [];
  const notes = [];
  const addRow = (label, unit, values, signed = false) => {
    if (Object.keys(values).length) rows.push({ label, unit, values, signed });
  };
  const poseRow = (label, unit, fn, keys = BODY, signed = false) => {
    const values = {};
    for (const k of keys) {
      if (!at[k]) continue;
      const v = fn(at[k]);
      if (v != null && isFinite(v)) values[k] = v;
    }
    addRow(label, unit, values, signed);
  };
  const clubRow = (label, unit, fn, keys = PHASE_ORDER, signed = false) => {
    const values = {};
    for (const k of keys) {
      if (!marks[k]) continue;
      const v = fn(marks[k]);
      if (v != null && isFinite(v)) values[k] = v;
    }
    addRow(label, unit, values, signed);
  };

  // Target direction isn't known, so infer it: hips move toward the target going into impact.
  let dir = null;
  if (at.P4 && at.P7) dir = mid(at.P7[23], at.P7[24]).x >= mid(at.P4[23], at.P4[24]).x ? 1 : -1;

  const base = at.P1;
  const noseOk = L => L[0] && L[0].v >= 0.3;
  if (base) {
    if (view === 'Face On') {
      const sw = dist(base[11], base[12]); // address shoulder width = the yardstick
      if (sw > 0.03) {
        const hipX = L => mid(L[23], L[24]).x;
        poseRow('Shoulder tilt', '°', shoulderTilt);
        if (dir !== null) {
          poseRow('Hip shift', '% of shoulder width', L => ((hipX(L) - hipX(base)) * dir / sw) * 100, ['P4', 'P7'], true);
          poseRow('Head shift', '% of shoulder width',
            L => (noseOk(L) && noseOk(base) ? ((L[0].x - base[0].x) * dir / sw) * 100 : null), ['P4', 'P7'], true);
        }
        poseRow('Stance width', '% of shoulder width', L => (dist(L[27], L[28]) / sw) * 100, ['P1']);
      }
    } else {
      const torso = dist(mid(base[11], base[12]), mid(base[23], base[24]));
      poseRow('Spine angle', '° from vertical', spineAngle);
      poseRow('Knee flex', '° (0 = straight)', kneeFlex, ['P1', 'P7']);
      if (torso > 0.03) {
        poseRow('Head height', '% of torso, + = higher',
          L => (noseOk(L) && noseOk(base) ? ((base[0].y - L[0].y) / torso) * 100 : null), ['P4', 'P7'], true);
      }
    }
  }
  if (view === 'Face On' && dir !== null && base) notes.push('Shift and lean are toward the target, inferred from hip movement into impact.');

  // ---- club metrics from hand-marked shafts ----
  const elev = m => deg(Math.atan2(m.grip.y - m.head.y, Math.abs(m.head.x - m.grip.x))); // head above hands = +
  clubRow('Shaft angle', '° above horizontal', elev, PHASE_ORDER, true);

  if (view === 'Face On') {
    if (dir !== null) {
      clubRow('Shaft lean', '° toward target', m => deg(Math.atan2((m.grip.x - m.head.x) * dir, m.head.y - m.grip.y)), ['P1', 'P7'], true);
    }
  } else if (marks.P1) {
    const { grip: g, head: h } = marks.P1;
    const dx = g.x - h.x, dy = g.y - h.y, len = Math.hypot(dx, dy);
    addRow('Plane line angle', '° from horizontal', { P1: deg(Math.atan2(Math.abs(dy), Math.abs(dx))) });
    if (len > 0.02 && Math.abs(dx) > 1e-4) {
      clubRow('Hands vs address plane', '% of shaft length, + = above', m => {
        const P = m.grip;
        const yLine = h.y + (dy / dx) * (P.x - h.x);
        const perp = Math.abs(dx * (P.y - h.y) - dy * (P.x - h.x)) / len;
        return (P.y < yLine ? 1 : -1) * (perp / len) * 100;
      }, PHASE_ORDER.slice(1), true);
    }
  }

  return rows.length ? { view, rows, note: notes.join(' ') } : null;
}

// ---- swing phase detection -------------------------------------------------
function refinePeak(S, k) {
  // Sub-frame time of a hand-height extremum (peak or trough) via a parabola through 3 samples.
  if (k <= 0 || k >= S.length - 1) return S[k].t;
  const ya = S[k - 1].y, yb = S[k].y, yc = S[k + 1].y;
  const den = ya - 2 * yb + yc;
  if (Math.abs(den) <= 1e-9) return S[k].t;
  return S[k].t + clamp((ya - yc) / (2 * den), -1, 1) / SAMPLE_FPS;
}

// Lead arm "parallel to the ground" = lead wrist passes through lead shoulder height.
function armParallel(S, from, to, rising) {
  for (let k = Math.max(1, from + 1); k <= to; k++) {
    const d0 = S[k - 1].lwy - S[k - 1].lsy, d1 = S[k].lwy - S[k].lsy; // + = wrist below shoulder
    if (rising ? d0 > 0 && d1 <= 0 : d0 <= 0 && d1 > 0) {
      const u = clamp(d0 / (d0 - d1), 0, 1);
      return { t: lerp(S[k - 1].t, S[k].t, u), y: lerp(S[k - 1].y, S[k].y, u) };
    }
  }
  return null;
}

// First time the hands pass through a given height (up = moving up the screen).
function levelCross(S, from, to, level, up) {
  for (let k = Math.max(1, from + 1); k <= to; k++) {
    const y0 = S[k - 1].y, y1 = S[k].y;
    if (up ? y0 > level && y1 <= level : y0 < level && y1 >= level) {
      return lerp(S[k - 1].t, S[k].t, clamp((level - y0) / (y1 - y0), 0, 1));
    }
  }
  return null;
}

export function analyzeSwing(frames, view = '', aspect = 1, lefty = false) {
  const empty = { phases: [], tempo: null, note: '' };
  const S = buildSamples(frames, aspect, lefty);
  if (S.length < 10) {
    return { ...empty, note: 'Could not see the golfer clearly enough. Check framing and lighting.' };
  }
  const torso = median(S.map(p => p.torso));

  // --- P1 Address: first stretch where the hands are still and in a sensible place ---
  let ref = null;
  for (let s = 0; s < S.length; s++) {
    let e = s;
    while (e + 1 < S.length && S[e + 1].t - S[s].t <= STABLE_SECONDS) e++;
    if (S[e].t - S[s].t < STABLE_SECONDS * 0.9) break;

    const win = S.slice(s, e + 1);
    const mx = mean(win.map(p => p.x));
    const my = mean(win.map(p => p.y));
    const ok = win.every(
      p =>
        Math.hypot(p.x - mx, p.y - my) < STABLE_TOL * torso &&
        p.y > p.shoulderY &&
        p.y < p.hipY + 0.5 * torso
    );
    if (ok) {
      ref = { x: mx, y: my, end: e };
      break;
    }
  }
  if (!ref) {
    return { ...empty, note: 'Could not find a steady address position at the start of the clip.' };
  }

  // Extend address forward until the hands actually leave (takeaway)
  let a = ref.end;
  while (
    a + 1 < S.length &&
    Math.hypot(S[a + 1].x - ref.x, S[a + 1].y - ref.y) < TAKEAWAY_TOL * torso
  ) {
    a++;
  }

  // Candidates by position; est = estimated rather than directly detected.
  const cand = { P1: { t: S[a].t } };
  const finalize = note => {
    const phases = [];
    let prevT = -Infinity;
    PHASE_ORDER.forEach((key, i) => {
      const c = cand[key];
      if (!c) return;
      const nextCore = PHASE_ORDER.slice(i + 1).find(k => CORE.includes(k) && cand[k]);
      const upper = nextCore ? cand[nextCore].t : Infinity;
      if (!CORE.includes(key) && !(c.t > prevT && c.t < upper)) return; // out of order: drop it
      phases.push(makePhase(key, c.t, frames, false, !!c.est));
      prevT = c.t;
    });
    return { phases, tempo: tempoFromPhases(phases), note };
  };

  // --- P4 Top: hysteresis. Hands rise TOP_RISE above address, then drop TOP_DROP from the peak ---
  let peak = a, armed = false, top = -1;
  for (let k = a + 1; k < S.length; k++) {
    if (S[k].y < S[peak].y) peak = k;
    if (!armed && ref.y - S[peak].y > TOP_RISE * torso) armed = true;
    if (armed && S[k].y - S[peak].y > TOP_DROP * torso) {
      top = peak;
      break;
    }
  }
  if (top < 0) return finalize('Found address but no complete backswing.');
  cand.P4 = { t: refinePeak(S, top) };

  // --- P3 lead arm parallel (back). P2 shaft parallel is estimated from hand height ---
  const p3 = armParallel(S, a, top, true);
  if (p3) cand.P3 = { t: p3.t };
  const level2 = p3 ? ref.y - P2_FRACTION * (ref.y - p3.y) : ref.y - 0.2 * (ref.y - S[top].y);
  const p2 = levelCross(S, a, top, level2, true);
  if (p2 !== null) cand.P2 = { t: p2, est: true };

  // --- P7 Impact: the lowest point of the hands in the downswing (sub-frame refined) ---
  // Mirror image of the top: find the low point, confirm once the hands rise again in the follow-through.
  const fullDrop = ref.y - S[top].y;
  let low = top + 1, imp = -1;
  for (let k = top + 1; k < S.length; k++) {
    if (S[k].y > S[low].y) low = k;
    const descended = S[low].y - S[top].y >= IMPACT_DESCENT * fullDrop;
    if (descended && S[low].y - S[k].y > IMPACT_RISE * torso) { imp = low; break; }
  }
  // Clip may end right at impact, with no follow-through to confirm it.
  if (imp < 0 && S[low].y - S[top].y >= IMPACT_DESCENT * fullDrop) imp = low;
  if (imp < 0) return finalize('Found top of backswing but not impact.');
  cand.P7 = { t: refinePeak(S, imp) };

  // --- P5 lead arm parallel (down), P6 shaft parallel (down, estimated) ---
  const p5 = armParallel(S, top, imp, false);
  if (p5) cand.P5 = { t: p5.t };
  const p6 = levelCross(S, top, imp, level2, false);
  if (p6 !== null) cand.P6 = { t: p6, est: true };

  // --- P10 Finish: highest hands within 2s after impact. P9 lead arm parallel, P8 shaft parallel (estimated) ---
  let fin = imp;
  for (let k = imp + 1; k < S.length && S[k].t - S[imp].t < 2; k++) {
    if (S[k].y < S[fin].y) fin = k;
  }
  const p9 = armParallel(S, imp, fin, true);
  if (p9) cand.P9 = { t: p9.t };
  const p8 = levelCross(S, imp, fin, level2, true);
  if (p8 !== null) cand.P8 = { t: p8, est: true };
  if (fin !== imp) cand.P10 = { t: S[fin].t };

  return finalize('');
}

// ---------------------------------------------------------------------------
// Drawing (reads stored data only)
// ---------------------------------------------------------------------------

// Size/position the canvas over the *rendered* video area (accounts for letterboxing).
export function layoutCanvas(video, canvas) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = video.clientWidth, ch = video.clientHeight;
  if (!vw || !vh || !cw || !ch) return { w: 0, h: 0 };

  const scale = Math.min(cw / vw, ch / vh);
  const w = vw * scale, h = vh * scale;
  const left = video.offsetLeft + (cw - w) / 2;
  const top = video.offsetTop + (ch - h) / 2;
  const dpr = window.devicePixelRatio || 1;

  const key = `${w}|${h}|${left}|${top}|${dpr}`;
  if (canvas.dataset.layout !== key) {
    canvas.dataset.layout = key;
    canvas.style.left = `${left}px`;
    canvas.style.top = `${top}px`;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

export function clearPose(canvas) {
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

export function drawPose(video, canvas, { analysis = null, club = null, pending = null, view = '', fps = 30 } = {}) {
  const { w, h } = layoutCanvas(video, canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!w) return;

  const frames = analysis?.frames || [];
  if (frames.length) {
    const idx = clamp(Math.round(video.currentTime * SAMPLE_FPS), 0, frames.length - 1);
    drawTrail(ctx, w, h, frames, analysis.phases, idx);
    drawSkeleton(ctx, w, h, frames[idx].lm);
  }
  drawClub(ctx, w, h, video, club, pending, view, fps);
  if (analysis?.phases?.length) drawHud(ctx, w, video, analysis);
}

// Path of the hands from address up to the current frame.
function drawTrail(ctx, w, h, frames, phases, idx) {
  const addr = phases.find(p => p.key === 'P1');
  const start = Math.max(0, addr ? addr.frame : 0);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,214,10,0.9)';
  ctx.lineWidth = Math.max(2, w * 0.005);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let pen = false;
  for (let i = start; i <= idx; i++) {
    const L = frames[i].lm;
    if (!L || L[15].v < 0.3 || L[16].v < 0.3) { pen = false; continue; }
    const x = ((L[15].x + L[16].x) / 2) * w, y = ((L[15].y + L[16].y) / 2) * h;
    if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
  }
  ctx.stroke();
  ctx.restore();
}

function drawSkeleton(ctx, w, h, L) {
  if (!L) return;
  ctx.lineWidth = Math.max(2, w * 0.006);
  ctx.strokeStyle = '#00ff66';
  ctx.beginPath();
  for (const [a, b] of CONNECTIONS) {
    if (L[a].v < 0.3 || L[b].v < 0.3) continue;
    ctx.moveTo(L[a].x * w, L[a].y * h);
    ctx.lineTo(L[b].x * w, L[b].y * h);
  }
  ctx.stroke();
  ctx.fillStyle = '#ff3b30';
  for (let i = 11; i < L.length; i++) {
    if (L[i].v < 0.3) continue;
    ctx.beginPath();
    ctx.arc(L[i].x * w, L[i].y * h, Math.max(3, w * 0.008), 0, Math.PI * 2);
    ctx.fill();
  }
}

// Hand-marked club: the address plane line (down-the-line only) and each marked shaft when you're on its frame.
function drawClub(ctx, w, h, video, club, pending, view, fps) {
  const P = p => [p.x * w, p.y * h];
  const lw = Math.max(2, w * 0.006);
  const dot = (x, y, r, fill) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill) ctx.fill(); else ctx.stroke();
  };

  const A = club?.P1;
  if (view !== 'Face On' && A?.grip && A?.head) {
    const [gx, gy] = P(A.grip), [hx, hy] = P(A.head);
    const dx = gx - hx, dy = gy - hy, len = Math.hypot(dx, dy);
    if (len > 1) {
      const k = (w + h) / len;
      ctx.save();
      ctx.setLineDash([10, 8]);
      ctx.strokeStyle = '#ff9f0a';
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx + dx * k, hy + dy * k);
      ctx.stroke();
      ctx.restore();
    }
  }

  const tol = 1.5 / fps;
  ctx.save();
  ctx.strokeStyle = '#32d2ff';
  ctx.fillStyle = '#32d2ff';
  ctx.lineWidth = lw;
  for (const key of PHASE_ORDER) {
    const m = club?.[key];
    if (!m?.grip || !m?.head || Math.abs(video.currentTime - m.t) > tol) continue;
    const [gx, gy] = P(m.grip), [hx, hy] = P(m.head);
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    dot(gx, gy, lw * 1.6, true);
    dot(hx, hy, lw * 2.2, false);
  }
  if (pending?.grip) {
    const [gx, gy] = P(pending.grip);
    dot(gx, gy, lw * 2.4, false);
    dot(gx, gy, lw * 1.2, true);
  }
  ctx.restore();
}

function drawHud(ctx, w, video, analysis) {
  const now = video.currentTime + 0.5 / SAMPLE_FPS;
  const current = analysis.phases.filter(p => p.t <= now).pop();
  if (!current) return;

  const fs = Math.max(12, Math.round(w * 0.034));
  const pad = fs * 0.5;
  ctx.font = `600 ${fs}px -apple-system, Arial, sans-serif`;
  ctx.textBaseline = 'top';

  const box = (lines, y) => {
    const width = Math.max(...lines.map(s => ctx.measureText(s).width)) + pad * 2;
    const height = lines.length * fs * 1.35 + pad * 2 - fs * 0.35;
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(10, y, width, height);
    ctx.fillStyle = '#fff';
    lines.forEach((s, n) => ctx.fillText(s, 10 + pad, y + pad + n * fs * 1.35));
    return y + height + 8;
  };

  let y = 10;
  y = box([`${current.label}  ${current.t.toFixed(2)}s`], y);
  const impact = analysis.phases.find(p => p.key === 'P7');
  if (analysis.tempo && impact && now >= impact.t) {
    box([`Tempo ${analysis.tempo.ratio.toFixed(1)} : 1`], y);
  }
}

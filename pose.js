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
const IMPACT_BAND = 0.10;     // impact = hands back within this distance of address height

const CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [28, 30], [30, 32],
];

const PHASE_LABELS = {
  address: 'ADDRESS',
  top: 'TOP OF BACKSWING',
  impact: 'IMPACT',
  finish: 'FINISH',
};

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

export async function analyzeVideo(video, { view = '', onProgress = () => {}, signal } = {}) {
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
  return { frames, view, ...analyzeSwing(frames, view) };
}

// ---------------------------------------------------------------------------
// Swing analysis from the full trajectory
// ---------------------------------------------------------------------------
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const median = a => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

function buildSamples(frames) {
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
      x: (L[15].x + L[16].x) / 2,
      y: (L[15].y + L[16].y) / 2,
      shoulderY,
      hipY,
      torso: Math.max(0.05, hipY - shoulderY),
    });
  });

  // 5-sample moving average to kill landmark jitter
  const W = 2;
  return raw.map((p, k) => {
    let sx = 0, sy = 0, c = 0;
    for (let j = Math.max(0, k - W); j <= Math.min(raw.length - 1, k + W); j++) {
      sx += raw[j].x;
      sy += raw[j].y;
      c++;
    }
    return { ...p, x: sx / c, y: sy / c };
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

// Metrics depend on the camera view: each view can only measure what it can actually see in 2D.
//  Down the Line (side-on): spine angle, knee flex, head height.
//  Face On: shoulder tilt, hip/head shift toward the target, stance width.
function buildMetrics(frames, phases, view) {
  const at = {};
  for (const p of phases) {
    if (['address', 'top', 'impact'].includes(p.key) && frames[p.frame]?.lm) at[p.key] = frames[p.frame].lm;
  }
  const base = at.address;
  if (!base) return null;

  const rows = [];
  const row = (label, unit, fn, keys = ['address', 'top', 'impact'], signed = false) => {
    const values = {};
    for (const k of keys) {
      if (!at[k]) continue;
      const v = fn(at[k]);
      if (v != null && isFinite(v)) values[k] = v;
    }
    if (Object.keys(values).length) rows.push({ label, unit, values, signed });
  };
  const noseOk = L => L[0] && L[0].v >= 0.3;

  let note = '';
  if (view === 'Face On') {
    const sw = dist(base[11], base[12]); // address shoulder width = the yardstick
    if (sw > 0.03) {
      // Target direction isn't known, so infer it: hips move toward the target going into impact.
      let dir = 1;
      if (at.top && at.impact) {
        dir = mid(at.impact[23], at.impact[24]).x >= mid(at.top[23], at.top[24]).x ? 1 : -1;
        note = 'Shift is measured toward the target, inferred from hip movement into impact.';
      }
      const hipX = L => mid(L[23], L[24]).x;
      row('Shoulder tilt', '°', shoulderTilt);
      row('Hip shift', '% of shoulder width', L => ((hipX(L) - hipX(base)) * dir / sw) * 100, ['top', 'impact'], true);
      row('Head shift', '% of shoulder width',
        L => (noseOk(L) && noseOk(base) ? ((L[0].x - base[0].x) * dir / sw) * 100 : null), ['top', 'impact'], true);
      row('Stance width', '% of shoulder width', L => (dist(L[27], L[28]) / sw) * 100, ['address']);
    }
  } else {
    const torso = dist(mid(base[11], base[12]), mid(base[23], base[24]));
    row('Spine angle', '° from vertical', spineAngle);
    row('Knee flex', '° (0 = straight)', kneeFlex, ['address', 'impact']);
    if (torso > 0.03) {
      row('Head height', '% of torso, + = higher',
        L => (noseOk(L) && noseOk(base) ? ((base[0].y - L[0].y) / torso) * 100 : null), ['top', 'impact'], true);
    }
  }
  return { view, rows, note };
}

export function analyzeSwing(frames, view = '') {
  const empty = { phases: [], metrics: null, tempo: null, note: '' };
  const S = buildSamples(frames);
  if (S.length < 10) {
    return { ...empty, note: 'Could not see the golfer clearly enough. Check framing and lighting.' };
  }
  const torso = median(S.map(p => p.torso));

  // --- Address: first stretch where the hands are still and in a sensible place ---
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

  const phases = [{ key: 'address', label: PHASE_LABELS.address, t: S[a].t, frame: S[a].i }];

  // --- Top: hysteresis. Hands rise TOP_RISE above address, then drop TOP_DROP from the peak ---
  let peak = a, armed = false, top = -1;
  for (let k = a + 1; k < S.length; k++) {
    if (S[k].y < S[peak].y) peak = k;
    if (!armed && ref.y - S[peak].y > TOP_RISE * torso) armed = true;
    if (armed && S[k].y - S[peak].y > TOP_DROP * torso) {
      top = peak;
      break;
    }
  }
  if (top < 0) {
    return { phases, metrics: buildMetrics(frames, phases, view), tempo: null, note: 'Found address but no complete backswing.' };
  }
  phases.push({ key: 'top', label: PHASE_LABELS.top, t: S[top].t, frame: S[top].i });

  // --- Impact: hands return to about address height ---
  let imp = -1;
  for (let k = top + 1; k < S.length; k++) {
    if (S[k].y >= ref.y - IMPACT_BAND * torso) {
      imp = k;
      break;
    }
  }
  if (imp < 0) {
    return { phases, metrics: buildMetrics(frames, phases, view), tempo: null, note: 'Found top of backswing but not impact.' };
  }
  phases.push({ key: 'impact', label: PHASE_LABELS.impact, t: S[imp].t, frame: S[imp].i });

  // --- Finish: highest hands within 2s after impact ---
  let fin = imp;
  for (let k = imp + 1; k < S.length && S[k].t - S[imp].t < 2; k++) {
    if (S[k].y < S[fin].y) fin = k;
  }
  if (fin !== imp) {
    phases.push({ key: 'finish', label: PHASE_LABELS.finish, t: S[fin].t, frame: S[fin].i });
  }

  const back = S[top].t - S[a].t;
  const down = S[imp].t - S[top].t;
  const tempo = down > 0 ? { backswing: back, downswing: down, ratio: back / down } : null;

  return { phases, metrics: buildMetrics(frames, phases, view), tempo, note: '' };
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

export function drawPose(video, canvas, analysis) {
  const { w, h } = layoutCanvas(video, canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!w || !analysis?.frames?.length) return;

  const idx = Math.min(
    analysis.frames.length - 1,
    Math.max(0, Math.round(video.currentTime * SAMPLE_FPS))
  );
  const L = analysis.frames[idx].lm;

  // Skeleton
  if (L) {
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

  // HUD
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

  const impact = analysis.phases.find(p => p.key === 'impact');
  if (analysis.tempo && impact && now >= impact.t) {
    box([`Tempo ${analysis.tempo.ratio.toFixed(1)} : 1`], y);
  }
}

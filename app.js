const $ = s => document.querySelector(s);
const screens = { home: $('#home'), camera: $('#camera'), review: $('#review'), saved: $('#saved') };

let currentView = '';
let stream = null, recorder = null, chunks = [], recording = false;
let videoUrl = null;                 // current blob URL (revoked when replaced)
let tool = 'line', points = [];
let currentBlob = null, currentSwingId = null;
let club = {};                       // hand-marked shafts: { address|top|impact: { t, grip, head } } in 0..1 video coords
let clubStep = null;                 // { key, part: 'grip'|'head', grip? } while marking
let metrics = null;
let selectedPhase = 'address';
let videoFps = 30;                   // refined from playback timing below
let saveTimer = null;
let Store = null;                    // lazily imported store.js

// Auto-tracking state
let Pose = null;                     // lazily imported pose.js module
let analysis = null;
let analysisAbort = null;
let analyzing = false;

const swingVideo = $('#swingVideo');
const poseCanvas = $('#poseOverlay');

function show(name) {
  Object.values(screens).forEach(x => x.classList.remove('active'));
  screens[name].classList.add('active');
}
function formatTime(sec) {
  if (!isFinite(sec)) return '0:00';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- navigation
document.querySelectorAll('[data-view]').forEach(b => (b.onclick = async () => {
  currentView = b.dataset.view;
  $('#cameraViewName').textContent = currentView;
  $('#cameraStatus').textContent = 'Position yourself in the frame.';
  show('camera');
  await startCamera();
}));
$('#cameraBack').onclick = () => { stopCamera(); show('home'); };
$('#reviewBack').onclick = () => { swingVideo.pause(); show('home'); };
$('#newSwing').onclick = () => { stopCamera(); swingVideo.pause(); show('home'); };
$('#savedBack').onclick = () => show('home');
$('#openSaved').onclick = () => { loadSaved(); show('saved'); };

// ------------------------------------------------------------------- camera
async function startCamera() {
  stopCamera(); // never hold two streams
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
      audio: false, // no mic prompt needed
    });
    $('#cameraVideo').srcObject = stream;
  } catch (e) {
    $('#cameraStatus').textContent = 'Camera access was not available. Check Safari camera permission.';
  }
}
function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  $('#cameraVideo').srcObject = null;
}

$('#recordButton').onclick = () => (recording ? stopRecording() : startRecording());

function startRecording() {
  if (!stream) { alert('Camera is not available.'); return; }
  chunks = [];
  const opts = {};
  if (MediaRecorder.isTypeSupported('video/mp4')) opts.mimeType = 'video/mp4';
  else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) opts.mimeType = 'video/webm;codecs=vp9';
  try { recorder = new MediaRecorder(stream, opts); } catch (e) { recorder = new MediaRecorder(stream); }

  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || 'video/mp4' });
    stopCamera(); // release the camera as soon as recording ends
    $('#camera').classList.remove('recording');
    loadVideo(blob);
  };
  recorder.start();
  recording = true;
  $('#camera').classList.add('recording');
  $('#cameraStatus').textContent = 'Recording… make your swing.';
}
function stopRecording() {
  recorder.stop();
  recording = false;
  $('#cameraStatus').textContent = 'Processing swing…';
}

// ------------------------------------------------------- upload from library
$('#uploadButton').onclick = () => {
  const picker = $('#videoPicker');
  picker.value = '';
  picker.click();
};
$('#videoPicker').onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('video/')) { alert('Please select a video file.'); return; }
  stopCamera();
  loadVideo(file);
};

// One place that swaps the review video and resets everything tied to the old one.
// opts.id / opts.analysis are set when reopening a saved swing.
async function loadVideo(blob, opts = {}) {
  if (analysisAbort) analysisAbort.abort();
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  const url = (videoUrl = URL.createObjectURL(blob));
  currentBlob = blob;
  currentSwingId = opts.id || null;

  analysis = null;
  club = opts.club || {};
  clubStep = null;
  metrics = null;
  selectedPhase = 'address';
  if (Pose) Pose.clearPose(poseCanvas);
  resetTrackingUi();
  clearOverlay();
  $('#saveSwing').textContent = currentSwingId ? 'Update Saved Swing' : 'Save Swing';

  swingVideo.pause();
  swingVideo.src = url;
  swingVideo.load();
  $('#emptyReview').style.display = 'none';
  $('#playPause').textContent = '▶';
  show('review');

  updateClubUi();
  if (opts.analysis || Object.keys(club).length) {
    try {
      await ensurePose();
      if (videoUrl !== url) return; // another video was loaded meanwhile
      analysis = opts.analysis || null;
      if (analysis) $('#autoTrackingBtn').textContent = 'Re-run Tracking';
      renderPhases();
      refreshMetrics();
      redrawPose();
    } catch (e) {
      console.error('Could not restore saved data', e);
    }
  }
}

// ------------------------------------------------------------------- review
swingVideo.onloadedmetadata = () => {
  $('#seekBar').max = swingVideo.duration || 100;
  updateTime();
};
swingVideo.ontimeupdate = updateTime;
function updateTime() {
  $('#timeLabel').textContent = `${formatTime(swingVideo.currentTime)} / ${formatTime(swingVideo.duration)}`;
  if (swingVideo.duration) $('#seekBar').value = swingVideo.currentTime;
}
$('#seekBar').oninput = e => { swingVideo.currentTime = Number(e.target.value); };
$('#playPause').onclick = () => {
  if (swingVideo.paused) { swingVideo.play(); $('#playPause').textContent = '❚❚'; }
  else { swingVideo.pause(); $('#playPause').textContent = '▶'; }
};
swingVideo.addEventListener('ended', () => { $('#playPause').textContent = '▶'; });

// ------------------------------------------------------- manual line / angle
document.querySelectorAll('[data-tool]').forEach(b => (b.onclick = () => {
  if (b.dataset.tool === 'clear') { clearOverlay(); return; } // keep the current tool selected
  tool = b.dataset.tool;
  points = [];
  document.querySelectorAll('.toolButton').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $('#toolTitle').textContent = tool === 'line' ? 'Line Tool' : 'Angle Tool';
  $('#toolHelp').textContent = tool === 'line'
    ? 'Tap two points on the video to draw a line.'
    : 'Tap three points: vertex, then the two ends of the angle.';
  clearOverlay();
}));

const canvas = $('#overlay'), ctx = canvas.getContext('2d');
function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * devicePixelRatio);
  canvas.height = Math.round(r.height * devicePixelRatio);
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  drawOverlay();
}
window.addEventListener('resize', resizeCanvas);
swingVideo.addEventListener('loadeddata', () => setTimeout(resizeCanvas, 100));

function pos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
canvas.addEventListener('pointerdown', e => {
  if (clubStep) { handleClubTap(e); return; }
  const needed = tool === 'line' ? 2 : 3;
  if (points.length >= needed) points = []; // a new tap starts a fresh measurement
  points.push(pos(e));
  drawOverlay();
});
function drawOverlay() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#000';
  ctx.shadowBlur = 4;

  points.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill(); });

  if (tool === 'line' && points.length >= 2) {
    line(points[0], points[1]);
    $('#angleReadout').textContent = '—';
  }
  if (tool === 'angle' && points.length >= 2) {
    line(points[1], points[0]);
    if (points.length >= 3) {
      line(points[0], points[2]);
      const a = Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x);
      const b = Math.atan2(points[2].y - points[0].y, points[2].x - points[0].x);
      let deg = Math.abs((a - b) * 180 / Math.PI);
      if (deg > 180) deg = 360 - deg;
      $('#angleReadout').textContent = `${deg.toFixed(1)}°`;
    }
  }
}
function line(a, b) {
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  [a, b].forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill(); });
}
function clearOverlay() {
  points = [];
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  $('#angleReadout').textContent = '—';
}

// ------------------------------------------------------------- auto tracking
function redrawPose() {
  if (analyzing || !Pose) return;
  Pose.drawPose(swingVideo, poseCanvas, {
    analysis, club, view: currentView, fps: videoFps,
    pending: clubStep && clubStep.grip ? { grip: clubStep.grip } : null,
  });
}
['seeked', 'timeupdate', 'loadeddata', 'pause'].forEach(ev => swingVideo.addEventListener(ev, redrawPose));
window.addEventListener('resize', redrawPose);
if ('requestVideoFrameCallback' in swingVideo) {
  // Fires once per decoded frame, so the skeleton stays locked to playback.
  // While playing, consecutive frame timestamps tell us the clip's real frame rate (used by the frame-step buttons).
  let lastMedia = null, lastPresented = null;
  const deltas = [];
  const loop = (now, meta) => {
    if (!swingVideo.paused && lastMedia !== null && meta.presentedFrames - lastPresented === 1) {
      const d = meta.mediaTime - lastMedia;
      if (d > 0.001 && d < 0.1) {
        deltas.push(d);
        if (deltas.length > 31) deltas.shift();
        if (deltas.length >= 8) videoFps = 1 / [...deltas].sort((x, y) => x - y)[deltas.length >> 1];
      }
    }
    lastMedia = meta.mediaTime;
    lastPresented = meta.presentedFrames;
    redrawPose();
    swingVideo.requestVideoFrameCallback(loop);
  };
  swingVideo.requestVideoFrameCallback(loop);
}

function resetTrackingUi() {
  const btn = $('#autoTrackingBtn');
  btn.disabled = false;
  btn.textContent = 'Enable Auto Tracking';
  $('#trackingSummary').textContent = '';
  renderPhases();
  renderMetrics();
}

const PHASE_KEYS = [['address', 'Address'], ['top', 'Top'], ['impact', 'Impact'], ['finish', 'Finish']];

async function ensurePose() { return Pose || (Pose = await import('./pose.js?v=11')); }

// Phases can be set by hand before (or without) tracking, so keep a stub analysis around when needed.
function ensureAnalysis() {
  if (!analysis) {
    analysis = {
      frames: [], phases: [], tempo: null, note: '', view: currentView,
      aspect: swingVideo.videoWidth ? swingVideo.videoWidth / swingVideo.videoHeight : 1,
    };
  }
  return analysis;
}

function renderPhases() {
  const row = $('#phaseRow');
  row.innerHTML = '';
  PHASE_KEYS.forEach(([key, label]) => {
    const p = analysis && analysis.phases.find(x => x.key === key);
    const b = document.createElement('button');
    b.className = 'phaseButton' + (p ? '' : ' missing') + (selectedPhase === key ? ' selected' : '') + (p && p.manual ? ' manual' : '');
    b.textContent = label;
    b.onclick = () => {
      selectedPhase = key;
      swingVideo.pause();
      $('#playPause').textContent = '▶';
      if (p) swingVideo.currentTime = p.t;
      renderPhases();
    };
    row.appendChild(b);
  });
  const label = PHASE_KEYS.find(k => k[0] === selectedPhase)[1];
  $('#setPhase').textContent = `Set ${label} to this frame`;

  const parts = [];
  if (analysis && analysis.tempo) {
    parts.push(`Tempo ${analysis.tempo.ratio.toFixed(1)}:1 (backswing ${analysis.tempo.backswing.toFixed(2)}s, downswing ${analysis.tempo.downswing.toFixed(2)}s)`);
  }
  if (analysis && analysis.note) parts.push(analysis.note);
  $('#trackingSummary').textContent = parts.join(' • ');
}

function stepFrame(dir) {
  if (!swingVideo.getAttribute('src')) return;
  swingVideo.pause();
  $('#playPause').textContent = '▶';
  const n = Math.floor(swingVideo.currentTime * videoFps + 1e-3) + dir;
  swingVideo.currentTime = Math.min(swingVideo.duration || 0, Math.max(0, (n + 0.5) / videoFps)); // aim for mid-frame
}
$('#stepBack').onclick = () => stepFrame(-1);
$('#stepFwd').onclick = () => stepFrame(1);

$('#setPhase').onclick = async () => {
  if (!swingVideo.getAttribute('src')) return;
  swingVideo.pause();
  $('#playPause').textContent = '▶';
  await ensurePose();
  ensureAnalysis();
  Pose.setPhase(analysis, selectedPhase, swingVideo.currentTime);
  renderPhases();
  refreshMetrics();
  redrawPose();
  queueSave();
};

// ---------------------------------------------------------------- club marking
function updateClubUi() {
  const row = $('#clubRow');
  row.innerHTML = '';
  PHASE_KEYS.slice(0, 3).forEach(([key, label]) => {
    const b = document.createElement('button');
    b.className = 'phaseButton' + (clubStep && clubStep.key === key ? ' selected' : '');
    b.textContent = (club[key] ? '✓ ' : '') + label;
    b.onclick = () => toggleClubStep(key);
    row.appendChild(b);
  });
  const clr = document.createElement('button');
  clr.className = 'phaseButton danger';
  clr.textContent = 'Clear';
  clr.onclick = clearClub;
  row.appendChild(clr);

  $('#clubHelp').textContent = !clubStep
    ? 'Pick a position, then tap the grip end and the club head on that frame.'
    : clubStep.part === 'grip'
      ? 'Tap the grip end of the club (top of the handle).'
      : 'Now tap the club head.';
}

async function toggleClubStep(key) {
  if (!swingVideo.getAttribute('src')) { alert('Record or upload a swing first.'); return; }
  if (clubStep && clubStep.key === key) { clubStep = null; updateClubUi(); redrawPose(); return; } // tap again to cancel
  await ensurePose();
  swingVideo.pause();
  $('#playPause').textContent = '▶';
  const p = analysis && analysis.phases.find(x => x.key === key);
  if (p) swingVideo.currentTime = p.t;
  clubStep = { key, part: 'grip' };
  updateClubUi();
  redrawPose();
}

function handleClubTap(e) {
  const r = poseCanvas.getBoundingClientRect(); // this canvas sits exactly over the video image
  if (!r.width || !r.height) return;
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;

  if (clubStep.part === 'grip') {
    clubStep.grip = { x, y };
    clubStep.part = 'head';
    updateClubUi();
    redrawPose();
    return;
  }
  club[clubStep.key] = { t: swingVideo.currentTime, grip: clubStep.grip, head: { x, y } };
  clubStep = null;
  clubChanged();
}

function clearClub() {
  club = {};
  clubStep = null;
  clubChanged();
}

function clubChanged() {
  updateClubUi();
  refreshMetrics();
  redrawPose();
  queueSave();
}

function refreshMetrics() {
  if (!Pose) { metrics = null; renderMetrics(); return; }
  const aspect = swingVideo.videoWidth ? swingVideo.videoWidth / swingVideo.videoHeight : (analysis && analysis.aspect) || 1;
  metrics = Pose.computeMetrics({
    frames: analysis ? analysis.frames : [],
    phases: analysis ? analysis.phases : [],
    view: currentView, club, aspect,
  });
  renderMetrics();
}
swingVideo.addEventListener('loadedmetadata', refreshMetrics);

// Auto-save edits to a swing that's already been saved (debounced).
function queueSave() {
  if (!currentSwingId) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!currentSwingId || !currentBlob) return;
    try {
      const st = await getStore();
      await st.saveSwing({ id: currentSwingId, blob: currentBlob, analysis, club });
    } catch (e) { console.error('Auto-save failed', e); }
  }, 600);
}

$('#autoTrackingBtn').onclick = async () => {
  const btn = $('#autoTrackingBtn');
  if (!swingVideo.getAttribute('src')) { alert('Record or upload a swing first.'); return; }
  if (analyzing) { analysisAbort?.abort(); return; } // tap again to cancel

  analyzing = true;
  analysisAbort = new AbortController();
  swingVideo.pause();
  $('#playPause').textContent = '▶';
  Pose?.clearPose(poseCanvas);

  try {
    Pose = Pose || await import('./pose.js?v=11');
    btn.textContent = 'Loading model… (tap to cancel)';
    const previous = analysis;
    analysis = await Pose.analyzeVideo(swingVideo, {
      view: currentView,
      signal: analysisAbort.signal,
      onProgress: (p, msg) => { btn.textContent = `${msg} ${Math.round(p * 100)}% (tap to cancel)`; },
    });
    Pose.keepManualPhases(analysis, previous);
    analyzing = false;
    renderPhases();
    refreshMetrics();
    redrawPose();
    btn.textContent = 'Re-run Tracking';
    queueSave(); // keep an already-saved swing up to date
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('Automatic tracking failed:', error);
      alert('Tracking Error: ' + error.message);
    }
    btn.textContent = analysis ? 'Re-run Tracking' : 'Enable Auto Tracking';
  } finally {
    analyzing = false;
    analysisAbort = null;
    btn.disabled = false;
  }
};

// ------------------------------------------------------------------- metrics
function renderMetrics() {
  const el = $('#metricsTable');
  const m = metrics;
  if (!m || !m.rows.length) { el.innerHTML = ''; return; }
  const cols = [['address', 'Address'], ['top', 'Top'], ['impact', 'Impact']];
  const cell = (row, k) => {
    const v = row.values[k];
    if (v == null) return '<td>–</td>';
    const n = Math.round(v);
    return `<td>${row.signed && n > 0 ? '+' : ''}${n}</td>`;
  };
  el.innerHTML =
    `<h3>${escapeHtml(m.view || 'Swing')} measurements</h3>` +
    `<table><thead><tr><th></th>${cols.map(c => `<th>${c[1]}</th>`).join('')}</tr></thead><tbody>` +
    m.rows.map(r => `<tr><th>${escapeHtml(r.label)}<small>${escapeHtml(r.unit)}</small></th>${cols.map(c => cell(r, c[0])).join('')}</tr>`).join('') +
    `</tbody></table>` +
    (m.note ? `<p class="metricsNote">${escapeHtml(m.note)}</p>` : '');
}

// -------------------------------------------------------------- saved swings
async function getStore() { return Store || (Store = await import('./store.js?v=2')); }

$('#saveSwing').onclick = async () => {
  if (!currentBlob) { alert('Nothing to save yet.'); return; }
  const btn = $('#saveSwing');
  let name;
  if (!currentSwingId) {
    name = prompt('Name this swing:', 'Driver swing');
    if (!name) return;
  }
  btn.disabled = true;
  try {
    const st = await getStore();
    const meta = await st.saveSwing({ id: currentSwingId, name, view: currentView, blob: currentBlob, analysis, club });
    currentSwingId = meta.id;
    btn.textContent = 'Update Saved Swing';
    st.requestPersistence();
    alert(name ? 'Swing saved.' : 'Saved swing updated.');
  } catch (e) {
    console.error(e);
    alert('Could not save: ' + e.message);
  } finally {
    btn.disabled = false;
  }
};

// Old versions kept name/date only, in localStorage. Move them over once.
async function migrateLegacy(st) {
  const raw = localStorage.getItem('gsa_saved_v1');
  if (!raw) return;
  try {
    for (const item of JSON.parse(raw)) await st.saveLegacy(item);
    localStorage.removeItem('gsa_saved_v1');
  } catch (e) { console.error('Legacy migration failed', e); }
}

function fmtDate(d) {
  const x = new Date(d);
  return isNaN(x) ? String(d) : x.toLocaleString();
}

async function loadSaved() {
  const list = $('#savedList');
  try {
    const st = await getStore();
    await migrateLegacy(st);
    const items = await st.listSwings();
    list.innerHTML = items.length
      ? items.map(s => {
          const bits = [s.view, fmtDate(s.date)];
          if (s.tempo) bits.push(`Tempo ${s.tempo.toFixed(1)}:1`);
          if (s.size) bits.push(`${(s.size / 1048576).toFixed(1)} MB`);
          if (!s.hasVideo) bits.push('no video (saved before video storage)');
          return `<div class="savedItem" data-id="${escapeHtml(s.id)}">
            <div class="savedInfo"><b>${escapeHtml(s.name)}</b><small>${bits.filter(Boolean).map(escapeHtml).join(' • ')}</small></div>
            <div class="savedActions">
              ${s.hasVideo ? '<button class="smallButton" data-act="open">Open</button>' : ''}
              <button class="smallButton danger" data-act="delete">Delete</button>
            </div></div>`;
        }).join('')
      : '<div class="infoCard"><b>No saved swings yet.</b><p>Saved swings will appear here.</p></div>';
  } catch (e) {
    console.error(e);
    list.innerHTML = `<div class="infoCard"><b>Couldn’t read saved swings.</b><p>${escapeHtml(e.message)}</p></div>`;
  }
}

$('#savedList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.savedItem').dataset.id;
  try {
    const st = await getStore();
    if (btn.dataset.act === 'open') {
      const rec = await st.getSwing(id);
      if (!rec || !rec.blob) { alert('No video is stored for this swing.'); return; }
      currentView = rec.meta.view || currentView;
      await loadVideo(rec.blob, { id, analysis: rec.analysis, club: rec.club });
    } else if (confirm('Delete this saved swing?')) {
      await st.deleteSwing(id);
      if (currentSwingId === id) { currentSwingId = null; $('#saveSwing').textContent = 'Save Swing'; }
      loadSaved();
    }
  } catch (err) {
    console.error(err);
    alert('Something went wrong: ' + err.message);
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

// initial UI
renderPhases();
updateClubUi();
renderMetrics();

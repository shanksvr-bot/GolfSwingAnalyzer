const $ = s => document.querySelector(s);
const screens = { home: $('#home'), camera: $('#camera'), review: $('#review'), saved: $('#saved') };

let currentView = '';
let stream = null, recorder = null, chunks = [], recording = false;
let videoUrl = null;                 // current blob URL (revoked when replaced)
let tool = 'line', points = [];
let savedSwings = JSON.parse(localStorage.getItem('gsa_saved_v1') || '[]');

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
    loadVideo(URL.createObjectURL(blob));
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
  loadVideo(URL.createObjectURL(file));
};

// One place that swaps the review video and resets everything tied to the old one.
function loadVideo(url) {
  if (analysisAbort) analysisAbort.abort();
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = url;

  analysis = null;
  if (Pose) Pose.clearPose(poseCanvas);
  resetTrackingUi();
  clearOverlay();

  swingVideo.pause();
  swingVideo.src = url;
  swingVideo.load();
  $('#emptyReview').style.display = 'none';
  $('#playPause').textContent = '▶';
  show('review');
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
  if (analyzing || !analysis || !Pose) return;
  Pose.drawPose(swingVideo, poseCanvas, analysis);
}
['seeked', 'timeupdate', 'loadeddata', 'pause'].forEach(ev => swingVideo.addEventListener(ev, redrawPose));
window.addEventListener('resize', redrawPose);
if ('requestVideoFrameCallback' in swingVideo) {
  // Fires once per decoded frame, so the skeleton stays locked to playback.
  const loop = () => { redrawPose(); swingVideo.requestVideoFrameCallback(loop); };
  swingVideo.requestVideoFrameCallback(loop);
}

function resetTrackingUi() {
  const btn = $('#autoTrackingBtn');
  btn.disabled = false;
  btn.textContent = 'Enable Auto Tracking';
  $('#trackingSummary').textContent = '';
  $('#phaseRow').innerHTML = '';
}

function renderPhases() {
  const row = $('#phaseRow');
  row.innerHTML = '';
  analysis.phases.forEach(p => {
    const b = document.createElement('button');
    b.className = 'phaseButton';
    b.textContent = p.key === 'top' ? 'Top' : p.label[0] + p.label.slice(1).toLowerCase();
    b.onclick = () => {
      swingVideo.pause();
      $('#playPause').textContent = '▶';
      swingVideo.currentTime = p.t;
    };
    row.appendChild(b);
  });

  const parts = [];
  if (analysis.tempo) {
    parts.push(`Tempo ${analysis.tempo.ratio.toFixed(1)}:1 (backswing ${analysis.tempo.backswing.toFixed(2)}s, downswing ${analysis.tempo.downswing.toFixed(2)}s)`);
  }
  if (analysis.note) parts.push(analysis.note);
  $('#trackingSummary').textContent = parts.join(' • ');
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
    Pose = Pose || await import('./pose.js?v=9');
    btn.textContent = 'Loading model… (tap to cancel)';
    analysis = await Pose.analyzeVideo(swingVideo, {
      signal: analysisAbort.signal,
      onProgress: (p, msg) => { btn.textContent = `${msg} ${Math.round(p * 100)}% (tap to cancel)`; },
    });
    analyzing = false;
    renderPhases();
    redrawPose();
    btn.textContent = 'Re-run Tracking';
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

// -------------------------------------------------------------- saved swings
$('#saveSwing').onclick = () => {
  const name = prompt('Name this swing:', 'Driver swing');
  if (!name) return;
  savedSwings.unshift({ name, view: currentView, date: new Date().toLocaleString() });
  localStorage.setItem('gsa_saved_v1', JSON.stringify(savedSwings));
  alert('Swing saved.');
  loadSaved();
};
function loadSaved() {
  $('#savedList').innerHTML = savedSwings.length
    ? savedSwings.map(s => `<div class="savedItem"><b>${escapeHtml(s.name)}</b><small>${escapeHtml(s.view)} • ${escapeHtml(s.date)}</small></div>`).join('')
    : '<div class="infoCard"><b>No saved swings yet.</b><p>Saved swings will appear here.</p></div>';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}
loadSaved();

import { FilesetResolver, PoseLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs";

const $=s=>document.querySelector(s);
const screens={home:$('#home'),camera:$('#camera'),review:$('#review')};
let currentView='',stream=null,recorder=null,chunks=[],recording=false;
let tool='line',points=[],poseLandmarker=null,poseReady=false,poseLoop=false,lastPoseTime=-1;

function show(name){Object.values(screens).forEach(x=>x.classList.remove('active'));screens[name].classList.add('active')}
function formatTime(sec){if(!isFinite(sec))return '0:00.000';return `${Math.floor(sec/60)}:${String(Math.floor(sec%60)).padStart(2,'0')}.${String(Math.floor((sec%1)*1000)).padStart(3,'0')}`}
function frameStep(){return 1/30}

document.querySelectorAll('[data-view]').forEach(b=>b.onclick=async()=>{currentView=b.dataset.view;$('#cameraViewName').textContent=currentView;show('camera');await startCamera()});
$('#cameraBack').onclick=()=>stopCamera();
$('#newSwing').onclick=()=>{stopCamera();show('home')};

async function startCamera(){
 try{
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment',width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:60}},audio:true});
  $('#cameraVideo').srcObject=stream;
 }catch(e){$('#cameraStatus').textContent='Camera access was not available. Check Safari camera permission.'}
}
function stopCamera(){if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}show('home')}
$('#recordButton').onclick=()=>recording?stopRecording():startRecording();

function startRecording(){
 if(!stream){alert('Camera is not available.');return}
 chunks=[];
 let opts={};
 if(MediaRecorder.isTypeSupported('video/mp4'))opts.mimeType='video/mp4';
 else if(MediaRecorder.isTypeSupported('video/webm;codecs=vp9'))opts.mimeType='video/webm;codecs=vp9';
 try{recorder=new MediaRecorder(stream,opts)}catch(e){recorder=new MediaRecorder(stream)}
 recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
 recorder.onstop=()=>{
  const blob=new Blob(chunks,{type:recorder.mimeType||'video/mp4'});
  $('#swingVideo').src=URL.createObjectURL(blob);
  $('#emptyReview').style.display='none';
  $('#camera').classList.remove('recording');
  show('review');
 };
 recorder.start();recording=true;$('#camera').classList.add('recording');$('#cameraStatus').textContent='Recording… make your swing.';
}
function stopRecording(){recorder.stop();recording=false;$('#cameraStatus').textContent='Processing swing…'}

const video=$('#swingVideo');
video.onloadedmetadata=()=>{setTimeout(()=>{resizeCanvas();updateTime()},100);$('#seekBar').max=video.duration||100};
video.ontimeupdate=updateTime;
function updateTime(){if(!video.duration)return;$('#timeLabel').textContent=`${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;$('#seekBar').value=video.currentTime}
$('#seekBar').oninput=e=>{video.currentTime=Number(e.target.value);drawOverlay();runPoseAtCurrentFrame()};
$('#playPause').onclick=()=>{if(video.paused){video.play();$('#playPause').textContent='❚❚'}else{video.pause();$('#playPause').textContent='▶'}};
function stepFrame(delta){video.pause();video.currentTime=Math.max(0,Math.min(video.duration||0,video.currentTime+delta*frameStep()));drawOverlay();runPoseAtCurrentFrame()}
$('#prevFrame').onclick=()=>stepFrame(-1);$('#nextFrame').onclick=()=>stepFrame(1);

document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>{
 tool=b.dataset.tool;points=[];document.querySelectorAll('.toolButton').forEach(x=>x.classList.remove('active'));b.classList.add('active');
 $('#toolTitle').textContent=tool==='line'?'Line Tool':tool==='angle'?'Angle Tool':'Clear';
 $('#toolHelp').textContent=tool==='line'?'Tap two points on the video to draw a line.':tool==='angle'?'Tap three points: vertex first, then the two ends.':'Tap the video to clear the current overlay.';
 if(tool==='clear')clearOverlay()
});

const canvas=$('#overlay'),ctx=canvas.getContext('2d');
function resizeCanvas(){const r=canvas.getBoundingClientRect();canvas.width=Math.round(r.width*devicePixelRatio);canvas.height=Math.round(r.height*devicePixelRatio);ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);drawOverlay()}
window.addEventListener('resize',resizeCanvas);
canvas.addEventListener('pointerdown',e=>{
 if(tool==='clear'){clearOverlay();return}
 points.push(pos(e));
 if(tool==='line'&&points.length===2)drawOverlay();
 if(tool==='angle'&&points.length===3)drawOverlay();
});
function pos(e){const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
function drawOverlay(){
 const r=canvas.getBoundingClientRect();ctx.clearRect(0,0,r.width,r.height);ctx.lineWidth=4;ctx.strokeStyle='#ffffff';ctx.fillStyle='#ffffff';ctx.shadowColor='#000';ctx.shadowBlur=4;
 if(tool==='line'&&points.length>=2){drawLine(points[0],points[1]);$('#angleReadout').textContent='—'}
 if(tool==='angle'&&points.length>=3){
  drawLine(points[0],points[1]);drawLine(points[0],points[2]);
  const a=Math.atan2(points[1].y-points[0].y,points[1].x-points[0].x),b=Math.atan2(points[2].y-points[0].y,points[2].x-points[0].x);
  let deg=Math.abs((a-b)*180/Math.PI);if(deg>180)deg=360-deg;$('#angleReadout').textContent=`${deg.toFixed(1)}°`;
 }
}
function drawLine(a,b){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();[a,b].forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,7,0,Math.PI*2);ctx.fill()})}
function clearOverlay(){points=[];ctx.clearRect(0,0,canvas.width,canvas.height);$('#angleReadout').textContent='—'}

async function initPose(){
 if(poseReady)return true;
 $('#poseStatus').textContent='Loading body tracker…';
 try{
  const vision=await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm');
  poseLandmarker=await PoseLandmarker.createFromOptions(vision,{
   baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',delegate:'GPU'},
   runningMode:'VIDEO',numPoses:1,minPoseDetectionConfidence:.5,minPosePresenceConfidence:.5,minTrackingConfidence:.5
  });
  poseReady=true;$('#poseStatus').textContent='Auto tracking ready';return true;
 }catch(e){
  console.error(e);$('#poseStatus').textContent='Tracker could not load';return false;
 }
}
$('#poseToggle').onclick=async()=>{
 const ok=await initPose();if(!ok)return;
 poseLoop=!poseLoop;
 if(poseLoop){$('#poseToggle').textContent='Auto Tracking On';$('#poseStatus').textContent='Tracking golfer…';trackLoop()}
 else{$('#poseToggle').textContent='Enable Auto Tracking';$('#poseStatus').textContent='Tracking paused';drawOverlay()}
};

function trackLoop(){
 if(!poseLoop)return;
 if(!video.paused && video.readyState>=2)detectPose();
 requestAnimationFrame(trackLoop);
}
function detectPose(){
 if(!poseLandmarker||video.readyState<2)return;
 const t=Math.round(video.currentTime*1000);
 if(t===lastPoseTime)return;
 lastPoseTime=t;
 try{
  const result=poseLandmarker.detectForVideo(video,t);
  drawPose(result.landmarks?.[0]);
 }catch(e){console.warn('Pose detection:',e)}
}
function runPoseAtCurrentFrame(){
 if(!poseReady)return;
 try{const t=Math.max(0,Math.round(video.currentTime*1000));const result=poseLandmarker.detectForVideo(video,t);drawPose(result.landmarks?.[0])}catch(e){}
}
function drawPose(lm){
 if(!lm)return;
 const r=canvas.getBoundingClientRect();ctx.clearRect(0,0,r.width,r.height);
 const connections=[
  [11,12],[11,13],[13,15],[12,14],[14,16],
  [11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],
  [27,29],[29,31],[28,30],[30,32],
  [0,11],[0,12]
 ];
 ctx.lineWidth=3;ctx.strokeStyle='#62e6a4';ctx.fillStyle='#fff';ctx.shadowColor='#000';ctx.shadowBlur=3;
 for(const [a,b] of connections){if(conf(lm[a])&&conf(lm[b])){ctx.beginPath();ctx.moveTo(lm[a].x*r.width,lm[a].y*r.height);ctx.lineTo(lm[b].x*r.width,lm[b].y*r.height);ctx.stroke()}}
 for(const p of lm){if(conf(p)){ctx.beginPath();ctx.arc(p.x*r.width,p.y*r.height,4,0,Math.PI*2);ctx.fill()}}
}
function conf(p){return p && (p.visibility===undefined || p.visibility>.35)}

document.querySelectorAll('.positionButton').forEach(b=>b.onclick=()=>{
 document.querySelectorAll('.positionButton').forEach(x=>x.classList.remove('active'));b.classList.add('active');
 $('#markerStatus').textContent=`${b.dataset.position} marked at ${formatTime(video.currentTime)}`;
});

$('#saveSwing').onclick=()=>{
 const name=prompt('Name this swing:','Driver swing');if(!name)return;
 const arr=JSON.parse(localStorage.getItem('gsa_saved_v3')||'[]');
 arr.unshift({name,view:currentView,date:new Date().toLocaleString()});
 localStorage.setItem('gsa_saved_v3',JSON.stringify(arr));alert('Swing saved.')
};

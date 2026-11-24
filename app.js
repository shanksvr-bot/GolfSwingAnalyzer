const $=s=>document.querySelector(s);
const screens={home:$('#home'),camera:$('#camera'),review:$('#review'),saved:$('#saved')};
let currentView='',stream=null,recorder=null,chunks=[],recording=false;
let tool='line',points=[],savedSwings=JSON.parse(localStorage.getItem('gsa_saved_v1')||'[]');

function show(name){Object.values(screens).forEach(x=>x.classList.remove('active'));screens[name].classList.add('active')}
function formatTime(sec){if(!isFinite(sec))return '0:00';return `${Math.floor(sec/60)}:${String(Math.floor(sec%60)).padStart(2,'0')}`}

document.querySelectorAll('[data-view]').forEach(b=>b.onclick=async()=>{
 currentView=b.dataset.view; $('#cameraViewName').textContent=currentView;
 show('camera'); await startCamera();
});
$('#cameraBack').onclick=stopCamera;
$('#newSwing').onclick=()=>{show('home'); stopCamera();};
$('#savedBack').onclick=()=>show('home');

async function startCamera(){
 try{
   stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment',width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:60}},audio:true});
   $('#cameraVideo').srcObject=stream;
 }catch(e){
   $('#cameraStatus').textContent='Camera access was not available. Check Safari camera permission.';
 }
}
function stopCamera(){
 if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
 show('home');
}
$('#recordButton').onclick=()=>{
 if(recording) stopRecording(); else startRecording();
};
function startRecording(){
 if(!stream){alert('Camera is not available.');return;}
 chunks=[];
 let opts={};
 if(MediaRecorder.isTypeSupported('video/mp4')) opts.mimeType='video/mp4';
 else if(MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) opts.mimeType='video/webm;codecs=vp9';
 try{recorder=new MediaRecorder(stream,opts);}catch(e){recorder=new MediaRecorder(stream);}
 recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
 recorder.onstop=()=>{
   const blob=new Blob(chunks,{type:recorder.mimeType||'video/mp4'});
   $('#swingVideo').src=URL.createObjectURL(blob);
   $('#emptyReview').style.display='none';
   $('#camera').classList.remove('recording');
   show('review');
 };
 recorder.start(); recording=true; $('#camera').classList.add('recording');
 $('#cameraStatus').textContent='Recording… make your swing.';
}
function stopRecording(){
 recorder.stop(); recording=false;
 $('#cameraStatus').textContent='Processing swing…';
}

$('#swingVideo').onloadedmetadata=()=>{
 $('#seekBar').max=$('#swingVideo').duration||100;
 updateTime();
};
$('#swingVideo').ontimeupdate=updateTime;
function updateTime(){
 const v=$('#swingVideo'); $('#timeLabel').textContent=`${formatTime(v.currentTime)} / ${formatTime(v.duration)}`;
 if(v.duration)$('#seekBar').value=v.currentTime;
}
$('#seekBar').oninput=e=>{$('#swingVideo').currentTime=Number(e.target.value)};
$('#playPause').onclick=()=>{
 const v=$('#swingVideo');
 if(v.paused){v.play();$('#playPause').textContent='❚❚'}else{v.pause();$('#playPause').textContent='▶'}
};
document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>{
 tool=b.dataset.tool; points=[]; document.querySelectorAll('.toolButton').forEach(x=>x.classList.remove('active'));b.classList.add('active');
 $('#toolTitle').textContent=tool==='line'?'Line Tool':tool==='angle'?'Angle Tool':'Clear';
 $('#toolHelp').textContent=tool==='line'?'Tap two points on the video to draw a line.':tool==='angle'?'Tap three points: vertex, then the two ends of the angle.':'Tap the video to clear the current overlay.';
 if(tool==='clear') clearOverlay();
});

const canvas=$('#overlay'),ctx=canvas.getContext('2d');
function resizeCanvas(){const r=canvas.getBoundingClientRect();canvas.width=Math.round(r.width*devicePixelRatio);canvas.height=Math.round(r.height*devicePixelRatio);ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);drawOverlay();}
window.addEventListener('resize',resizeCanvas);
$('#swingVideo').addEventListener('loadeddata',()=>setTimeout(resizeCanvas,100));
function pos(e){const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
canvas.addEventListener('pointerdown',e=>{
 if(tool==='clear'){clearOverlay();return}
 points.push(pos(e));
 if(tool==='line'&&points.length===2)drawOverlay();
 if(tool==='angle'&&points.length===3)drawOverlay();
});
function drawOverlay(){
 const r=canvas.getBoundingClientRect();ctx.clearRect(0,0,r.width,r.height);ctx.lineWidth=4;ctx.strokeStyle='#ffffff';ctx.fillStyle='#ffffff';ctx.shadowColor='#000';ctx.shadowBlur=4;
 if(tool==='line'&&points.length>=2){
   line(points[0],points[1]);$('#angleReadout').textContent='—';
 }
 if(tool==='angle'&&points.length>=3){
   line(points[1],points[0]);line(points[0],points[2]);
   const a=Math.atan2(points[1].y-points[0].y,points[1].x-points[0].x);
   const b=Math.atan2(points[2].y-points[0].y,points[2].x-points[0].x);
   let deg=Math.abs((a-b)*180/Math.PI);if(deg>180)deg=360-deg;
   $('#angleReadout').textContent=`${deg.toFixed(1)}°`;
 }
}
function line(a,b){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();[a,b].forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,7,0,Math.PI*2);ctx.fill()});}
function clearOverlay(){points=[];ctx.clearRect(0,0,canvas.width,canvas.height);$('#angleReadout').textContent='—';}

$('#saveSwing').onclick=()=>{
 const name=prompt('Name this swing:','Driver swing');
 if(!name)return;
 savedSwings.unshift({name,view:currentView,date:new Date().toLocaleString()});
 localStorage.setItem('gsa_saved_v1',JSON.stringify(savedSwings));
 alert('Swing saved.'); loadSaved();
};
function loadSaved(){
 $('#savedList').innerHTML=savedSwings.length?savedSwings.map(s=>`<div class="savedItem"><b>${escapeHtml(s.name)}</b><small>${escapeHtml(s.view)} • ${escapeHtml(s.date)}</small></div>`).join(''):'<div class="infoCard"><b>No saved swings yet.</b><p>Saved swings will appear here.</p></div>';
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
loadSaved();

const autoTrackingBtn = document.getElementById('autoTrackingBtn');

if (autoTrackingBtn) {

  autoTrackingBtn.addEventListener('click', async () => {

    autoTrackingBtn.disabled = true;
    autoTrackingBtn.textContent = 'Loading Tracking...';

    try {

      const tracking = await import('./pose.js?v=3');

      const video = document.getElementById('swingVideo');

      if (!video) {
        throw new Error('Swing video not found.');
      }

     let canvas = document.getElementById('poseOverlay');

const videoWrap = document.getElementById('videoWrap');

if (!videoWrap) {
  throw new Error('Video container not found.');
}

if (!canvas) {
  canvas = document.createElement('canvas');
  canvas.id = 'poseOverlay';

  canvas.style.position = 'absolute';
  canvas.style.left = '0';
  canvas.style.top = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '5';

  videoWrap.style.position = 'relative';
  videoWrap.appendChild(canvas);
}

      await tracking.enableAutoTracking(
        video,
        canvas
      );

      autoTrackingBtn.textContent =
        'Auto Tracking On';

    } catch (error) {

      console.error(
        'Automatic tracking failed:',
        error
      );

     alert(
  'Tracking Error: ' + error.message
);

      autoTrackingBtn.disabled = false;

      autoTrackingBtn.textContent =
        'Enable Auto Tracking';
    }
  });
}

let poseLandmarker = null;

export async function enableAutoTracking(video, canvas) {

  const { FilesetResolver, PoseLandmarker } = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs"
  );

  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm"
  );

  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",

      delegate: "GPU"
    },

    runningMode: "VIDEO",

    numPoses: 1,

    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  const ctx = canvas.getContext("2d");

  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;

  function drawLoop() {

    if (
      !poseLandmarker ||
      video.paused ||
      video.ended
    ) {
      return;
    }

    const result =
      poseLandmarker.detectForVideo(
        video,
        performance.now()
      );

    ctx.clearRect(
      0,
      0,
      canvas.width,
      canvas.height
    );

    const landmarks =
      result.landmarks &&
      result.landmarks[0];

    if (landmarks) {

      const connections = [

        // Shoulders / arms
        [11,12],
        [11,13],
        [13,15],
        [12,14],
        [14,16],

        // Torso
        [11,23],
        [12,24],
        [23,24],

        // Legs
        [23,25],
        [25,27],
        [24,26],
        [26,28],

        // Feet
        [27,29],
        [29,31],
        [28,30],
        [30,32]
      ];

      ctx.lineWidth = 4;

      ctx.beginPath();

      for (const [a,b] of connections) {

        if (!landmarks[a] || !landmarks[b]) {
          continue;
        }

        ctx.moveTo(
          landmarks[a].x * canvas.width,
          landmarks[a].y * canvas.height
        );

        ctx.lineTo(
          landmarks[b].x * canvas.width,
          landmarks[b].y * canvas.height
        );
      }

      ctx.stroke();

      // Draw joints

      for (const point of landmarks) {

        ctx.beginPath();

        ctx.arc(
          point.x * canvas.width,
          point.y * canvas.height,
          5,
          0,
          Math.PI * 2
        );

        ctx.fill();
      }
    }

    requestAnimationFrame(drawLoop);
  }
  drawLoop();
}

const autoTrackingBtn = document.getElementById('autoTrackingBtn');

if (autoTrackingBtn) {

  autoTrackingBtn.addEventListener('click', async () => {

    autoTrackingBtn.disabled = true;
    autoTrackingBtn.textContent = 'Loading Tracking...';

    try {

      const tracking = await import('./pose.js');

      const video = document.getElementById('swingVideo');

      if (!video) {
        throw new Error('Swing video not found.');
      }

      let canvas = document.getElementById('poseOverlay');

      if (!canvas) {

        canvas = document.createElement('canvas');

        canvas.id = 'poseOverlay';

        canvas.style.position = 'absolute';
        canvas.style.left = '0';
        canvas.style.top = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.pointerEvents = 'none';

        const videoWrap =
          document.getElementById('videoWrap');

        if (videoWrap) {

          videoWrap.style.position = 'relative';

          videoWrap.appendChild(canvas);
        }
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
        'Automatic tracking could not be loaded.'
      );

      autoTrackingBtn.disabled = false;

      autoTrackingBtn.textContent =
        'Enable Auto Tracking';
    }
  });
}

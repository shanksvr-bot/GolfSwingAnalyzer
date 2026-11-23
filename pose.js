let poseLandmarker = null;
let animationFrame = null;

export async function enableAutoTracking(video, canvas) {

  const { FilesetResolver, PoseLandmarker } = await import(
   "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/vision_bundle.mjs"
  );

  const vision = await FilesetResolver.forVisionTasks(
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm"
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

    if (!poseLandmarker || video.ended) return;

    if (!video.paused) {

     const result = poseLandmarker.detectForVideo(
  video,
  video.currentTime * 1000
);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const landmarks = result.landmarks?.[0];

      if (landmarks) {

        const connections = [
          [11,12],[11,13],[13,15],[12,14],[14,16],
          [11,23],[12,24],[23,24],
          [23,25],[25,27],[24,26],[26,28],
          [27,29],[29,31],[28,30],[30,32]
        ];

        ctx.strokeStyle = "#00ff00";
        ctx.fillStyle = "#ff0000";
        ctx.lineWidth = 4;

        ctx.beginPath();

        for (const [a,b] of connections) {
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

        for (const point of landmarks) {
          ctx.beginPath();
          ctx.arc(
            point.x * canvas.width,
            point.y * canvas.height,
            5, 0, Math.PI * 2
          );
          ctx.fill();
        }
      }
    }

    animationFrame = requestAnimationFrame(drawLoop);
  }

  await video.play();
  drawLoop();
}

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

  // SWING POSITION DETECTION
  let addressDetected = false;
  let topDetected = false;

  let stillStart = null;
  let stillReference = null;

  let addressTime = null;
  let topTime = null;

  let addressHandY = null;
  let highestHandY = Infinity;
  let highestHandTime = null;
  let handsMovingUp = false;

  let lastVideoTime = -1;

  function resetDetection() {
    addressDetected = false;
    topDetected = false;

    stillStart = null;
    stillReference = null;

    addressTime = null;
    topTime = null;

    addressHandY = null;
    highestHandY = Infinity;
    highestHandTime = null;
    handsMovingUp = false;
  }

  function getTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);

    return `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  function drawLabel(text, y) {
    ctx.font = `${Math.round(canvas.width * 0.025)}px Arial`;

    const padding = 12;
    const width = ctx.measureText(text).width;

    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(15, y, width + padding * 2, 38);

    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, 15 + padding, y + 26);
  }

  function detectSwingPositions(landmarks) {

    const required = [11, 12, 15, 16, 23, 24];

    for (const i of required) {
      if (!landmarks[i] || (landmarks[i].visibility ?? 1) < 0.35) {
        return;
      }
    }

    const handY = (landmarks[15].y + landmarks[16].y) / 2;

    const keyPoints = required.map(i => ({
      x: landmarks[i].x,
      y: landmarks[i].y
    }));

    const now = video.currentTime;

    // DETECT ADDRESS
    if (!addressDetected) {

      if (!stillReference) {
        stillReference = keyPoints;
        stillStart = now;
      }

      let movement = 0;

      for (let i = 0; i < keyPoints.length; i++) {
        movement = Math.max(
          movement,
          Math.abs(keyPoints[i].x - stillReference[i].x),
          Math.abs(keyPoints[i].y - stillReference[i].y)
        );
      }

      if (movement > 0.008) {
        stillReference = keyPoints;
        stillStart = now;
      }

      if (now - stillStart >= 0.5) {
        addressDetected = true;
        addressTime = now;
        addressHandY = handY;
      }

      return;
    }

    // DETECT TOP OF BACKSWING
    if (!topDetected) {

      if (handY < addressHandY - 0.06) {
        handsMovingUp = true;
      }

      if (handsMovingUp && handY < highestHandY) {
        highestHandY = handY;
        highestHandTime = now;
      }

      if (
        handsMovingUp &&
        highestHandTime !== null &&
        now - highestHandTime > 0.10 &&
        handY > highestHandY + 0.025
      ) {
        topDetected = true;
        topTime = highestHandTime;
      }
    }
  }

  function drawLoop() {

    if (!poseLandmarker) return;

    if (!video.paused) {

      // Reset detections when replaying from the beginning
      if (lastVideoTime >= 0 && video.currentTime < lastVideoTime - 0.25) {
        resetDetection();
      }

      lastVideoTime = video.currentTime;

      const result = poseLandmarker.detectForVideo(
        video,
        performance.now()
      );

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const landmarks = result.landmarks?.[0];

      if (landmarks) {

        detectSwingPositions(landmarks);

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

      // DISPLAY DETECTED POSITIONS
      if (addressDetected) {
        drawLabel(
          "ADDRESS  " + getTime(addressTime),
          15
        );
      }

      if (topDetected) {
        drawLabel(
          "TOP OF BACKSWING  " + getTime(topTime),
          60
        );
      }
    }

    animationFrame = requestAnimationFrame(drawLoop);
  }

  await video.play();
  drawLoop();
}

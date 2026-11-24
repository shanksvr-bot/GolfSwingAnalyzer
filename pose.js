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

  // -----------------------------------------
  // SWING POSITION DETECTION
  // -----------------------------------------

  let addressDetected = false;
  let topDetected = false;

  let addressTime = null;
  let topTime = null;

  let lastVideoTime = -1;

  // Store hand movement throughout the swing
  let handHistory = [];

  // Used to prevent false Top detection
  let lastHandY = null;
  let upwardMovementStarted = false;

  function resetDetection() {
    addressDetected = false;
    topDetected = false;

    addressTime = null;
    topTime = null;

    handHistory = [];

    lastHandY = null;
    upwardMovementStarted = false;
  }

  function getTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);

    return `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  function angleBetween(a, b, c) {

    const ab = {
      x: a.x - b.x,
      y: a.y - b.y
    };

    const cb = {
      x: c.x - b.x,
      y: c.y - b.y
    };

    const dot =
      ab.x * cb.x +
      ab.y * cb.y;

    const magAB =
      Math.hypot(ab.x, ab.y);

    const magCB =
      Math.hypot(cb.x, cb.y);

    if (!magAB || !magCB) {
      return 0;
    }

    let value =
      dot / (magAB * magCB);

    value = Math.max(-1, Math.min(1, value));

    return Math.acos(value) * 180 / Math.PI;
  }

  function calculateAddressMeasurements(landmarks) {

    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];

    const leftHip = landmarks[23];
    const rightHip = landmarks[24];

    const leftKnee = landmarks[25];
    const rightKnee = landmarks[26];

    const leftAnkle = landmarks[27];
    const rightAnkle = landmarks[28];

    const shoulderMid = {
      x: (leftShoulder.x + rightShoulder.x) / 2,
      y: (leftShoulder.y + rightShoulder.y) / 2
    };

    const hipMid = {
      x: (leftHip.x + rightHip.x) / 2,
      y: (leftHip.y + rightHip.y) / 2
    };

    // Spine angle relative to vertical
    const dx =
      shoulderMid.x - hipMid.x;

    const dy =
      shoulderMid.y - hipMid.y;

    const spineAngle =
      Math.abs(
        Math.atan2(dx, -dy) * 180 / Math.PI
      );

    const leftHipAngle =
      angleBetween(
        leftShoulder,
        leftHip,
        leftKnee
      );

    const rightHipAngle =
      angleBetween(
        rightShoulder,
        rightHip,
        rightKnee
      );

    const leftKneeAngle =
      angleBetween(
        leftHip,
        leftKnee,
        leftAnkle
      );

    const rightKneeAngle =
      angleBetween(
        rightHip,
        rightKnee,
        rightAnkle
      );

    return {
      spineAngle,
      leftHipAngle,
      rightHipAngle,
      leftKneeAngle,
      rightKneeAngle
    };
  }

  function drawMeasurementPanel(m) {

    const x = 15;
    const y = 110;
    const width = 340;
    const height = 180;

    ctx.fillStyle = "rgba(0,0,0,0.78)";
    ctx.fillRect(x, y, width, height);

    ctx.fillStyle = "#ffffff";
    ctx.font = `${Math.round(canvas.width * 0.022)}px Arial`;

    ctx.fillText(
      "ADDRESS MEASUREMENTS",
      x + 15,
      y + 28
    );

    ctx.font = `${Math.round(canvas.width * 0.018)}px Arial`;

    ctx.fillText(
      `Spine: ${m.spineAngle.toFixed(1)}°`,
      x + 15,
      y + 60
    );

    ctx.fillText(
      `Lead Hip: ${m.leftHipAngle.toFixed(1)}°`,
      x + 15,
      y + 88
    );

    ctx.fillText(
      `Trail Hip: ${m.rightHipAngle.toFixed(1)}°`,
      x + 15,
      y + 116
    );

    ctx.fillText(
      `Lead Knee: ${m.leftKneeAngle.toFixed(1)}°`,
      x + 15,
      y + 144
    );

    ctx.fillText(
      `Trail Knee: ${m.rightKneeAngle.toFixed(1)}°`,
      x + 15,
      y + 172
    );
  }
  
  function drawLabel(text, y) {

    ctx.font = `${Math.round(canvas.width * 0.025)}px Arial`;

    const padding = 12;
    const width = ctx.measureText(text).width;

    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(
      15,
      y,
      width + padding * 2,
      38
    );

    ctx.fillStyle = "#ffffff";

    ctx.fillText(
      text,
      15 + padding,
      y + 26
    );
  }

  function detectSwingPositions(landmarks) {

    const required = [
      11, 12,       // shoulders
      15, 16,       // wrists
      23, 24        // hips
    ];

    for (const i of required) {

      if (
        !landmarks[i] ||
        (landmarks[i].visibility ?? 1) < 0.35
      ) {
        return;
      }
    }

    const leftHand = landmarks[15];
    const rightHand = landmarks[16];

    const handX =
      (leftHand.x + rightHand.x) / 2;

    const handY =
      (leftHand.y + rightHand.y) / 2;

    const shoulderY =
      (landmarks[11].y + landmarks[12].y) / 2;

    const hipY =
      (landmarks[23].y + landmarks[24].y) / 2;

    const now = video.currentTime;

    // Save hand position for later analysis
    handHistory.push({
      time: now,
      x: handX,
      y: handY,
      shoulderY,
      hipY
    });

    // Keep history from growing indefinitely
    if (handHistory.length > 600) {
      handHistory.shift();
    }

    // -----------------------------------------
    // ADDRESS
    // -----------------------------------------

    if (!addressDetected) {

      /*
       * Address is approximately:
       * - hands below shoulders
       * - hands above hips
       * - body relatively stable
       *
       * We look for a stable period rather than
       * automatically declaring the first 0.5 sec
       * to be Address.
       */

      const recent = handHistory.filter(
        p => now - p.time < 0.5
      );

      if (recent.length >= 5) {

        let maxMovement = 0;

        const first = recent[0];

        for (const p of recent) {

          const movement = Math.max(
            Math.abs(p.x - first.x),
            Math.abs(p.y - first.y)
          );

          maxMovement =
            Math.max(maxMovement, movement);
        }

        const handsBelowShoulders =
          handY > shoulderY;

        const handsAboveHips =
          handY < hipY;

        const stable =
          maxMovement < 0.012;

        if (
          stable &&
          handsBelowShoulders &&
          handsAboveHips
        ) {

          addressDetected = true;
          addressTime = now;

          // Start tracking the backswing
          lastHandY = handY;
        }
      }
    }

    // -----------------------------------------
    // TOP OF BACKSWING
    // -----------------------------------------

    if (
      addressDetected &&
      !topDetected
    ) {

      if (lastHandY !== null) {

        // In image coordinates, smaller Y =
        // hands moving upward.
        const movingUp =
          handY < lastHandY - 0.003;

        const movingDown =
          handY > lastHandY + 0.003;

        if (movingUp) {

          upwardMovementStarted = true;

          handHistory[handHistory.length - 1]
            .movingUp = true;
        }

        /*
         * Once the hands have clearly moved upward,
         * a reversal downward indicates that the
         * highest hand position was the Top.
         */

        if (
          upwardMovementStarted &&
          movingDown
        ) {

          // Look backward for the highest hand position
          let highest = null;

          for (let i = handHistory.length - 1; i >= 0; i--) {

            const p = handHistory[i];

            if (now - p.time > 0.5) {
              break;
            }

            if (
              !highest ||
              p.y < highest.y
            ) {
              highest = p;
            }
          }

          if (highest) {

            topDetected = true;
            topTime = highest.time;
          }
        }
      }

      lastHandY = handY;
    }
  }

  // -----------------------------------------
  // DRAW LOOP
  // -----------------------------------------

  function drawLoop() {

    if (!poseLandmarker) return;

    if (!video.paused) {

      // Reset when replaying from beginning
      if (
        lastVideoTime >= 0 &&
        video.currentTime <
          lastVideoTime - 0.25
      ) {
        resetDetection();
      }

      lastVideoTime =
        video.currentTime;

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
        result.landmarks?.[0];

      if (landmarks) {

        detectSwingPositions(
          landmarks
        );

        const connections = [
          [11,12],
          [11,13],
          [13,15],
          [12,14],
          [14,16],
          [11,23],
          [12,24],
          [23,24],
          [23,25],
          [25,27],
          [24,26],
          [26,28],
          [27,29],
          [29,31],
          [28,30],
          [30,32]
        ];

        // Skeleton
        ctx.strokeStyle = "#00ff00";
        ctx.fillStyle = "#ff0000";
        ctx.lineWidth = 4;

        ctx.beginPath();

        for (const [a, b] of connections) {

          ctx.moveTo(
            landmarks[a].x *
              canvas.width,

            landmarks[a].y *
              canvas.height
          );

          ctx.lineTo(
            landmarks[b].x *
              canvas.width,

            landmarks[b].y *
              canvas.height
          );
        }

        ctx.stroke();

        for (const point of landmarks) {

          ctx.beginPath();

          ctx.arc(
            point.x *
              canvas.width,

            point.y *
              canvas.height,

            5,
            0,
            Math.PI * 2
          );

          ctx.fill();
        }
      }

      // Position labels
      if (addressDetected) {
            
        drawLabel(
          "ADDRESS  " +
          getTime(addressTime),
          15
        );

        const measurements =
          calculateAddressMeasurements(landmarks);

        drawMeasurementPanel(measurements);
      }

      if (topDetected) {

        drawLabel(
          "TOP OF BACKSWING  " +
          getTime(topTime),
          60
        );
      }
    }

    animationFrame =
      requestAnimationFrame(
        drawLoop
      );
  }


  drawLoop();
}

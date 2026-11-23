# Golf Swing Analyzer - Prototype 3

Prototype 3 adds automatic body tracking using MediaPipe Pose Landmarker.

Current:
- Down-the-Line / Face-On recording
- Swing playback
- Frame stepping
- Manual line and angle tools
- Address / Top / Impact / Finish markers
- Automatic 33-landmark body pose tracking
- Skeleton overlay follows the golfer during playback
- Pose inference is performed in the browser/device; the app does not upload the video to a server

Important:
- This is an experimental prototype, not a finished golf coaching system.
- Pose accuracy can be affected by lighting, clothing, occlusion, camera angle, and fast club motion.
- The next phase is to use the detected joints to calculate golf-specific measurements such as spine angle, shoulder turn, hip turn, knee flex, and shaft/body relationships.


## Prototype 3.1 fix
The pose-tracking library is now loaded only when Auto Tracking is enabled. This keeps the camera and recording screens independent of the pose library. The camera also explicitly starts playback after permission is granted.

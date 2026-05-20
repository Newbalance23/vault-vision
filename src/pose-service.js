import { analyzeVault, annotateFrameScores } from "./analysis.js?v=2026-05-20-tracking";

const TASKS_VERSION = "latest";
const WASM_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/wasm`;
const MODEL_ROOT = "https://storage.googleapis.com/mediapipe-models/pose_landmarker";

const MODEL_PATHS = Object.freeze({
  lite: `${MODEL_ROOT}/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`,
  full: `${MODEL_ROOT}/pose_landmarker_full/float16/latest/pose_landmarker_full.task`,
  heavy: `${MODEL_ROOT}/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task`,
});

let mediaPipeModule;
const landmarkerCache = new Map();

export async function createPoseLandmarker({ modelVariant = "full", numPoses = 6 } = {}) {
  const cacheKey = `${modelVariant}:${numPoses}`;
  if (landmarkerCache.has(cacheKey)) return landmarkerCache.get(cacheKey);

  if (!mediaPipeModule) {
    mediaPipeModule = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`);
  }

  const { FilesetResolver, PoseLandmarker } = mediaPipeModule;
  const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
  const landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_PATHS[modelVariant] ?? MODEL_PATHS.full,
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numPoses,
    minPoseDetectionConfidence: 0.35,
    minPosePresenceConfidence: 0.35,
    minTrackingConfidence: 0.35,
  });

  landmarkerCache.set(cacheKey, landmarker);
  return landmarker;
}

export async function analyzeVideoWithPose(video, options = {}) {
  const {
    fileName = "vault-video",
    sampleRate = 12,
    modelVariant = "full",
    numPoses = 6,
    cameraAngle = "auto",
    calibration = {},
    onProgress = () => {},
  } = options;

  await ensureVideoReady(video);
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (!duration) throw new Error("The selected video has no readable duration.");

  onProgress({ phase: "model", progress: 0.05, message: "Loading pose model..." });
  const landmarker = await createPoseLandmarker({ modelVariant, numPoses });
  const frameStep = 1 / Number(sampleRate || 12);
  const totalFrames = Math.max(1, Math.floor(duration / frameStep) + 1);
  const frames = [];

  for (let index = 0; index < totalFrames; index += 1) {
    const time = Math.min(duration, index * frameStep);
    await seekVideo(video, time);
    const result = landmarker.detectForVideo(video, Math.round(time * 1000));
    frames.push({
      time,
      poses: (result.landmarks ?? []).map((landmarks, poseIndex) => ({
        landmarks: landmarks.map(copyLandmark),
        worldLandmarks: (result.worldLandmarks?.[poseIndex] ?? []).map(copyLandmark),
      })),
    });

    if (index % 2 === 0 || index === totalFrames - 1) {
      onProgress({
        phase: "frames",
        progress: 0.08 + (index / totalFrames) * 0.82,
        message: `Reading pose frames ${index + 1} / ${totalFrames}`,
      });
    }
  }

  onProgress({ phase: "rules", progress: 0.94, message: "Scoring vault mechanics..." });
  const analysis = analyzeVault({
    frames,
    cameraAngle,
    calibration,
    videoMeta: {
      fileName,
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
      sampleRate,
    },
  });

  onProgress({ phase: "done", progress: 1, message: "Analysis complete." });
  return analysis;
}

export async function detectVideoFrame(video, options = {}) {
  const {
    modelVariant = "lite",
    numPoses = 6,
    cameraAngle = "auto",
    duration = video.duration || 0,
  } = options;
  await ensureVideoReady(video);
  const landmarker = await createPoseLandmarker({ modelVariant, numPoses });
  const result = landmarker.detectForVideo(video, Math.round(video.currentTime * 1000));
  const frame = {
    time: video.currentTime,
    activePoseIndex: 0,
    poses: (result.landmarks ?? []).map((landmarks, poseIndex) => ({
      landmarks: landmarks.map(copyLandmark),
      worldLandmarks: (result.worldLandmarks?.[poseIndex] ?? []).map(copyLandmark),
    })),
  };
  frame.activePoseIndex = selectLargestPose(frame.poses);
  const phaseRanges = roughPhaseRanges(duration);
  const [form] = annotateFrameScores([frame], phaseRanges, cameraAngle);
  return {
    schemaVersion: "vault-vision.live-preview.v1",
    videoMeta: {
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
    },
    cameraAngle,
    phaseRanges,
    poseFrames: [{ ...frame, form }],
  };
}

function copyLandmark(point) {
  return {
    x: point.x,
    y: point.y,
    z: point.z ?? 0,
    visibility: point.visibility ?? point.presence ?? 1,
  };
}

function selectLargestPose(poses = []) {
  if (!poses.length) return -1;
  let bestIndex = 0;
  let bestArea = -Infinity;
  poses.forEach((pose, index) => {
    const visible = pose.landmarks.filter((point) => (point.visibility ?? 1) > 0.25);
    if (!visible.length) return;
    const xs = visible.map((point) => point.x);
    const ys = visible.map((point) => point.y);
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    if (area > bestArea) {
      bestArea = area;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function roughPhaseRanges(duration = 0) {
  const total = Math.max(0.01, duration || 1);
  return [
    roughPhase("approach", "Approach", "phase-approach", 0, 0.36, total),
    roughPhase("plant-takeoff", "Plant / takeoff", "phase-plant-takeoff", 0.36, 0.46, total),
    roughPhase("swing-rockback", "Swing / rockback", "phase-swing-rockback", 0.46, 0.64, total),
    roughPhase("extension-turn", "Extension / turn", "phase-extension-turn", 0.64, 0.82, total),
    roughPhase("clearance-landing", "Clearance / landing", "phase-clearance-landing", 0.82, 1, total),
  ];
}

function roughPhase(key, label, className, start, end, duration) {
  return {
    key,
    label,
    className,
    startTime: start * duration,
    endTime: end * duration,
    confidence: 0.28,
  };
}

function ensureVideoReady(video) {
  if (video.readyState >= 1 && Number.isFinite(video.duration)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", handleReady);
      video.removeEventListener("error", handleError);
    };
    const handleReady = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("The selected video could not be loaded."));
    };
    video.addEventListener("loadedmetadata", handleReady, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

function seekVideo(video, time) {
  if (Math.abs(video.currentTime - time) < 0.005 && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
    };
    const handleSeeked = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Unable to seek through the selected video."));
    };
    video.addEventListener("seeked", handleSeeked, { once: true });
    video.addEventListener("error", handleError, { once: true });
    video.currentTime = Math.min(Math.max(time, 0), video.duration || time);
  });
}

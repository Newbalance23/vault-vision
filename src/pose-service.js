import { analyzeVault, annotateFrameScores, assignActivePoseTrack } from "./analysis.js?v=2026-05-21-ai-tracking";
import { REQUIRED_GROUPS } from "./landmarks.js?v=2026-05-21-ai-tracking";
import { averageConfidence, boundingBox, clamp } from "./math.js?v=2026-05-21-ai-tracking";

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
const liveTracking = {
  key: "",
  frames: [],
};
let detectionCanvas;
let detectionContext;
let lastDetectionTimestamp = 0;

const ANALYSIS_TILES = Object.freeze([
  { id: "full", x: 0, y: 0, w: 1, h: 1, scale: 1 },
  { id: "runway-wide", x: 0.02, y: 0.24, w: 0.96, h: 0.54, scale: 0.78 },
  { id: "left-runway", x: 0, y: 0.22, w: 0.5, h: 0.6, scale: 0.92 },
  { id: "mid-runway", x: 0.25, y: 0.18, w: 0.5, h: 0.62, scale: 0.95 },
  { id: "right-runway", x: 0.5, y: 0.14, w: 0.5, h: 0.72, scale: 0.95 },
  { id: "upper-right", x: 0.35, y: 0, w: 0.65, h: 0.62, scale: 0.82 },
]);
const LIVE_TILES = Object.freeze([
  ANALYSIS_TILES[0],
  ANALYSIS_TILES[1],
  ANALYSIS_TILES[2],
  ANALYSIS_TILES[3],
  ANALYSIS_TILES[4],
]);
const TILE_MIN_AREA = 0.00055;
const TILE_DUPLICATE_IOU = 0.32;
const TILE_DUPLICATE_CENTER_DISTANCE = 0.055;

export async function createPoseLandmarker({ modelVariant = "full", numPoses = 8 } = {}) {
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
    numPoses = 8,
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
  const canSeek = await canSeekAccurately(video, duration);
  const frames = canSeek
    ? await sampleVideoBySeeking({ video, landmarker, frameStep, totalFrames, duration, onProgress })
    : await sampleVideoByPlayback({ video, landmarker, frameStep, totalFrames, duration, onProgress });

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
    numPoses = 8,
    cameraAngle = "auto",
    duration = video.duration || 0,
  } = options;
  await ensureVideoReady(video);
  const landmarker = await createPoseLandmarker({ modelVariant, numPoses });
  const poses = detectFramePoses({
    landmarker,
    video,
    timestampBase: allocateTimestampBlock(video.currentTime * 1000, LIVE_TILES.length),
    tiles: LIVE_TILES,
  });
  const frame = {
    time: video.currentTime,
    activePoseIndex: -1,
    poses,
  };
  const trackedFrame = updateLiveTracking(video, frame);
  const phaseRanges = roughPhaseRanges(duration);
  const [form] = annotateFrameScores([trackedFrame], phaseRanges, cameraAngle);
  return {
    schemaVersion: "vault-vision.live-preview.v1",
    videoMeta: {
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
    },
    cameraAngle,
    phaseRanges,
    poseFrames: [{ ...trackedFrame, form }],
  };
}

async function sampleVideoBySeeking({ video, landmarker, frameStep, totalFrames, duration, onProgress }) {
  const frames = [];
  for (let index = 0; index < totalFrames; index += 1) {
    const time = Math.min(duration, index * frameStep);
    await seekVideo(video, time, { tolerance: Math.max(0.12, frameStep * 1.5) });
    frames.push({
      time,
      poses: detectFramePoses({
        landmarker,
        video,
        timestampBase: allocateTimestampBlock(time * 1000, ANALYSIS_TILES.length),
        tiles: ANALYSIS_TILES,
      }),
    });
    reportFrameProgress(onProgress, index, totalFrames, "Reading pose frames");
  }
  return frames;
}

async function sampleVideoByPlayback({ video, landmarker, frameStep, totalFrames, duration, onProgress }) {
  const frames = [];
  const previousMuted = video.muted;
  const previousPlaybackRate = video.playbackRate;
  video.muted = true;
  video.playbackRate = 1;

  try {
    await seekVideo(video, 0, { tolerance: 0.6, allowInaccurate: true });
    await video.play();
    let nextIndex = 0;
    let staleTicks = 0;
    let lastPlaybackTime = video.currentTime;
    while (nextIndex < totalFrames && video.currentTime < duration + frameStep) {
      if (video.ended) break;
      await waitForVideoTick(video);
      if (video.currentTime <= lastPlaybackTime + 0.001) {
        staleTicks += 1;
      } else {
        staleTicks = 0;
        lastPlaybackTime = video.currentTime;
      }
      if (staleTicks > 10) break;
      if (video.currentTime + frameStep * 0.25 < nextIndex * frameStep) continue;
      video.pause();
      const actualTime = Math.min(duration, video.currentTime);
      frames.push({
        time: actualTime,
        poses: detectFramePoses({
          landmarker,
          video,
          timestampBase: allocateTimestampBlock(actualTime * 1000, ANALYSIS_TILES.length),
          tiles: ANALYSIS_TILES,
        }),
      });
      reportFrameProgress(onProgress, nextIndex, totalFrames, "Playing video for pose frames");
      nextIndex = Math.max(nextIndex + 1, Math.floor(actualTime / frameStep) + 1);
      if (actualTime < duration - 0.02) await video.play();
    }
  } finally {
    video.pause();
    video.muted = previousMuted;
    video.playbackRate = previousPlaybackRate;
  }

  return frames.length ? frames : sampleVideoBySeeking({ video, landmarker, frameStep, totalFrames, duration, onProgress });
}

function detectFramePoses({ landmarker, video, timestampBase, tiles = ANALYSIS_TILES }) {
  const detections = [];
  tiles.forEach((tile, tileIndex) => {
    const result = detectTile({ landmarker, video, tile, timestamp: timestampBase + tileIndex });
    if (!result) return;
    (result.landmarks ?? []).forEach((landmarks, poseIndex) => {
      const mappedLandmarks = mapTileLandmarks(landmarks, tile);
      const box = boundingBox(mappedLandmarks);
      const confidence = averageConfidence(mappedLandmarks, REQUIRED_GROUPS.core);
      if (!box || box.area < TILE_MIN_AREA || confidence < 0.18) return;
      detections.push({
        box,
        confidence,
        score: detectionScore({ box, confidence, tile }),
        pose: {
          landmarks: mappedLandmarks.map(copyLandmark),
          worldLandmarks: tile.id === "full" ? (result.worldLandmarks?.[poseIndex] ?? []).map(copyLandmark) : [],
          sourceTile: tile.id,
        },
      });
    });
  });
  return dedupePoses(detections).map((detection) => detection.pose);
}

function detectTile({ landmarker, video, tile, timestamp }) {
  if (tile.id === "full") return landmarker.detectForVideo(video, timestamp);
  const context = getDetectionContext();
  if (!context) return null;

  const targetWidth = Math.max(360, Math.round(820 * (tile.scale ?? 1) * tile.w));
  const targetHeight = Math.max(300, Math.round(targetWidth * (tile.h / tile.w)));
  detectionCanvas.width = targetWidth;
  detectionCanvas.height = targetHeight;

  try {
    context.drawImage(
      video,
      tile.x * video.videoWidth,
      tile.y * video.videoHeight,
      tile.w * video.videoWidth,
      tile.h * video.videoHeight,
      0,
      0,
      targetWidth,
      targetHeight,
    );
    return landmarker.detectForVideo(detectionCanvas, timestamp);
  } catch {
    return null;
  }
}

function getDetectionContext() {
  if (!detectionCanvas) {
    detectionCanvas = document.createElement("canvas");
    detectionContext = detectionCanvas.getContext("2d", { willReadFrequently: true });
  }
  return detectionContext;
}

function mapTileLandmarks(landmarks, tile) {
  if (tile.id === "full") return landmarks.map(copyLandmark);
  return landmarks.map((point) => ({
    x: tile.x + point.x * tile.w,
    y: tile.y + point.y * tile.h,
    z: point.z ?? 0,
    visibility: point.visibility ?? point.presence ?? 1,
  }));
}

function detectionScore({ box, confidence, tile }) {
  const sizeScore = clamp(box.area * 18, 0, 0.55);
  const runwayBias = tile.id.includes("runway") ? 0.08 : 0;
  const cropBias = tile.id === "full" ? 0 : 0.04;
  return confidence * 0.6 + sizeScore + runwayBias + cropBias;
}

function dedupePoses(detections) {
  const selected = [];
  detections
    .sort((a, b) => b.score - a.score)
    .forEach((candidate) => {
      const duplicate = selected.some((existing) => posesOverlap(existing.box, candidate.box));
      if (!duplicate) selected.push(candidate);
    });
  return selected.slice(0, 8);
}

function posesOverlap(a, b) {
  if (!a || !b) return false;
  const iou = boxIou(a, b);
  const centerDistance = Math.hypot((a.minX + a.maxX - b.minX - b.maxX) / 2, (a.minY + a.maxY - b.minY - b.maxY) / 2);
  const areaDelta = Math.abs(Math.log((a.area + 0.00001) / (b.area + 0.00001)));
  return iou > TILE_DUPLICATE_IOU || (centerDistance < TILE_DUPLICATE_CENTER_DISTANCE && areaDelta < 1.3);
}

function boxIou(a, b) {
  const left = Math.max(a.minX, b.minX);
  const right = Math.min(a.maxX, b.maxX);
  const top = Math.max(a.minY, b.minY);
  const bottom = Math.min(a.maxY, b.maxY);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = (a.area ?? 0) + (b.area ?? 0) - intersection;
  return union > 0 ? intersection / union : 0;
}

function reportFrameProgress(onProgress, index, totalFrames, label) {
  if (index % 2 !== 0 && index !== totalFrames - 1) return;
  onProgress({
    phase: "frames",
    progress: 0.08 + (index / totalFrames) * 0.82,
    message: `${label} ${index + 1} / ${totalFrames}`,
  });
}

function allocateTimestampBlock(preferredMs, size) {
  const base = Math.max(Math.round(preferredMs), lastDetectionTimestamp + 1);
  lastDetectionTimestamp = base + Math.max(1, size);
  return base;
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

function updateLiveTracking(video, frame) {
  const key = `${video.currentSrc || video.src}|${video.duration || 0}|${video.videoWidth || 0}x${video.videoHeight || 0}`;
  const lastFrame = liveTracking.frames.at(-1);
  if (liveTracking.key !== key || (lastFrame && frame.time + 0.04 < lastFrame.time)) {
    liveTracking.key = key;
    liveTracking.frames = [];
  }

  liveTracking.frames.push(frame);
  if (liveTracking.frames.length > 48) liveTracking.frames.shift();

  liveTracking.frames.forEach((item) => {
    item.activePoseIndex = -1;
    item.poses?.forEach((pose) => {
      delete pose.trackId;
    });
  });
  assignActivePoseTrack(liveTracking.frames);

  const current = liveTracking.frames.at(-1);
  if (current.activePoseIndex === -1) current.activePoseIndex = selectLargestPose(current.poses);
  return current;
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

async function canSeekAccurately(video, duration) {
  if (duration < 1.2 || video.currentSrc?.startsWith("blob:")) return true;
  const originalTime = video.currentTime || 0;
  const testTime = Math.min(duration - 0.35, Math.max(0.55, duration * 0.38));
  try {
    const actual = await seekVideo(video, testTime, { tolerance: 0.25 });
    await seekVideo(video, originalTime, { tolerance: 0.5, allowInaccurate: true });
    return Math.abs(actual - testTime) <= 0.25;
  } catch {
    await seekVideo(video, originalTime, { tolerance: 0.5, allowInaccurate: true }).catch(() => {});
    return false;
  }
}

function waitForVideoTick(video) {
  if ("requestVideoFrameCallback" in video) {
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, 700);
      video.requestVideoFrameCallback(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 160));
}

function seekVideo(video, time, { tolerance = 0.08, allowInaccurate = false } = {}) {
  const target = Math.min(Math.max(time, 0), video.duration || time);
  if (Math.abs(video.currentTime - target) < 0.005 && video.readyState >= 2) return Promise.resolve(video.currentTime);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
    };
    const handleSeeked = () => {
      cleanup();
      if (!allowInaccurate && Math.abs(video.currentTime - target) > tolerance) {
        reject(new Error("The selected video source could not seek accurately."));
        return;
      }
      resolve(video.currentTime);
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Unable to seek through the selected video."));
    };
    video.addEventListener("seeked", handleSeeked, { once: true });
    video.addEventListener("error", handleError, { once: true });
    video.currentTime = target;
  });
}

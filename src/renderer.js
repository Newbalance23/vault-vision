import { LM, SKELETON_CONNECTIONS } from "./landmarks.js";
import { pointConfidence } from "./math.js";

const COLORS = Object.freeze({
  active: "#31d5c8",
  activeJoint: "#ffffff",
  secondary: "rgba(217, 226, 223, 0.56)",
  marker: "#ffca58",
  markerLine: "rgba(255, 202, 88, 0.9)",
  text: "rgba(255, 255, 255, 0.92)",
});

const STATUS_COLORS = Object.freeze({
  good: "#20c777",
  okay: "#f2c94c",
  bad: "#ff5a5f",
  unknown: "#31d5c8",
});

const UPPER = new Set([LM.leftShoulder, LM.rightShoulder, LM.leftElbow, LM.rightElbow, LM.leftWrist, LM.rightWrist]);
const LOWER = new Set([
  LM.leftHip,
  LM.rightHip,
  LM.leftKnee,
  LM.rightKnee,
  LM.leftAnkle,
  LM.rightAnkle,
  LM.leftHeel,
  LM.rightHeel,
  LM.leftFootIndex,
  LM.rightFootIndex,
]);

export function resizeOverlay(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

export function drawOverlay({ canvas, video, analysis, calibration = {}, currentTime = 0 }) {
  resizeOverlay(canvas);
  const context = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  context.clearRect(0, 0, rect.width, rect.height);

  const videoRect = getVideoDrawRect(video, rect.width, rect.height);
  if (!videoRect) return;

  drawCalibration(context, calibration, videoRect);

  const frame = poseFrameAtTime(analysis?.poseFrames ?? [], currentTime);
  if (!frame) return;

  frame.poses.forEach((pose, poseIndex) => {
    const isActive = poseIndex === frame.activePoseIndex;
    drawPose(context, pose.landmarks, videoRect, isActive, isActive ? frame.form : null);
  });

  drawPhaseLabel(context, analysis, currentTime, videoRect);
}

export function canvasPointToVideoPoint(canvas, video, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const videoRect = getVideoDrawRect(video, rect.width, rect.height);
  if (!videoRect) return null;
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < videoRect.x || x > videoRect.x + videoRect.width || y < videoRect.y || y > videoRect.y + videoRect.height) {
    return null;
  }
  return {
    x: (x - videoRect.x) / videoRect.width,
    y: (y - videoRect.y) / videoRect.height,
  };
}

export function drawRunwaySketch(canvas) {
  const context = canvas.getContext("2d");
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#152321");
  gradient.addColorStop(1, "#213a37");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  context.strokeStyle = "rgba(255,255,255,0.16)";
  context.lineWidth = 2;
  for (let i = 0; i < 7; i += 1) {
    const y = 90 + i * 42;
    context.beginPath();
    context.moveTo(80, y);
    context.lineTo(width - 90, y + 38);
    context.stroke();
  }

  context.strokeStyle = "rgba(49,213,200,0.82)";
  context.lineWidth = 8;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(140, 285);
  context.lineTo(640, 142);
  context.stroke();

  context.strokeStyle = "rgba(255,202,88,0.92)";
  context.lineWidth = 6;
  context.beginPath();
  context.moveTo(660, 142);
  context.lineTo(795, 78);
  context.stroke();

  drawStickFigure(context, 560, 164, 1.25);
}

function drawStickFigure(context, x, y, scale) {
  context.strokeStyle = "#f4fbf9";
  context.fillStyle = "#f4fbf9";
  context.lineWidth = 8;
  context.lineCap = "round";
  context.beginPath();
  context.arc(x, y - 76 * scale, 15 * scale, 0, Math.PI * 2);
  context.fill();
  line(context, x - 20 * scale, y - 45 * scale, x + 18 * scale, y + 10 * scale);
  line(context, x - 18 * scale, y - 40 * scale, x - 76 * scale, y - 88 * scale);
  line(context, x + 12 * scale, y - 28 * scale, x + 78 * scale, y - 118 * scale);
  line(context, x + 18 * scale, y + 10 * scale, x - 38 * scale, y + 76 * scale);
  line(context, x + 18 * scale, y + 10 * scale, x + 82 * scale, y + 54 * scale);
}

function drawPose(context, landmarks, videoRect, isActive, form) {
  if (!landmarks?.length) return;
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = isActive ? 4 : 2;

  SKELETON_CONNECTIONS.forEach(([from, to]) => {
    const a = landmarks[from];
    const b = landmarks[to];
    if (pointConfidence(a) < 0.28 || pointConfidence(b) < 0.28) return;
    context.strokeStyle = isActive ? colorForConnection(from, to, form) : COLORS.secondary;
    line(context, mapX(a, videoRect), mapY(a, videoRect), mapX(b, videoRect), mapY(b, videoRect));
  });

  landmarks.forEach((point) => {
    if (pointConfidence(point) < 0.35) return;
    context.fillStyle = isActive ? colorForJoint(point, form) : COLORS.secondary;
    context.beginPath();
    context.arc(mapX(point, videoRect), mapY(point, videoRect), isActive ? 4 : 2.2, 0, Math.PI * 2);
    context.fill();
  });

  context.restore();
}

function drawCalibration(context, calibration, videoRect) {
  Object.entries(calibration).forEach(([key, points]) => {
    if (!Array.isArray(points) || !points.length) return;
    context.save();
    context.strokeStyle = COLORS.markerLine;
    context.fillStyle = COLORS.marker;
    context.lineWidth = 3;
    context.lineCap = "round";
    context.setLineDash(key === "runway" ? [9, 8] : []);

    if (points.length > 1) {
      context.beginPath();
      context.moveTo(toCanvas(points[0], videoRect).x, toCanvas(points[0], videoRect).y);
      points.slice(1).forEach((point) => {
        const mapped = toCanvas(point, videoRect);
        context.lineTo(mapped.x, mapped.y);
      });
      context.stroke();
    }

    points.forEach((point, index) => {
      const mapped = toCanvas(point, videoRect);
      context.beginPath();
      context.arc(mapped.x, mapped.y, 6, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "rgba(16, 22, 21, 0.9)";
      context.font = "700 11px Inter, system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String(index + 1), mapped.x, mapped.y);
      context.fillStyle = COLORS.marker;
    });
    context.restore();
  });
}

function drawPhaseLabel(context, analysis, currentTime, videoRect) {
  const phase = analysis?.phaseRanges?.find((item) => currentTime >= item.startTime && currentTime <= item.endTime);
  const frame = poseFrameAtTime(analysis?.poseFrames ?? [], currentTime);
  if (!phase) return;
  const status = frame?.form?.status ?? "unknown";
  const score = Number.isFinite(frame?.form?.overall) ? `${Math.round(frame.form.overall * 100)}%` : "";
  context.save();
  context.fillStyle = "rgba(10, 16, 15, 0.72)";
  context.beginPath();
  roundedRect(context, videoRect.x + 12, videoRect.y + 12, 230, 40, 8);
  context.fill();
  context.fillStyle = STATUS_COLORS[status] ?? STATUS_COLORS.unknown;
  context.beginPath();
  context.arc(videoRect.x + 30, videoRect.y + 32, 7, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = COLORS.text;
  context.font = "800 13px Inter, system-ui, sans-serif";
  context.fillText(`${phase.label} ${score}`, videoRect.x + 46, videoRect.y + 28);
  context.font = "700 10px Inter, system-ui, sans-serif";
  context.fillStyle = "rgba(255,255,255,0.72)";
  context.fillText(status.toUpperCase(), videoRect.x + 46, videoRect.y + 43);
  context.restore();
}

function colorForConnection(from, to, form) {
  if (!form) return COLORS.active;
  if (UPPER.has(from) && UPPER.has(to)) return STATUS_COLORS[form.colors?.upper] ?? STATUS_COLORS.unknown;
  if (LOWER.has(from) && LOWER.has(to)) return STATUS_COLORS[form.colors?.lower] ?? STATUS_COLORS.unknown;
  if ((UPPER.has(from) && LOWER.has(to)) || (LOWER.has(from) && UPPER.has(to))) {
    return STATUS_COLORS[form.colors?.core] ?? STATUS_COLORS.unknown;
  }
  return STATUS_COLORS[form.status] ?? STATUS_COLORS.unknown;
}

function colorForJoint(point, form) {
  const alpha = Math.max(0.45, pointConfidence(point));
  const hex = STATUS_COLORS[form?.status] ?? COLORS.activeJoint;
  return hexToRgba(hex, alpha);
}

function hexToRgba(hex, alpha = 1) {
  if (!hex.startsWith("#") || hex.length !== 7) return hex;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function poseFrameAtTime(frames, currentTime) {
  if (!frames.length) return null;
  if (frames.length === 1 || currentTime <= frames[0].time) return frames[0];
  if (currentTime >= frames.at(-1).time) return frames.at(-1);

  let nextIndex = frames.findIndex((frame) => frame.time >= currentTime);
  if (nextIndex <= 0) return frames[0];
  const previous = frames[nextIndex - 1];
  const next = frames[nextIndex];
  const span = Math.max(0.001, next.time - previous.time);
  const amount = (currentTime - previous.time) / span;
  if (previous.activePoseIndex !== next.activePoseIndex || previous.poses.length !== next.poses.length) {
    return amount < 0.5 ? previous : next;
  }

  return {
    time: currentTime,
    activePoseIndex: previous.activePoseIndex,
    form: interpolateForm(previous.form, next.form, amount),
    poses: previous.poses.map((pose, poseIndex) => ({
      landmarks: interpolateLandmarks(pose.landmarks, next.poses[poseIndex]?.landmarks, amount),
      worldLandmarks: interpolateLandmarks(pose.worldLandmarks, next.poses[poseIndex]?.worldLandmarks, amount),
    })),
  };
}

function interpolateLandmarks(a = [], b = [], amount) {
  if (!a.length || a.length !== b.length) return a;
  return a.map((point, index) => ({
    x: lerp(point.x, b[index].x, amount),
    y: lerp(point.y, b[index].y, amount),
    z: lerp(point.z ?? 0, b[index].z ?? 0, amount),
    visibility: lerp(point.visibility ?? 1, b[index].visibility ?? 1, amount),
  }));
}

function interpolateForm(a, b, amount) {
  if (!a || !b) return a ?? b ?? null;
  const overall = lerp(a.overall ?? 0, b.overall ?? 0, amount);
  return {
    ...a,
    time: lerp(a.time ?? 0, b.time ?? 0, amount),
    overall,
    upper: lerp(a.upper ?? 0, b.upper ?? 0, amount),
    lower: lerp(a.lower ?? 0, b.lower ?? 0, amount),
    core: lerp(a.core ?? 0, b.core ?? 0, amount),
    vault: lerp(a.vault ?? 0, b.vault ?? 0, amount),
    reliability: lerp(a.reliability ?? 0, b.reliability ?? 0, amount),
    status: statusForScore(overall),
    colors: {
      upper: statusForScore(lerp(a.upper ?? 0, b.upper ?? 0, amount)),
      lower: statusForScore(lerp(a.lower ?? 0, b.lower ?? 0, amount)),
      core: statusForScore(lerp(a.core ?? 0, b.core ?? 0, amount)),
      vault: statusForScore(lerp(a.vault ?? 0, b.vault ?? 0, amount)),
    },
  };
}

function statusForScore(score) {
  if (score >= 0.72) return "good";
  if (score >= 0.52) return "okay";
  return "bad";
}

function lerp(a, b, amount) {
  return a + (b - a) * amount;
}

function getVideoDrawRect(video, canvasWidth, canvasHeight) {
  const videoWidth = video.videoWidth || 16;
  const videoHeight = video.videoHeight || 9;
  if (!canvasWidth || !canvasHeight) return null;
  const scale = Math.min(canvasWidth / videoWidth, canvasHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    x: (canvasWidth - width) / 2,
    y: (canvasHeight - height) / 2,
    width,
    height,
  };
}

function mapX(point, videoRect) {
  return videoRect.x + point.x * videoRect.width;
}

function mapY(point, videoRect) {
  return videoRect.y + point.y * videoRect.height;
}

function toCanvas(point, videoRect) {
  return {
    x: videoRect.x + point.x * videoRect.width,
    y: videoRect.y + point.y * videoRect.height,
  };
}

function line(context, x1, y1, x2, y2) {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}

function roundedRect(context, x, y, width, height, radius) {
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
}

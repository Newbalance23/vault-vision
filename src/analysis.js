import { LM, REQUIRED_GROUPS } from "./landmarks.js";
import {
  angleBetween,
  averageConfidence,
  boundingBox,
  clamp,
  distance,
  firstIndexAfter,
  midpoint,
  movingAverage,
  round,
  segmentAngleDegrees,
} from "./math.js";

const PHASES = Object.freeze([
  { key: "approach", label: "Approach", className: "phase-approach" },
  { key: "plant-takeoff", label: "Plant / takeoff", className: "phase-plant-takeoff" },
  { key: "swing-rockback", label: "Swing / rockback", className: "phase-swing-rockback" },
  { key: "extension-turn", label: "Extension / turn", className: "phase-extension-turn" },
  { key: "clearance-landing", label: "Clearance / landing", className: "phase-clearance-landing" },
]);

const CAMERA_RELIABILITY = Object.freeze({
  side: 0.94,
  oblique: 0.78,
  auto: 0.68,
  front: 0.58,
  rear: 0.58,
});

export function analyzeVault({ frames = [], videoMeta = {}, calibration = {}, cameraAngle = "auto" } = {}) {
  const poseFrames = frames.map((frame) => ({
      time: frame.time,
      activePoseIndex: -1,
      poses: (frame.poses ?? []).map((pose) => normalizePose(pose)),
    }));

  assignActivePoseTrack(poseFrames);

  const activeSeries = poseFrames
    .map((frame) => ({
      time: frame.time,
      pose: frame.poses[frame.activePoseIndex] ?? null,
    }))
    .filter((frame) => frame.pose);

  const phaseRanges = detectPhases(activeSeries, videoMeta.duration ?? lastTime(poseFrames));
  const metrics = calculateMetrics(activeSeries, phaseRanges, cameraAngle, calibration);
  const confidence = calculateConfidence(activeSeries, metrics, cameraAngle);
  const issues = prioritizeIssues(scoreIssues(metrics, phaseRanges, confidence, cameraAngle));
  const frameScores = annotateFrameScores(poseFrames, phaseRanges, cameraAngle);
  const bodyScores = calculateBodyScores(frameScores, metrics);

  return {
    schemaVersion: "vault-vision.analysis.v1",
    createdAt: new Date().toISOString(),
    videoMeta: {
      fileName: videoMeta.fileName ?? "untitled-video",
      duration: round(videoMeta.duration ?? lastTime(poseFrames), 2),
      width: videoMeta.width ?? null,
      height: videoMeta.height ?? null,
      sampleRate: videoMeta.sampleRate ?? null,
    },
    cameraAngle,
    calibration,
    confidence,
    phaseRanges,
    metrics,
    bodyScores,
    overallScore: calculateOverallScore(bodyScores, confidence),
    issues,
    poseFrames: poseFrames.map((frame, index) => ({
      ...frame,
      form: frameScores[index] ?? emptyFrameScore(frame.time),
    })),
    limitations: [
      "Single-camera pose estimation can miss pole, hand, and foot details when the athlete is occluded.",
      "Camera angle affects scoring confidence; side-view clips are most reliable for body-line metrics.",
      "Use this as a coaching aid alongside qualified pole vault instruction.",
    ],
  };
}

export function selectActivePose(poses = []) {
  if (!poses.length) return -1;
  let bestIndex = 0;
  let bestScore = -Infinity;
  poses.forEach((pose, index) => {
    const landmarks = pose.landmarks ?? pose;
    const box = boundingBox(landmarks);
    const coreConfidence = averageConfidence(landmarks, REQUIRED_GROUPS.core);
    const areaScore = box ? box.area : 0;
    const poseScore = coreConfidence * 0.72 + clamp(areaScore * 8, 0, 1) * 0.28;
    if (poseScore > bestScore) {
      bestScore = poseScore;
      bestIndex = index;
    }
  });
  return bestIndex;
}

export function assignActivePoseTrack(poseFrames = []) {
  const tracks = [];
  poseFrames.forEach((frame, frameIndex) => {
    const observations = frame.poses
      .map((pose, poseIndex) => ({
        frameIndex,
        poseIndex,
        center: poseCenter(pose.landmarks),
        box: boundingBox(pose.landmarks),
        confidence: averageConfidence(pose.landmarks, REQUIRED_GROUPS.core),
      }))
      .filter((observation) => observation.center && observation.confidence > 0.25);

    const claimedTracks = new Set();
    observations.forEach((observation) => {
      let bestTrack = null;
      let bestDistance = Infinity;
      tracks.forEach((track) => {
        if (claimedTracks.has(track.id)) return;
        const last = track.observations.at(-1);
        if (!last || frameIndex - last.frameIndex > 5) return;
        const centerDistance = distance2d(observation.center, last.center);
        const maxDistance = 0.18 + Math.min(0.12, (frameIndex - last.frameIndex) * 0.01);
        if (centerDistance < maxDistance && centerDistance < bestDistance) {
          bestTrack = track;
          bestDistance = centerDistance;
        }
      });

      if (!bestTrack) {
        bestTrack = { id: tracks.length, observations: [] };
        tracks.push(bestTrack);
      }
      bestTrack.observations.push(observation);
      claimedTracks.add(bestTrack.id);
    });
  });

  const bestTrack = tracks
    .map((track) => ({ track, score: activeTrackScore(track, poseFrames.length) }))
    .sort((a, b) => b.score - a.score)[0]?.track;

  poseFrames.forEach((frame) => {
    frame.activePoseIndex = selectActivePose(frame.poses);
  });

  if (!bestTrack) return poseFrames;
  bestTrack.observations.forEach((observation) => {
    poseFrames[observation.frameIndex].activePoseIndex = observation.poseIndex;
  });

  fillTrackGaps(poseFrames, bestTrack);
  return poseFrames;
}

export function detectPhases(activeSeries = [], duration = 0) {
  if (!activeSeries.length) return fallbackPhases(duration);

  const hipYs = movingAverage(activeSeries.map((frame) => center(frame.pose.landmarks, LM.leftHip, LM.rightHip)?.y));
  const shoulderYs = movingAverage(
    activeSeries.map((frame) => center(frame.pose.landmarks, LM.leftShoulder, LM.rightShoulder)?.y),
  );
  const wristYs = movingAverage(
    activeSeries.map((frame) => {
      const left = frame.pose.landmarks[LM.leftWrist]?.y;
      const right = frame.pose.landmarks[LM.rightWrist]?.y;
      if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
      return Math.min(left, right);
    }),
  );

  const durationSeconds = duration || activeSeries.at(-1)?.time || 0;
  const candidateStart = Math.max(1, Math.floor(activeSeries.length * 0.15));
  const candidateEnd = Math.max(candidateStart + 1, Math.floor(activeSeries.length * 0.62));
  let takeoffIndex = candidateStart;
  let bestTakeoffScore = -Infinity;

  for (let index = candidateStart; index < candidateEnd; index += 1) {
    const hipBefore = hipYs[Math.max(0, index - 2)] ?? hipYs[index];
    const hipAfter = hipYs[Math.min(hipYs.length - 1, index + 4)] ?? hipYs[index];
    const hipLift = Number.isFinite(hipBefore) && Number.isFinite(hipAfter) ? hipBefore - hipAfter : 0;
    const wristHeight = Number.isFinite(wristYs[index]) ? 1 - wristYs[index] : 0;
    const shoulderLift = Number.isFinite(shoulderYs[index]) ? 1 - shoulderYs[index] : 0;
    const score = hipLift * 3 + wristHeight * 0.6 + shoulderLift * 0.3;
    if (score > bestTakeoffScore) {
      bestTakeoffScore = score;
      takeoffIndex = index;
    }
  }

  const inversionIndex = firstIndexAfter(activeSeries, takeoffIndex + 1, (frame) => {
    const landmarks = frame.pose.landmarks;
    const hip = center(landmarks, LM.leftHip, LM.rightHip);
    const ankle = center(landmarks, LM.leftAnkle, LM.rightAnkle);
    return hip && ankle && ankle.y < hip.y;
  });

  const extensionIndex = firstIndexAfter(activeSeries, Math.max(takeoffIndex + 2, inversionIndex), (frame) => {
    const landmarks = frame.pose.landmarks;
    const hip = center(landmarks, LM.leftHip, LM.rightHip);
    const shoulder = center(landmarks, LM.leftShoulder, LM.rightShoulder);
    return hip && shoulder && hip.y < shoulder.y;
  });

  const apexIndex = minIndex(hipYs, Math.max(takeoffIndex, extensionIndex), hipYs.length - 1);
  const ordered = orderPhaseIndexes({
    takeoffIndex,
    inversionIndex: inversionIndex === -1 ? Math.round((takeoffIndex + apexIndex) / 2) : inversionIndex,
    extensionIndex: extensionIndex === -1 ? Math.round((takeoffIndex + apexIndex * 2) / 3) : extensionIndex,
    apexIndex: apexIndex === -1 ? Math.round(activeSeries.length * 0.78) : apexIndex,
    length: activeSeries.length,
  });

  return [
    phaseRange(PHASES[0], activeSeries, 0, ordered.takeoffIndex),
    phaseRange(PHASES[1], activeSeries, ordered.takeoffIndex, ordered.inversionIndex),
    phaseRange(PHASES[2], activeSeries, ordered.inversionIndex, ordered.extensionIndex),
    phaseRange(PHASES[3], activeSeries, ordered.extensionIndex, ordered.apexIndex),
    phaseRange(PHASES[4], activeSeries, ordered.apexIndex, activeSeries.length - 1, durationSeconds),
  ];
}

export function calculateMetrics(activeSeries = [], phaseRanges = [], cameraAngle = "auto", calibration = {}) {
  const plantRange = phaseRanges.find((phase) => phase.key === "plant-takeoff");
  const swingRange = phaseRanges.find((phase) => phase.key === "swing-rockback");
  const extensionRange = phaseRanges.find((phase) => phase.key === "extension-turn");
  const approachRange = phaseRanges.find((phase) => phase.key === "approach");
  const clearanceRange = phaseRanges.find((phase) => phase.key === "clearance-landing");

  const plantFrame = nearestFrame(activeSeries, plantRange?.startTime ?? 0);
  const swingFrame = bestFrameInRange(activeSeries, swingRange, inversionRatio);
  const extensionFrame = bestFrameInRange(activeSeries, extensionRange, hipAboveShoulderRatio);
  const approachFrames = framesInRange(activeSeries, approachRange);
  const clearanceFrame = bestFrameInRange(activeSeries, clearanceRange, bodyLineScore);

  const approachSpeedValues = approachFrames.map((frame, index) => {
    if (!index) return null;
    const previous = center(approachFrames[index - 1].pose.landmarks, LM.leftHip, LM.rightHip);
    const current = center(frame.pose.landmarks, LM.leftHip, LM.rightHip);
    const dt = frame.time - approachFrames[index - 1].time;
    if (!previous || !current || dt <= 0) return null;
    return Math.abs(current.x - previous.x) / dt;
  });

  const approachRhythmScore = consistencyScore(approachSpeedValues);
  const plantArmExtension = armExtensionScore(plantFrame?.pose.landmarks);
  const takeoffKneeDrive = kneeDriveScore(plantFrame?.pose.landmarks);
  const trunkLean = trunkLeanDegrees(plantFrame?.pose.landmarks);
  const trailLeg = trailLegStraightness(swingFrame?.pose.landmarks);
  const inversion = inversionRatio(swingFrame);
  const hipRise = hipAboveShoulderRatio(extensionFrame);
  const shoulderHip = shoulderHipAlignment(extensionFrame?.pose.landmarks);
  const clearance = bodyLineScore(clearanceFrame);
  const cameraReliability = CAMERA_RELIABILITY[cameraAngle] ?? CAMERA_RELIABILITY.auto;

  return {
    frameCount: activeSeries.length,
    cameraReliability: round(cameraReliability, 2),
    calibrationCompleteness: round(calibrationScore(calibration), 2),
    approachRhythm: round(approachRhythmScore * cameraReliability, 2),
    plantArmExtension: round(plantArmExtension, 2),
    takeoffKneeDrive: round(takeoffKneeDrive, 2),
    trunkLeanDegrees: round(trunkLean, 1),
    trailLegStraightness: round(trailLeg, 2),
    inversionQuality: round(inversion, 2),
    hipRise: round(hipRise, 2),
    shoulderHipAlignment: round(shoulderHip, 2),
    clearanceLine: round(clearance, 2),
  };
}

export function annotateFrameScores(poseFrames = [], phaseRanges = [], cameraAngle = "auto") {
  const cameraReliability = CAMERA_RELIABILITY[cameraAngle] ?? CAMERA_RELIABILITY.auto;
  return poseFrames.map((frame) => {
    const activePose = frame.poses?.[frame.activePoseIndex];
    const phase = phaseForTime(phaseRanges, frame.time);
    if (!activePose) return emptyFrameScore(frame.time, phase);
    const landmarks = activePose.landmarks;
    const upper = scoreUpperBody(landmarks, phase?.key);
    const lower = scoreLowerBody(landmarks, phase?.key);
    const core = scoreCoreLine(landmarks, phase?.key);
    const vault = scorePhaseSpecific(activePose, phase?.key);
    const reliability = averageConfidence(landmarks, [
      ...REQUIRED_GROUPS.core,
      ...REQUIRED_GROUPS.arms,
      ...REQUIRED_GROUPS.legs,
    ]);
    const overall = clamp((upper * 0.28 + lower * 0.25 + core * 0.25 + vault * 0.22) * cameraReliability);
    return {
      time: round(frame.time, 2),
      phaseKey: phase?.key ?? "unknown",
      phaseLabel: phase?.label ?? "Unknown",
      overall: round(overall, 2),
      upper: round(upper, 2),
      lower: round(lower, 2),
      core: round(core, 2),
      vault: round(vault, 2),
      reliability: round(reliability, 2),
      status: statusForScore(overall),
      colors: {
        upper: statusForScore(upper),
        lower: statusForScore(lower),
        core: statusForScore(core),
        vault: statusForScore(vault),
      },
    };
  });
}

export function calculateBodyScores(frameScores = [], metrics = {}) {
  const reliableScores = frameScores.filter((frame) => frame.reliability >= 0.35);
  const average = (key) => {
    const values = reliableScores.map((frame) => frame[key]).filter(Number.isFinite);
    if (!values.length) return null;
    return round(values.reduce((sum, value) => sum + value, 0) / values.length, 2);
  };

  return {
    upperBody: average("upper"),
    lowerBody: average("lower"),
    coreLine: average("core"),
    vaultTiming: average("vault"),
    approach: phaseAverage(reliableScores, "approach"),
    plantTakeoff: phaseAverage(reliableScores, "plant-takeoff"),
    swingRockback: phaseAverage(reliableScores, "swing-rockback"),
    extensionTurn: phaseAverage(reliableScores, "extension-turn"),
    clearanceLanding: phaseAverage(reliableScores, "clearance-landing"),
    plantArmExtension: metrics.plantArmExtension ?? null,
    takeoffKneeDrive: metrics.takeoffKneeDrive ?? null,
    inversionQuality: metrics.inversionQuality ?? null,
  };
}

export function calculateOverallScore(bodyScores = {}, confidence = {}) {
  const values = [
    bodyScores.upperBody,
    bodyScores.lowerBody,
    bodyScores.coreLine,
    bodyScores.vaultTiming,
    bodyScores.plantTakeoff,
    bodyScores.swingRockback,
    bodyScores.extensionTurn,
  ].filter(Number.isFinite);
  if (!values.length) return 0;
  const raw = values.reduce((sum, value) => sum + value, 0) / values.length;
  const confidenceFactor = 0.72 + (confidence.overall ?? 0.5) * 0.28;
  return Math.round(clamp(raw * confidenceFactor) * 100);
}

export function scoreIssues(metrics, phaseRanges, confidence, cameraAngle) {
  const phaseAt = (key) => phaseRanges.find((phase) => phase.key === key)?.label ?? key;
  const uncertain = confidence.overall < 0.5;
  const issues = [];

  addIssue(issues, {
    id: "approach-rhythm",
    title: "Approach rhythm changes late",
    phase: phaseAt("approach"),
    value: metrics.approachRhythm,
    threshold: 0.62,
    priority: "medium",
    cue: "Keep the last strides tall and rhythmic so the plant arrives on time.",
    drill: "Runway pole-carry buildups with a check mark at the final three steps.",
    confidence: confidence.pose * metrics.cameraReliability,
  });

  addIssue(issues, {
    id: "plant-extension",
    title: "Plant arm extension is limited",
    phase: phaseAt("plant-takeoff"),
    value: metrics.plantArmExtension,
    threshold: 0.68,
    priority: "high",
    cue: "Reach the top hand high through takeoff and avoid collapsing the lower arm early.",
    drill: "Walking plants into the box with a tall takeoff posture.",
    confidence: confidence.pose,
  });

  addIssue(issues, {
    id: "knee-drive",
    title: "Drive knee is not rising enough at takeoff",
    phase: phaseAt("plant-takeoff"),
    value: metrics.takeoffKneeDrive,
    threshold: 0.58,
    priority: "medium",
    cue: "Drive the free knee up as the takeoff foot leaves the runway.",
    drill: "Three-step pop-ups with a held knee-drive finish.",
    confidence: confidence.pose,
  });

  addIssue(issues, {
    id: "trail-leg",
    title: "Trail leg shortens during swing",
    phase: phaseAt("swing-rockback"),
    value: metrics.trailLegStraightness,
    threshold: 0.62,
    priority: "medium",
    cue: "Keep the trail leg long through the downswing before the rockback.",
    drill: "High-bar long-swing drills and low-grip swing-ups.",
    confidence: confidence.pose,
  });

  addIssue(issues, {
    id: "inversion",
    title: "Hips are late getting above the shoulders",
    phase: phaseAt("extension-turn"),
    value: Math.max(metrics.inversionQuality, metrics.hipRise),
    threshold: 0.56,
    priority: "high",
    cue: "Finish the swing before pulling so the hips can rise with the pole.",
    drill: "Bubka progressions and short-run vaults focused on swing timing.",
    confidence: confidence.pose * metrics.cameraReliability,
  });

  addIssue(issues, {
    id: "clearance-line",
    title: "Clearance line is loose",
    phase: phaseAt("clearance-landing"),
    value: metrics.clearanceLine,
    threshold: 0.52,
    priority: "low",
    cue: "Stay connected through shoulders, hips, and feet over the bar.",
    drill: "Back-over bar drills and controlled turn-finish work.",
    confidence: confidence.pose * metrics.cameraReliability,
  });

  if (uncertain || cameraAngle === "front" || cameraAngle === "rear") {
    issues.unshift({
      id: "confidence-warning",
      title: "Camera angle limits some automatic scoring",
      phase: "Setup",
      priority: "medium",
      score: round(confidence.overall, 2),
      cue: "Review the overlay and calibration marks before acting on any single score.",
      drill: "For the next clip, use a steady camera with the full body visible from approach through landing.",
      confidence: round(confidence.overall, 2),
      status: "warning",
    });
  }

  if (!issues.length) {
    issues.push({
      id: "solid-baseline",
      title: "No major red flags from the available landmarks",
      phase: "Overall",
      priority: "low",
      score: round(confidence.overall, 2),
      cue: "Use frame-by-frame review to confirm the plant, swing, and clearance details.",
      drill: "Compare this jump against a future clip using the same camera setup.",
      confidence: round(confidence.overall, 2),
      status: "positive",
    });
  }

  return issues;
}

export function prioritizeIssues(issues = []) {
  const priorityRank = { high: 0, medium: 1, low: 2 };
  return [...issues].sort((a, b) => {
    const priorityDelta = (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3);
    if (priorityDelta) return priorityDelta;
    return (a.score ?? 1) - (b.score ?? 1);
  });
}

function normalizePose(pose) {
  return {
    landmarks: (pose.landmarks ?? pose ?? []).map(stripPoint),
    worldLandmarks: (pose.worldLandmarks ?? []).map(stripPoint),
  };
}

function poseCenter(landmarks) {
  const hip = center(landmarks, LM.leftHip, LM.rightHip);
  const shoulder = center(landmarks, LM.leftShoulder, LM.rightShoulder);
  return hip ?? shoulder ?? bboxCenter(boundingBox(landmarks));
}

function bboxCenter(box) {
  if (!box) return null;
  return {
    x: (box.minX + box.maxX) / 2,
    y: (box.minY + box.maxY) / 2,
  };
}

function distance2d(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function activeTrackScore(track, totalFrames) {
  const observations = track.observations;
  if (observations.length < 2) return 0;
  const coverage = observations.length / Math.max(1, totalFrames);
  const path = observations.slice(1).reduce((sum, observation, index) => {
    return sum + distance2d(observation.center, observations[index].center);
  }, 0);
  const first = observations[0].center;
  const last = observations.at(-1).center;
  const displacement = distance2d(first, last);
  const yValues = observations.map((observation) => observation.center.y);
  const verticalTravel = Math.max(...yValues) - Math.min(...yValues);
  const xValues = observations.map((observation) => observation.center.x);
  const horizontalTravel = Math.max(...xValues) - Math.min(...xValues);
  const meanArea =
    observations.reduce((sum, observation) => sum + (observation.box?.area ?? 0), 0) / Math.max(1, observations.length);
  const stationaryPenalty = path < 0.08 ? 0.28 : 1;
  return (
    (path * 2.4 + displacement * 1.8 + horizontalTravel * 1.2 + verticalTravel * 1.35 + coverage * 0.22 + meanArea * 0.05) *
    stationaryPenalty
  );
}

function fillTrackGaps(poseFrames, track) {
  const observationsByFrame = new Map(track.observations.map((observation) => [observation.frameIndex, observation]));
  let lastCenter = null;
  poseFrames.forEach((frame, frameIndex) => {
    const observation = observationsByFrame.get(frameIndex);
    if (observation) {
      lastCenter = observation.center;
      return;
    }
    if (!lastCenter || !frame.poses.length) return;
    let bestPoseIndex = frame.activePoseIndex;
    let bestDistance = Infinity;
    frame.poses.forEach((pose, poseIndex) => {
      const centerPoint = poseCenter(pose.landmarks);
      const d = distance2d(centerPoint, lastCenter);
      if (d < bestDistance) {
        bestDistance = d;
        bestPoseIndex = poseIndex;
      }
    });
    if (bestDistance < 0.22) {
      frame.activePoseIndex = bestPoseIndex;
      lastCenter = poseCenter(frame.poses[bestPoseIndex].landmarks);
    }
  });
}

function stripPoint(point) {
  return {
    x: round(point.x, 5),
    y: round(point.y, 5),
    z: round(point.z ?? 0, 5),
    visibility: round(point.visibility ?? point.presence ?? point.score ?? 1, 3),
  };
}

function center(landmarks, leftIndex, rightIndex) {
  return midpoint(landmarks?.[leftIndex], landmarks?.[rightIndex]);
}

function lastTime(frames) {
  return frames.at(-1)?.time ?? 0;
}

function fallbackPhases(duration = 0) {
  const ranges = [0, 0.36, 0.46, 0.64, 0.82, 1].map((part) => part * duration);
  return PHASES.map((phase, index) => ({
    ...phase,
    startTime: round(ranges[index], 2),
    endTime: round(ranges[index + 1], 2),
    confidence: 0.25,
  }));
}

function phaseRange(phase, activeSeries, startIndex, endIndex, durationOverride) {
  const safeStart = clamp(Math.min(startIndex, endIndex), 0, activeSeries.length - 1);
  const safeEnd = clamp(Math.max(startIndex, endIndex), 0, activeSeries.length - 1);
  return {
    ...phase,
    startTime: round(activeSeries[safeStart]?.time ?? 0, 2),
    endTime: round(durationOverride ?? activeSeries[safeEnd]?.time ?? activeSeries.at(-1)?.time ?? 0, 2),
    confidence: 0.62,
  };
}

function orderPhaseIndexes(indexes) {
  const length = Math.max(1, indexes.length);
  const takeoffIndex = clamp(Math.round(indexes.takeoffIndex), 1, length - 5);
  const inversionIndex = clamp(Math.max(indexes.inversionIndex, takeoffIndex + 1), takeoffIndex + 1, length - 4);
  const extensionIndex = clamp(Math.max(indexes.extensionIndex, inversionIndex + 1), inversionIndex + 1, length - 3);
  const apexIndex = clamp(Math.max(indexes.apexIndex, extensionIndex + 1), extensionIndex + 1, length - 2);
  return { takeoffIndex, inversionIndex, extensionIndex, apexIndex };
}

function minIndex(values, start, end) {
  let bestIndex = -1;
  let bestValue = Infinity;
  for (let index = Math.max(0, start); index <= Math.min(values.length - 1, end); index += 1) {
    const value = values[index];
    if (Number.isFinite(value) && value < bestValue) {
      bestValue = value;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function nearestFrame(series, time) {
  if (!series.length) return null;
  return series.reduce((best, frame) => (Math.abs(frame.time - time) < Math.abs(best.time - time) ? frame : best), series[0]);
}

function framesInRange(series, range) {
  if (!range) return [];
  return series.filter((frame) => frame.time >= range.startTime && frame.time <= range.endTime);
}

function bestFrameInRange(series, range, scoreFn) {
  const candidates = framesInRange(series, range);
  if (!candidates.length) return null;
  return candidates.reduce((best, frame) => (scoreFn(frame) > scoreFn(best) ? frame : best), candidates[0]);
}

function consistencyScore(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 3) return 0.45;
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  if (!mean) return 0.4;
  const variance = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / clean.length;
  return clamp(1 - Math.sqrt(variance) / mean);
}

function armExtensionScore(landmarks) {
  if (!landmarks) return 0;
  const left = angleBetween(landmarks[LM.leftShoulder], landmarks[LM.leftElbow], landmarks[LM.leftWrist]) ?? 0;
  const right = angleBetween(landmarks[LM.rightShoulder], landmarks[LM.rightElbow], landmarks[LM.rightWrist]) ?? 0;
  return clamp(Math.max(left, right) / 180);
}

function kneeDriveScore(landmarks) {
  if (!landmarks) return 0;
  const hip = center(landmarks, LM.leftHip, LM.rightHip);
  const leftKnee = landmarks[LM.leftKnee];
  const rightKnee = landmarks[LM.rightKnee];
  if (!hip || !leftKnee || !rightKnee) return 0;
  const bestKneeRise = Math.max(hip.y - leftKnee.y, hip.y - rightKnee.y);
  return clamp(bestKneeRise * 4 + 0.28);
}

function trunkLeanDegrees(landmarks) {
  if (!landmarks) return null;
  const hip = center(landmarks, LM.leftHip, LM.rightHip);
  const shoulder = center(landmarks, LM.leftShoulder, LM.rightShoulder);
  const angle = segmentAngleDegrees(hip, shoulder);
  if (!Number.isFinite(angle)) return null;
  return Math.abs(90 - Math.abs(angle));
}

function trailLegStraightness(landmarks) {
  if (!landmarks) return 0;
  const left = angleBetween(landmarks[LM.leftHip], landmarks[LM.leftKnee], landmarks[LM.leftAnkle]) ?? 0;
  const right = angleBetween(landmarks[LM.rightHip], landmarks[LM.rightKnee], landmarks[LM.rightAnkle]) ?? 0;
  return clamp(Math.max(left, right) / 180);
}

function inversionRatio(frame) {
  const landmarks = frame?.pose?.landmarks;
  if (!landmarks) return 0;
  const hip = center(landmarks, LM.leftHip, LM.rightHip);
  const ankle = center(landmarks, LM.leftAnkle, LM.rightAnkle);
  const shoulder = center(landmarks, LM.leftShoulder, LM.rightShoulder);
  if (!hip || !ankle || !shoulder) return 0;
  const bodySpan = Math.max(0.05, distance(shoulder, hip) ?? 0.1);
  return clamp((hip.y - ankle.y) / bodySpan + 0.45);
}

function hipAboveShoulderRatio(frame) {
  const landmarks = frame?.pose?.landmarks;
  if (!landmarks) return 0;
  const hip = center(landmarks, LM.leftHip, LM.rightHip);
  const shoulder = center(landmarks, LM.leftShoulder, LM.rightShoulder);
  if (!hip || !shoulder) return 0;
  const torso = Math.max(0.05, distance(shoulder, hip) ?? 0.1);
  return clamp((shoulder.y - hip.y) / torso + 0.45);
}

function shoulderHipAlignment(landmarks) {
  if (!landmarks) return 0;
  const leftShoulder = landmarks[LM.leftShoulder];
  const rightShoulder = landmarks[LM.rightShoulder];
  const leftHip = landmarks[LM.leftHip];
  const rightHip = landmarks[LM.rightHip];
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return 0;
  const shoulderSlope = Math.abs(leftShoulder.y - rightShoulder.y);
  const hipSlope = Math.abs(leftHip.y - rightHip.y);
  return clamp(1 - (shoulderSlope + hipSlope) * 4);
}

function bodyLineScore(frame) {
  const landmarks = frame?.pose?.landmarks;
  if (!landmarks) return 0;
  const shoulder = center(landmarks, LM.leftShoulder, LM.rightShoulder);
  const hip = center(landmarks, LM.leftHip, LM.rightHip);
  const ankle = center(landmarks, LM.leftAnkle, LM.rightAnkle);
  if (!shoulder || !hip || !ankle) return 0;
  const shoulderHip = distance(shoulder, hip) ?? 0;
  const hipAnkle = distance(hip, ankle) ?? 0;
  const direct = distance(shoulder, ankle) ?? 0;
  if (!shoulderHip || !hipAnkle) return 0;
  return clamp(direct / (shoulderHip + hipAnkle));
}

function calibrationScore(calibration) {
  const markers = ["box", "runway", "bar", "pole"];
  const present = markers.filter((key) => Array.isArray(calibration[key]) && calibration[key].length).length;
  return present / markers.length;
}

function calculateConfidence(activeSeries, metrics, cameraAngle) {
  const poseConfidences = activeSeries.map((frame) =>
    averageConfidence(frame.pose.landmarks, [...REQUIRED_GROUPS.core, ...REQUIRED_GROUPS.arms, ...REQUIRED_GROUPS.legs]),
  );
  const pose = poseConfidences.length
    ? poseConfidences.reduce((sum, value) => sum + value, 0) / poseConfidences.length
    : 0;
  const coverage = clamp(activeSeries.length / 60);
  const camera = CAMERA_RELIABILITY[cameraAngle] ?? CAMERA_RELIABILITY.auto;
  const calibration = metrics.calibrationCompleteness ?? 0;
  return {
    pose: round(pose, 2),
    coverage: round(coverage, 2),
    camera: round(camera, 2),
    calibration: round(calibration, 2),
    overall: round(pose * 0.48 + coverage * 0.18 + camera * 0.22 + calibration * 0.12, 2),
  };
}

function addIssue(issues, issue) {
  if (!Number.isFinite(issue.value)) return;
  const confidence = issue.confidence ?? 0;
  if (confidence < 0.32) return;
  if (issue.value >= issue.threshold) return;
  issues.push({
    id: issue.id,
    title: issue.title,
    phase: issue.phase,
    priority: issue.priority,
    score: round(issue.value, 2),
    cue: issue.cue,
    drill: issue.drill,
    confidence: round(confidence, 2),
    status: "needs-work",
  });
}

function phaseForTime(phaseRanges, time) {
  return phaseRanges.find((phase) => time >= phase.startTime && time <= phase.endTime) ?? phaseRanges.at(-1) ?? null;
}

function emptyFrameScore(time = 0, phase = null) {
  return {
    time: round(time, 2),
    phaseKey: phase?.key ?? "unknown",
    phaseLabel: phase?.label ?? "Unknown",
    overall: 0,
    upper: 0,
    lower: 0,
    core: 0,
    vault: 0,
    reliability: 0,
    status: "bad",
    colors: {
      upper: "bad",
      lower: "bad",
      core: "bad",
      vault: "bad",
    },
  };
}

function statusForScore(score) {
  if (score >= 0.72) return "good";
  if (score >= 0.52) return "okay";
  return "bad";
}

function scoreUpperBody(landmarks, phaseKey) {
  const extension = armExtensionScore(landmarks);
  const alignment = shoulderHipAlignment(landmarks);
  if (phaseKey === "plant-takeoff") return clamp(extension * 0.78 + alignment * 0.22);
  if (phaseKey === "extension-turn" || phaseKey === "clearance-landing") return clamp(extension * 0.42 + alignment * 0.58);
  return clamp(extension * 0.5 + alignment * 0.5);
}

function scoreLowerBody(landmarks, phaseKey) {
  const kneeDrive = kneeDriveScore(landmarks);
  const trailLeg = trailLegStraightness(landmarks);
  if (phaseKey === "plant-takeoff") return clamp(kneeDrive * 0.7 + trailLeg * 0.3);
  if (phaseKey === "swing-rockback") return trailLeg;
  return clamp(kneeDrive * 0.34 + trailLeg * 0.66);
}

function scoreCoreLine(landmarks, phaseKey) {
  const lean = trunkLeanDegrees(landmarks);
  const alignment = shoulderHipAlignment(landmarks);
  const leanScore = Number.isFinite(lean) ? clamp(1 - lean / 55) : 0.5;
  if (phaseKey === "approach" || phaseKey === "plant-takeoff") return clamp(leanScore * 0.58 + alignment * 0.42);
  return clamp(bodyLineScore({ pose: { landmarks } }) * 0.52 + alignment * 0.48);
}

function scorePhaseSpecific(activePose, phaseKey) {
  if (!activePose?.landmarks) return 0;
  const frame = { pose: activePose };
  if (phaseKey === "approach") return scoreCoreLine(activePose.landmarks, phaseKey);
  if (phaseKey === "plant-takeoff") {
    return clamp(armExtensionScore(activePose.landmarks) * 0.52 + kneeDriveScore(activePose.landmarks) * 0.48);
  }
  if (phaseKey === "swing-rockback") {
    return clamp(trailLegStraightness(activePose.landmarks) * 0.54 + inversionRatio(frame) * 0.46);
  }
  if (phaseKey === "extension-turn") {
    return clamp(hipAboveShoulderRatio(frame) * 0.64 + shoulderHipAlignment(activePose.landmarks) * 0.36);
  }
  if (phaseKey === "clearance-landing") {
    return bodyLineScore(frame);
  }
  return 0.5;
}

function phaseAverage(frameScores, phaseKey) {
  const values = frameScores
    .filter((frame) => frame.phaseKey === phaseKey)
    .map((frame) => frame.overall)
    .filter(Number.isFinite);
  if (!values.length) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 2);
}

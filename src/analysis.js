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
  pointConfidence,
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

const TRACK_MAX_GAP = 12;
const TRACK_MIN_CORE_CONFIDENCE = 0.2;
const TRACK_MIN_FILL_CONFIDENCE = 0.18;
const TRACK_POSE_MATCH_LANDMARKS = Object.freeze([
  LM.leftShoulder,
  LM.rightShoulder,
  LM.leftElbow,
  LM.rightElbow,
  LM.leftWrist,
  LM.rightWrist,
  LM.leftHip,
  LM.rightHip,
  LM.leftKnee,
  LM.rightKnee,
  LM.leftAnkle,
  LM.rightAnkle,
  LM.leftFootIndex,
  LM.rightFootIndex,
]);

const VAULT_STYLE_DEFINITIONS = Object.freeze([
  {
    id: "speed-builder",
    label: "Speed Builder",
    phaseKey: "approach",
    phaseLabel: "Approach",
    summary: "Your strongest signal is the runway build: rhythm, posture, and pole carry into the plant.",
    cue: "Keep the last three strides tall and quick so the pole drop arrives on time.",
  },
  {
    id: "tall-plant",
    label: "Tall Plant",
    phaseKey: "plant-takeoff",
    phaseLabel: "Plant / takeoff",
    summary: "Your strongest signal is a high plant shape with the body prepared to leave the runway.",
    cue: "Finish the plant tall before the takeoff foot leaves the ground.",
  },
  {
    id: "long-swinger",
    label: "Long Swinger",
    phaseKey: "swing-rockback",
    phaseLabel: "Swing / rockback",
    summary: "Your strongest signal is the trail leg and swing path into rockback.",
    cue: "Let the long swing finish before pulling with the shoulders.",
  },
  {
    id: "inverter",
    label: "Inverter",
    phaseKey: "extension-turn",
    phaseLabel: "Extension / turn",
    summary: "Your strongest signal is hip rise, extension, and shoulder-hip organization near the top.",
    cue: "Stay long through extension, then turn after the hips rise.",
  },
  {
    id: "bar-finisher",
    label: "Bar Finisher",
    phaseKey: "clearance-landing",
    phaseLabel: "Clearance / landing",
    summary: "Your strongest signal is the body line around bar clearance.",
    cue: "Keep shoulders, hips, and feet connected through the finish.",
  },
]);

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
  const coachingBreakdown = buildCoachingBreakdown(metrics, bodyScores, phaseRanges, confidence, cameraAngle, calibration);
  const overallScore = calculateOverallScore(bodyScores, confidence);
  const vaultStyle = buildVaultStyle(metrics, bodyScores, confidence);
  const vaultReport = buildVaultReport({
    metrics,
    bodyScores,
    issues,
    coachingBreakdown,
    confidence,
    overallScore,
    vaultStyle,
    cameraAngle,
  });

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
    overallScore,
    issues,
    coachingBreakdown,
    vaultStyle,
    vaultReport,
    researchBasis: [
      {
        title: "World Athletics pole vault technique guide",
        url: "https://worldathletics.org/disciplines/throws/pole-vault",
        appliedTo: ["approach rhythm", "plant arm extension", "drive knee", "swing", "extension", "turn", "clearance"],
      },
      {
        title: "Kinematics of the final approach and take-off in world-class pole vaulters",
        url: "https://eprints.glos.ac.uk/10962/",
        appliedTo: ["run-up velocity", "final step timing", "plant box distance", "takeoff angle", "hand-foot relationship"],
      },
      {
        title: "Athletics South Africa coaching pole vault notes",
        url: "https://athleticssa.org.za/SportsInfo/Coaching-Pole-Vault.pdf",
        appliedTo: ["tall approach", "early high plant", "takeoff foot under top hand", "free knee drive", "delayed turn"],
      },
    ],
    poseFrames: poseFrames.map((frame, index) => ({
      ...frame,
      form: frameScores[index] ?? emptyFrameScore(frame.time),
    })),
    tracking: summarizePoseTracking(poseFrames),
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
  poseFrames.forEach((frame) => {
    frame.poses?.forEach((pose) => {
      delete pose.trackId;
    });
  });

  poseFrames.forEach((frame, frameIndex) => {
    const observations = poseObservations(frame, frameIndex);
    const matches = [];

    observations.forEach((observation) => {
      tracks.forEach((track) => {
        const match = trackMatch(track, observation, frameIndex);
        if (match) matches.push({ track, observation, ...match });
      });
    });

    matches.sort((a, b) => a.cost - b.cost);
    const claimedTracks = new Set();
    const claimedObservations = new Set();

    matches.forEach((match) => {
      if (claimedTracks.has(match.track.id) || claimedObservations.has(match.observation)) return;
      pushTrackObservation(match.track, match.observation);
      claimedTracks.add(match.track.id);
      claimedObservations.add(match.observation);
    });

    observations.forEach((observation) => {
      if (claimedObservations.has(observation)) return;
      const track = { id: tracks.length, observations: [], velocity: { x: 0, y: 0 } };
      pushTrackObservation(track, observation);
      tracks.push(track);
    });
  });

  const bestTrack = tracks
    .map((track) => ({ track, score: activeTrackScore(track, poseFrames.length) }))
    .sort((a, b) => b.score - a.score)[0]?.track;

  if (!bestTrack) {
    poseFrames.forEach((frame) => {
      frame.activePoseIndex = selectActivePose(frame.poses);
    });
    return poseFrames;
  }

  poseFrames.forEach((frame) => {
    frame.activePoseIndex = -1;
  });
  tracks.forEach((track) => {
    track.observations.forEach((observation) => {
      const pose = poseFrames[observation.frameIndex]?.poses?.[observation.poseIndex];
      if (pose) pose.trackId = track.id;
    });
  });
  const activeStartFrame = poseFrames.some((frame) => frame.poses.length > 1)
    ? vaultFocusStartFrame(bestTrack, poseFrames.length)
    : 0;
  bestTrack.observations.forEach((observation) => {
    if (observation.frameIndex < activeStartFrame) return;
    poseFrames[observation.frameIndex].activePoseIndex = observation.poseIndex;
  });

  fillTrackGaps(poseFrames, bestTrack, activeStartFrame);
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
  const plantIndex = nearestFrameIndex(activeSeries, plantRange?.startTime ?? 0);

  const approachSpeedValues = approachFrames.map((frame, index) => {
    if (!index) return null;
    const previous = center(approachFrames[index - 1].pose.landmarks, LM.leftHip, LM.rightHip);
    const current = center(frame.pose.landmarks, LM.leftHip, LM.rightHip);
    const dt = frame.time - approachFrames[index - 1].time;
    if (!previous || !current || dt <= 0) return null;
    return Math.abs(current.x - previous.x) / dt;
  });

  const cameraReliability = CAMERA_RELIABILITY[cameraAngle] ?? CAMERA_RELIABILITY.auto;
  const approachRhythmScore = consistencyScore(approachSpeedValues);
  const approachAcceleration = lateApproachSpeedScore(approachSpeedValues);
  const poleCarryControl = poleCarryControlScore(approachFrames);
  const plantArmExtension = armExtensionScore(plantFrame?.pose.landmarks);
  const plantHandPosition = plantHandPositionScore(plantFrame?.pose.landmarks);
  const plantPosition = plantPositionScore(plantFrame?.pose.landmarks, calibration);
  const takeoffKneeDrive = kneeDriveScore(plantFrame?.pose.landmarks);
  const takeoffAngle = takeoffAngleDegrees(activeSeries, plantIndex);
  const takeoffAngleQuality = takeoffAngleScore(takeoffAngle, cameraReliability);
  const trunkLean = trunkLeanDegrees(plantFrame?.pose.landmarks);
  const trailLeg = trailLegStraightness(swingFrame?.pose.landmarks);
  const inversion = inversionRatio(swingFrame);
  const hipRise = hipAboveShoulderRatio(extensionFrame);
  const shoulderHip = shoulderHipAlignment(extensionFrame?.pose.landmarks);
  const clearance = bodyLineScore(clearanceFrame);
  const turnTiming = delayedTurnScore(extensionFrame?.pose.landmarks, clearanceFrame?.pose.landmarks);

  return {
    frameCount: activeSeries.length,
    cameraReliability: round(cameraReliability, 2),
    calibrationCompleteness: round(calibrationScore(calibration), 2),
    calibrationNeeds: calibrationNeeds(calibration),
    approachRhythm: round(approachRhythmScore * cameraReliability, 2),
    approachAcceleration: round(approachAcceleration * cameraReliability, 2),
    poleCarryControl: round(poleCarryControl * cameraReliability, 2),
    plantArmExtension: round(plantArmExtension, 2),
    plantHandPosition: round(plantHandPosition, 2),
    plantPosition: round(plantPosition, 2),
    takeoffKneeDrive: round(takeoffKneeDrive, 2),
    takeoffAngleDegrees: round(takeoffAngle, 1),
    takeoffAngleQuality: round(takeoffAngleQuality, 2),
    trunkLeanDegrees: round(trunkLean, 1),
    trailLegStraightness: round(trailLeg, 2),
    inversionQuality: round(inversion, 2),
    hipRise: round(hipRise, 2),
    shoulderHipAlignment: round(shoulderHip, 2),
    turnTiming: round(turnTiming, 2),
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
    approachAcceleration: metrics.approachAcceleration ?? null,
    poleCarryControl: metrics.poleCarryControl ?? null,
    plantArmExtension: metrics.plantArmExtension ?? null,
    plantHandPosition: metrics.plantHandPosition ?? null,
    plantPosition: metrics.plantPosition ?? null,
    takeoffKneeDrive: metrics.takeoffKneeDrive ?? null,
    takeoffAngleQuality: metrics.takeoffAngleQuality ?? null,
    inversionQuality: metrics.inversionQuality ?? null,
    turnTiming: metrics.turnTiming ?? null,
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
    evidence: `Approach rhythm score ${percentText(metrics.approachRhythm)} from hip-center speed consistency.`,
    measureNext: "Add step check marks so the app can compare takeoff distance and final-stride rhythm across jumps.",
    confidence: confidence.pose * metrics.cameraReliability,
  });

  addIssue(issues, {
    id: "approach-speed-build",
    title: "Approach speed is not building into takeoff",
    phase: phaseAt("approach"),
    value: metrics.approachAcceleration,
    threshold: 0.55,
    priority: "medium",
    cue: "Build speed smoothly into the box without reaching or chopping in the last strides.",
    drill: "Six-step pole runs with a relaxed pole drop and a fast last three steps.",
    evidence: `Late approach build score ${percentText(metrics.approachAcceleration)} from the active vaulter's hip path.`,
    measureNext: "Mark step positions or add a side-view calibration line to separate true speed changes from camera perspective.",
    confidence: confidence.pose * metrics.cameraReliability,
  });

  addIssue(issues, {
    id: "pole-carry-control",
    title: "Pole carry or hand path is noisy",
    phase: phaseAt("approach"),
    value: metrics.poleCarryControl,
    threshold: 0.5,
    priority: "low",
    cue: "Carry the pole quietly and let the hands rise into the plant instead of bouncing through the run.",
    drill: "Pole runs with the bottom hand steady and the pole tip lowering on the same count each rep.",
    evidence: `Hand-path control score ${percentText(metrics.poleCarryControl)}; the pole itself is only estimated unless marked.`,
    measureNext: "Use the Pole marker on a still frame so future reports can estimate pole angle directly.",
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
    evidence: `Arm extension score ${percentText(metrics.plantArmExtension)} with hand-position score ${percentText(metrics.plantHandPosition)}.`,
    measureNext: "Check whether the top hand is high before the takeoff foot leaves the runway.",
    confidence: confidence.pose,
  });

  addIssue(issues, {
    id: "plant-position",
    title: "Takeoff foot is not matched to the box mark",
    phase: phaseAt("plant-takeoff"),
    value: metrics.plantPosition,
    threshold: 0.58,
    priority: "high",
    cue: "Take off under the top hand with the foot placed consistently relative to the box.",
    drill: "Short-run takeoffs using a takeoff check mark and a plant-box target.",
    evidence: `Plant-position score ${percentText(metrics.plantPosition)} from the foot nearest the runway and the marked box.`,
    measureNext: "Mark the plant box before analysis; without that mark this score is intentionally conservative.",
    confidence: confidence.pose * Math.max(0.35, metrics.calibrationCompleteness),
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
    evidence: `Knee-drive score ${percentText(metrics.takeoffKneeDrive)} at the detected takeoff frame.`,
    measureNext: "Use a side view so the free-knee lift is visible and less affected by camera angle.",
    confidence: confidence.pose,
  });

  addIssue(issues, {
    id: "takeoff-angle",
    title: "Takeoff angle is not clear enough",
    phase: phaseAt("plant-takeoff"),
    value: metrics.takeoffAngleQuality,
    threshold: 0.5,
    priority: "medium",
    cue: "Leave the ground tall and moving upward into the pole instead of running flat through the takeoff.",
    drill: "Pop-up takeoffs with a tall chest and visible upward hip movement after takeoff.",
    evidence: `Estimated takeoff angle ${Number.isFinite(metrics.takeoffAngleDegrees) ? `${metrics.takeoffAngleDegrees} degrees` : "unavailable"}.`,
    measureNext: "Capture a side view and mark runway/box so the app can separate true takeoff angle from perspective.",
    confidence: confidence.pose * metrics.cameraReliability,
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
    evidence: `Trail-leg straightness ${percentText(metrics.trailLegStraightness)} in the swing phase.`,
    measureNext: "Keep the full lower body visible through swing/rockback so the knee and ankle are not lost.",
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
    evidence: `Inversion ${percentText(metrics.inversionQuality)} and hip-rise ${percentText(metrics.hipRise)}.`,
    measureNext: "Measure hip height relative to shoulders at the top of the swing and compare the timing across jumps.",
    confidence: confidence.pose * metrics.cameraReliability,
  });

  addIssue(issues, {
    id: "turn-timing",
    title: "Turn timing or shoulder-hip alignment needs review",
    phase: phaseAt("extension-turn"),
    value: metrics.turnTiming,
    threshold: 0.56,
    priority: "medium",
    cue: "Stay long through extension, then turn after the hips rise instead of twisting early.",
    drill: "High-bar extension-to-turn drills with a controlled delayed turn.",
    evidence: `Turn timing score ${percentText(metrics.turnTiming)} from extension and clearance alignment.`,
    measureNext: "Use a side or slight-oblique angle so shoulder and hip rotation are both visible.",
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
    evidence: `Clearance body-line score ${percentText(metrics.clearanceLine)}.`,
    measureNext: "Mark the crossbar so clearance feedback can reference the actual bar line.",
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
      evidence: `Overall confidence ${percentText(confidence.overall)}; camera reliability ${percentText(metrics.cameraReliability)}.`,
      measureNext: "Prefer a full-body side view, then mark box, runway, bar, and pole for the most useful report.",
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
      evidence: "The available landmarks did not cross any high-priority warning thresholds.",
      measureNext: "Add calibration markers and compare multiple attempts to catch smaller timing changes.",
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

function lerp(a, b, amount) {
  return a + (b - a) * amount;
}

function poseObservations(frame, frameIndex) {
  return (frame.poses ?? [])
    .map((pose, poseIndex) => {
      const landmarks = pose.landmarks ?? pose;
      const box = boundingBox(landmarks);
      const centerPoint = poseCenter(landmarks);
      const confidence = averageConfidence(landmarks, REQUIRED_GROUPS.core);
      return {
        frameIndex,
        poseIndex,
        landmarks,
        center: centerPoint,
        box,
        confidence,
      };
    })
    .filter((observation) => observation.center && observation.confidence >= TRACK_MIN_CORE_CONFIDENCE);
}

function trackMatch(track, observation, frameIndex) {
  const last = track.observations.at(-1);
  if (!last) return null;
  const gap = frameIndex - last.frameIndex;
  if (gap < 1 || gap > TRACK_MAX_GAP) return null;

  const predictedCenter = predictTrackCenter(track, frameIndex);
  const centerDistance = distance2d(observation.center, predictedCenter);
  const speed = distance2d({ x: 0, y: 0 }, track.velocity ?? { x: 0, y: 0 });
  const maxDistance = clamp(0.11 + gap * 0.016 + speed * gap * 0.34, 0.13, gap > 6 ? 0.28 : 0.22);
  const overlap = boxIou(observation.box, last.box);
  const sizeDelta = boxScaleDelta(observation.box, last.box);
  const poseDelta = trackPoseDelta(track, observation);

  if (centerDistance > maxDistance && overlap < 0.04) return null;
  if (sizeDelta > 1.45 && overlap < 0.08 && poseDelta > 0.64) return null;

  return {
    cost:
      centerDistance / maxDistance +
      sizeDelta * 0.2 +
      poseDelta * 0.5 +
      gap * 0.022 -
      overlap * 0.36 -
      observation.confidence * 0.06,
  };
}

function pushTrackObservation(track, observation) {
  const previous = track.observations.at(-1);
  if (previous) {
    const gap = Math.max(1, observation.frameIndex - previous.frameIndex);
    const measuredVelocity = {
      x: (observation.center.x - previous.center.x) / gap,
      y: (observation.center.y - previous.center.y) / gap,
    };
    track.velocity = {
      x: (track.velocity?.x ?? measuredVelocity.x) * 0.58 + measuredVelocity.x * 0.42,
      y: (track.velocity?.y ?? measuredVelocity.y) * 0.58 + measuredVelocity.y * 0.42,
    };
  }
  track.observations.push(observation);
}

function predictTrackCenter(track, frameIndex) {
  const last = track.observations.at(-1);
  if (!last) return null;
  const gap = Math.max(0, frameIndex - last.frameIndex);
  return {
    x: clamp(last.center.x + (track.velocity?.x ?? 0) * gap, -0.2, 1.2),
    y: clamp(last.center.y + (track.velocity?.y ?? 0) * gap, -0.2, 1.2),
  };
}

function trackPoseDelta(track, observation) {
  const candidates = track.observations.slice(-4);
  if (!candidates.length) return 0.65;
  return Math.min(...candidates.map((candidate) => normalizedPoseDelta(observation, candidate)));
}

function normalizedPoseDelta(a, b) {
  const aScale = poseScale(a.box);
  const bScale = poseScale(b.box);
  const scale = Math.max(0.035, (aScale + bScale) / 2);
  const aCenter = a.center ?? bboxCenter(a.box);
  const bCenter = b.center ?? bboxCenter(b.box);
  if (!aCenter || !bCenter) return 0.65;

  const distances = TRACK_POSE_MATCH_LANDMARKS.map((index) => {
    const ap = a.landmarks?.[index];
    const bp = b.landmarks?.[index];
    const confidence = Math.min(pointConfidence(ap), pointConfidence(bp));
    if (confidence < 0.22) return null;
    const ax = (ap.x - aCenter.x) / scale;
    const ay = (ap.y - aCenter.y) / scale;
    const bx = (bp.x - bCenter.x) / scale;
    const by = (bp.y - bCenter.y) / scale;
    return Math.hypot(ax - bx, ay - by);
  }).filter(Number.isFinite);

  if (distances.length < 4) return 0.65;
  const mean = distances.reduce((sum, value) => sum + value, 0) / distances.length;
  return clamp(mean / 1.8, 0, 1.4);
}

function poseScale(box) {
  if (!box) return 0.08;
  return Math.max(box.width ?? 0, box.height ?? 0, Math.sqrt(box.area ?? 0), 0.03);
}

function activeTrackScore(track, totalFrames) {
  const observations = track.observations;
  if (observations.length < 2) return 0;
  const coverage = observations.length / Math.max(1, totalFrames);
  const firstFrame = observations[0].frameIndex;
  const lastFrame = observations.at(-1).frameIndex;
  const span = Math.max(1, lastFrame - firstFrame + 1);
  const spanCoverage = span / Math.max(1, totalFrames);
  const continuity = observations.length / span;
  const stepDistances = observations.slice(1).map((observation, index) => distance2d(observation.center, observations[index].center));
  const path = stepDistances.reduce((sum, value) => sum + value, 0);
  const maxStep = Math.max(0, ...stepDistances);
  const first = observations[0].center;
  const last = observations.at(-1).center;
  const displacement = distance2d(first, last);
  const yValues = observations.map((observation) => observation.center.y);
  const verticalTravel = Math.max(...yValues) - Math.min(...yValues);
  const verticalLift = Math.max(0, first.y - Math.min(...yValues));
  const xValues = observations.map((observation) => observation.center.x);
  const horizontalTravel = Math.max(...xValues) - Math.min(...xValues);
  const meanConfidence =
    observations.reduce((sum, observation) => sum + (observation.confidence ?? 0), 0) / Math.max(1, observations.length);
  const meanArea =
    observations.reduce((sum, observation) => sum + (observation.box?.area ?? 0), 0) / Math.max(1, observations.length);
  const earlyPresence = 1 - Math.min(1, firstFrame / Math.max(1, totalFrames * 0.45));
  const finishPresence = Math.min(1, lastFrame / Math.max(1, totalFrames * 0.65));
  const stationaryPenalty = path < 0.08 && horizontalTravel < 0.05 ? 0.2 : 1;
  const averageStep = path / Math.max(1, stepDistances.length);
  const jumpPenalty = maxStep > 0.24 ? 0.18 : maxStep > 0.16 ? 0.45 : maxStep > 0.1 ? 0.72 : 1;
  const pathShapePenalty = path > displacement * 6 + 1.1 && averageStep > 0.045 ? 0.42 : 1;
  const runwayProgressBonus = horizontalTravel > 0.24 && verticalLift > 0.12 ? 0.35 : horizontalTravel > 0.16 ? 0.16 : 0;
  return (
    (path * 2.2 +
      displacement * 1.6 +
      horizontalTravel * 1.35 +
      verticalTravel * 1.3 +
      verticalLift * 1.15 +
      runwayProgressBonus +
      coverage * 0.42 +
      spanCoverage * 0.52 +
      continuity * 0.34 +
      meanConfidence * 0.18 +
      earlyPresence * 0.08 +
      finishPresence * 0.12 +
      meanArea * 0.03) *
    stationaryPenalty *
    jumpPenalty *
    pathShapePenalty
  );
}

function vaultFocusStartFrame(track, totalFrames) {
  const observations = track.observations;
  if (observations.length < 36 || totalFrames < 60) return 0;
  const xValues = observations.map((observation) => observation.center.x);
  const yValues = observations.map((observation) => observation.center.y);
  const horizontalTravel = Math.max(...xValues) - Math.min(...xValues);
  const verticalLift = observations[0].center.y - Math.min(...yValues);
  if (horizontalTravel < 0.32 || verticalLift < 0.18) return 0;

  const earliest = Math.floor(totalFrames * 0.18);
  const focus = observations.find((observation) => {
    const centerPoint = observation.center;
    return (
      observation.frameIndex >= earliest &&
      centerPoint.x > 0.24 &&
      centerPoint.x < 0.92 &&
      centerPoint.y < 0.58
    );
  });
  return focus?.frameIndex ?? 0;
}

function fillTrackGaps(poseFrames, track, minFrameIndex = 0) {
  const observationsByFrame = new Map(track.observations.map((observation) => [observation.frameIndex, observation]));
  const observations = [...track.observations].sort((a, b) => a.frameIndex - b.frameIndex);
  poseFrames.forEach((frame, frameIndex) => {
    if (frameIndex < minFrameIndex) return;
    const observation = observationsByFrame.get(frameIndex);
    if (observation) {
      return;
    }
    if (!frame.poses.length) return;
    const expected = expectedTrackAtFrame(observations, frameIndex);
    if (!expected) return;
    const fill = closestPoseToExpected(frame, expected);
    if (fill) {
      frame.activePoseIndex = fill.poseIndex;
      frame.poses[fill.poseIndex].trackId = track.id;
    }
  });
}

function expectedTrackAtFrame(observations, frameIndex) {
  const previous = [...observations].reverse().find((observation) => observation.frameIndex < frameIndex);
  const next = observations.find((observation) => observation.frameIndex > frameIndex);

  if (previous && next) {
    const gap = next.frameIndex - previous.frameIndex;
    if (gap > TRACK_MAX_GAP) return null;
    const amount = (frameIndex - previous.frameIndex) / Math.max(1, gap);
    return {
      center: {
        x: lerp(previous.center.x, next.center.x, amount),
        y: lerp(previous.center.y, next.center.y, amount),
      },
      referenceBox: amount < 0.5 ? previous.box : next.box,
      maxDistance: clamp(0.1 + gap * 0.012, 0.12, 0.26),
    };
  }

  if (previous && frameIndex - previous.frameIndex <= 4) {
    return {
      center: predictFromObservationPair(observations, previous, frameIndex),
      referenceBox: previous.box,
      maxDistance: 0.16 + (frameIndex - previous.frameIndex) * 0.025,
    };
  }

  if (next && next.frameIndex - frameIndex <= 4) {
    return {
      center: next.center,
      referenceBox: next.box,
      maxDistance: 0.16 + (next.frameIndex - frameIndex) * 0.025,
    };
  }

  return null;
}

function closestPoseToExpected(frame, expected) {
  let best = null;
  frame.poses.forEach((pose, poseIndex) => {
    const landmarks = pose.landmarks ?? pose;
    const confidence = averageConfidence(landmarks, REQUIRED_GROUPS.core);
    if (confidence < TRACK_MIN_FILL_CONFIDENCE) return;
    const centerPoint = poseCenter(landmarks);
    const box = boundingBox(landmarks);
    const centerDistance = distance2d(centerPoint, expected.center);
    const sizeDelta = boxScaleDelta(box, expected.referenceBox);
    if (centerDistance > expected.maxDistance || sizeDelta > 0.9) return;
    const overlap = boxIou(box, expected.referenceBox);
    const score = centerDistance / expected.maxDistance + sizeDelta * 0.22 - overlap * 0.16 - confidence * 0.04;
    if (!best || score < best.score) best = { poseIndex, score };
  });
  return best;
}

function predictFromObservationPair(observations, previous, frameIndex) {
  const previousIndex = observations.findIndex((observation) => observation === previous);
  const before = observations[previousIndex - 1];
  if (!before) return previous.center;
  const gap = Math.max(1, previous.frameIndex - before.frameIndex);
  const velocity = {
    x: (previous.center.x - before.center.x) / gap,
    y: (previous.center.y - before.center.y) / gap,
  };
  const forward = frameIndex - previous.frameIndex;
  return {
    x: clamp(previous.center.x + velocity.x * forward, -0.2, 1.2),
    y: clamp(previous.center.y + velocity.y * forward, -0.2, 1.2),
  };
}

function boxIou(a, b) {
  if (!a || !b) return 0;
  const left = Math.max(a.minX, b.minX);
  const right = Math.min(a.maxX, b.maxX);
  const top = Math.max(a.minY, b.minY);
  const bottom = Math.min(a.maxY, b.maxY);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const intersection = width * height;
  const union = (a.area ?? 0) + (b.area ?? 0) - intersection;
  return union > 0 ? intersection / union : 0;
}

function boxScaleDelta(a, b) {
  if (!a?.area || !b?.area) return 0.6;
  return Math.min(2, Math.abs(Math.log((a.area + 0.00001) / (b.area + 0.00001))));
}

function summarizePoseTracking(poseFrames = []) {
  const trackMap = new Map();
  let activeTrackId = null;

  poseFrames.forEach((frame, frameIndex) => {
    const activePose = frame.poses?.[frame.activePoseIndex];
    if (Number.isFinite(activePose?.trackId)) activeTrackId = activePose.trackId;
    frame.poses?.forEach((pose) => {
      if (!Number.isFinite(pose.trackId)) return;
      const landmarks = pose.landmarks ?? pose;
      const current =
        trackMap.get(pose.trackId) ?? {
          id: pose.trackId,
          firstFrame: frameIndex,
          lastFrame: frameIndex,
          frames: 0,
          confidenceSum: 0,
        };
      current.firstFrame = Math.min(current.firstFrame, frameIndex);
      current.lastFrame = Math.max(current.lastFrame, frameIndex);
      current.frames += 1;
      current.confidenceSum += averageConfidence(landmarks, REQUIRED_GROUPS.core);
      trackMap.set(pose.trackId, current);
    });
  });

  const tracks = [...trackMap.values()]
    .sort((a, b) => a.id - b.id)
    .map((track) => ({
      id: track.id,
      firstFrame: track.firstFrame,
      lastFrame: track.lastFrame,
      frameCount: track.frames,
      averageConfidence: round(track.confidenceSum / Math.max(1, track.frames), 2),
    }));

  return {
    activeTrackId,
    tracks,
    detectedTrackCount: tracks.length,
  };
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

function nearestFrameIndex(series, time) {
  if (!series.length) return -1;
  let bestIndex = 0;
  let bestDistance = Infinity;
  series.forEach((frame, index) => {
    const distanceFromTime = Math.abs(frame.time - time);
    if (distanceFromTime < bestDistance) {
      bestDistance = distanceFromTime;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function consistencyScore(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 3) return 0.45;
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  if (!mean) return 0.4;
  const variance = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / clean.length;
  return clamp(1 - Math.sqrt(variance) / mean);
}

function lateApproachSpeedScore(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 4) return 0.45;
  const split = Math.max(1, Math.floor(clean.length * 0.55));
  const early = average(clean.slice(0, split));
  const late = average(clean.slice(split));
  if (!early || !late) return 0.45;
  return clamp(0.5 + (late / early - 0.94) * 1.45);
}

function poleCarryControlScore(frames) {
  const wristCenters = frames
    .map((frame) => center(frame.pose.landmarks, LM.leftWrist, LM.rightWrist))
    .filter(Boolean);
  if (wristCenters.length < 4) return 0.45;
  const yValues = wristCenters.map((point) => point.y);
  return consistencyScore(yValues);
}

function armExtensionScore(landmarks) {
  if (!landmarks) return 0;
  const left = angleBetween(landmarks[LM.leftShoulder], landmarks[LM.leftElbow], landmarks[LM.leftWrist]) ?? 0;
  const right = angleBetween(landmarks[LM.rightShoulder], landmarks[LM.rightElbow], landmarks[LM.rightWrist]) ?? 0;
  return clamp(Math.max(left, right) / 180);
}

function plantHandPositionScore(landmarks) {
  if (!landmarks) return 0;
  const shoulder = center(landmarks, LM.leftShoulder, LM.rightShoulder);
  const hip = center(landmarks, LM.leftHip, LM.rightHip);
  const topHandY = Math.min(landmarks[LM.leftWrist]?.y ?? 1, landmarks[LM.rightWrist]?.y ?? 1);
  if (!shoulder || !hip || topHandY >= 1) return 0;
  const torso = Math.max(0.05, distance(shoulder, hip) ?? 0.1);
  return clamp((shoulder.y - topHandY) / torso * 0.72 + armExtensionScore(landmarks) * 0.28);
}

function plantPositionScore(landmarks, calibration = {}) {
  const box = calibration.box?.[0];
  if (!landmarks || !box) return null;
  const feet = [
    landmarks[LM.leftAnkle],
    landmarks[LM.rightAnkle],
    landmarks[LM.leftFootIndex],
    landmarks[LM.rightFootIndex],
    landmarks[LM.leftHeel],
    landmarks[LM.rightHeel],
  ].filter(Boolean);
  if (!feet.length) return null;
  const takeoffFoot = feet.reduce((lowest, point) => (point.y > lowest.y ? point : lowest), feet[0]);
  const bodyBox = boundingBox(landmarks);
  const scale = Math.max(0.04, bodyBox?.height ?? 0.18);
  return clamp(1 - Math.abs(takeoffFoot.x - box.x) / (scale * 0.34));
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

function takeoffAngleDegrees(series, plantIndex) {
  if (plantIndex < 0 || series.length < 3) return null;
  const previous = series[Math.max(0, plantIndex - 2)];
  const next = series[Math.min(series.length - 1, plantIndex + 3)];
  const previousHip = center(previous?.pose.landmarks, LM.leftHip, LM.rightHip);
  const nextHip = center(next?.pose.landmarks, LM.leftHip, LM.rightHip);
  if (!previousHip || !nextHip) return null;
  const dx = Math.abs(nextHip.x - previousHip.x);
  const dyUp = previousHip.y - nextHip.y;
  if (dx < 0.005 && Math.abs(dyUp) < 0.005) return null;
  return (Math.atan2(dyUp, Math.max(0.004, dx)) * 180) / Math.PI;
}

function takeoffAngleScore(angle, cameraReliability = 0.68) {
  if (!Number.isFinite(angle)) return null;
  const ideal = 18;
  const tolerance = 18;
  return clamp(1 - Math.abs(angle - ideal) / tolerance) * cameraReliability;
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

function delayedTurnScore(extensionLandmarks, clearanceLandmarks) {
  const extensionAlignment = shoulderHipAlignment(extensionLandmarks);
  const clearanceLine = bodyLineScore({ pose: { landmarks: clearanceLandmarks } });
  return clamp(extensionAlignment * 0.55 + clearanceLine * 0.45);
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

function calibrationNeeds(calibration) {
  return ["box", "runway", "bar", "pole"].filter((key) => !Array.isArray(calibration[key]) || !calibration[key].length);
}

function buildCoachingBreakdown(metrics, bodyScores, phaseRanges, confidence, cameraAngle, calibration) {
  const phaseAt = (key) => phaseRanges.find((phase) => phase.key === key)?.label ?? key;
  const cameraNote = cameraAngle === "side" ? "side view is strong for this check" : `${cameraAngle} camera angle lowers confidence`;
  const needs = calibrationNeeds(calibration);
  const calibrationCue = needs.length
    ? `Mark ${needs.join(", ")} next time for sharper scoring.`
    : "All manual markers are present, so the report can use calibration context.";

  return [
    breakdownItem({
      id: "approach",
      phase: phaseAt("approach"),
      score: averageFinite([bodyScores.approach, metrics.approachRhythm, metrics.approachAcceleration, metrics.poleCarryControl]),
      focus: "Approach speed and pole carry",
      good: [
        scoreSentence("Approach rhythm", metrics.approachRhythm),
        scoreSentence("Late speed build", metrics.approachAcceleration),
      ],
      watch: [
        scoreSentence("Pole-carry control proxy", metrics.poleCarryControl),
        "The app estimates pole carry from hand path unless the pole line is marked.",
      ],
      measureNext: ["Step consistency over the last three strides.", "Pole angle or hand height as the pole tip drops."],
      confidence: confidence.pose * metrics.cameraReliability,
      cameraNote,
    }),
    breakdownItem({
      id: "plant-takeoff",
      phase: phaseAt("plant-takeoff"),
      score: averageFinite([
        bodyScores.plantTakeoff,
        metrics.plantArmExtension,
        metrics.plantHandPosition,
        metrics.plantPosition,
        metrics.takeoffKneeDrive,
        metrics.takeoffAngleQuality,
      ]),
      focus: "Plant position, hand position, and takeoff angle",
      good: [
        scoreSentence("Top-hand extension", metrics.plantArmExtension),
        scoreSentence("Drive-knee lift", metrics.takeoffKneeDrive),
      ],
      watch: [
        Number.isFinite(metrics.takeoffAngleDegrees)
          ? `Estimated takeoff angle is ${metrics.takeoffAngleDegrees} degrees.`
          : "Takeoff angle needs a clearer side-view hip path.",
        scoreSentence("Foot-to-box match", metrics.plantPosition),
      ],
      measureNext: ["Takeoff foot distance from the box.", "Top hand height before the foot leaves the runway."],
      confidence: confidence.pose * metrics.cameraReliability,
      cameraNote,
    }),
    breakdownItem({
      id: "swing-rockback",
      phase: phaseAt("swing-rockback"),
      score: averageFinite([bodyScores.swingRockback, metrics.trailLegStraightness, metrics.inversionQuality]),
      focus: "Long swing into rockback",
      good: [scoreSentence("Trail-leg length", metrics.trailLegStraightness)],
      watch: [scoreSentence("Inversion entry", metrics.inversionQuality), "A short trail leg usually delays hip rise."],
      measureNext: ["Trail-leg angle at the bottom of the swing.", "Hip path from takeoff through rockback."],
      confidence: confidence.pose,
      cameraNote,
    }),
    breakdownItem({
      id: "extension-turn",
      phase: phaseAt("extension-turn"),
      score: averageFinite([bodyScores.extensionTurn, metrics.hipRise, metrics.shoulderHipAlignment, metrics.turnTiming]),
      focus: "Hip rise, extension, and delayed turn",
      good: [scoreSentence("Hip rise", metrics.hipRise), scoreSentence("Shoulder-hip alignment", metrics.shoulderHipAlignment)],
      watch: [scoreSentence("Turn timing", metrics.turnTiming), "Turn feedback is best treated as a prompt for frame review."],
      measureNext: ["Hip height relative to shoulders at maximum extension.", "Shoulder and hip alignment during the turn."],
      confidence: confidence.pose * metrics.cameraReliability,
      cameraNote,
    }),
    breakdownItem({
      id: "clearance-landing",
      phase: phaseAt("clearance-landing"),
      score: averageFinite([bodyScores.clearanceLanding, metrics.clearanceLine]),
      focus: "Body line over the bar",
      good: [scoreSentence("Clearance body line", metrics.clearanceLine)],
      watch: ["The bar is not automatically detected; manual bar marking makes this phase more specific.", calibrationCue],
      measureNext: ["Shoulder-hip-foot line at bar clearance.", "Actual bar position from a marked crossbar."],
      confidence: confidence.pose * metrics.cameraReliability,
      cameraNote,
    }),
  ];
}

function breakdownItem({ id, phase, score, focus, good, watch, measureNext, confidence, cameraNote }) {
  const safeScore = Number.isFinite(score) ? score : 0;
  return {
    id,
    phase,
    focus,
    score: round(safeScore, 2),
    status: statusForScore(safeScore),
    summary: `${focus}: ${qualityLabel(safeScore)}. ${cameraNote}.`,
    good: good.filter(Boolean),
    watch: watch.filter(Boolean),
    measureNext,
    confidence: round(confidence ?? 0, 2),
  };
}

function buildVaultStyle(metrics = {}, bodyScores = {}, confidence = {}) {
  const candidates = VAULT_STYLE_DEFINITIONS.map((definition) => styleCandidate(definition, metrics, bodyScores)).filter(Boolean);
  const ranked = candidates.sort((a, b) => b.score - a.score);
  const strongest = ranked[0];
  const weakest = ranked.at(-1);
  const styleConfidence = confidence.overall ?? 0;
  const confidenceNote =
    styleConfidence >= 0.72
      ? "Style call is based on a strong body track."
      : styleConfidence >= 0.48
        ? "Style call is useful, but confirm it frame by frame."
        : "Style call is tentative because the clip has limited tracking confidence.";

  if (!strongest) {
    return {
      id: "development-jump",
      label: "Development Jump",
      phaseKey: "overall",
      phaseLabel: "Overall",
      score: 0,
      status: "bad",
      bestPhase: null,
      workPhase: null,
      summary: "The app needs more reliable landmarks before it can name a clear vault style.",
      cues: ["Use a steady full-body side view and keep the vaulter visible from the run through landing."],
      metrics: [],
      styleConfidence: round(styleConfidence, 2),
      confidenceNote,
    };
  }

  const bestPhase = {
    key: strongest.phaseKey,
    label: strongest.phaseLabel,
    score: round(strongest.score, 2),
    status: statusForScore(strongest.score),
  };
  const workPhase = weakest
    ? {
        key: weakest.phaseKey,
        label: weakest.phaseLabel,
        score: round(weakest.score, 2),
        status: statusForScore(weakest.score),
      }
    : null;

  if (styleConfidence < 0.46) {
    return {
      id: "needs-clearer-video",
      label: "Needs Clearer Video",
      phaseKey: strongest.phaseKey,
      phaseLabel: strongest.phaseLabel,
      score: round(strongest.score, 2),
      status: "bad",
      bestPhase,
      workPhase,
      summary: "The app can see some vault shapes, but not enough to call a style cleanly.",
      cues: [
        "Use the current overlay as a frame-review guide only.",
        "Film the full body from a steady side or slight-oblique angle for the next analysis.",
      ],
      metrics: strongest.metrics,
      styleConfidence: round(styleConfidence, 2),
      confidenceNote,
    };
  }

  return {
    id: strongest.id,
    label: strongest.label,
    phaseKey: strongest.phaseKey,
    phaseLabel: strongest.phaseLabel,
    score: round(strongest.score, 2),
    status: statusForScore(strongest.score),
    bestPhase,
    workPhase,
    summary: strongest.summary,
    cues: [
      strongest.cue,
      weakest && weakest.id !== strongest.id ? `Next limiter: ${weakest.phaseLabel} at ${percentText(weakest.score)}.` : null,
    ].filter(Boolean),
    metrics: strongest.metrics,
    styleConfidence: round(styleConfidence, 2),
    confidenceNote,
  };
}

function styleCandidate(definition, metrics, bodyScores) {
  const metricRows = styleMetricRows(definition.phaseKey, metrics, bodyScores);
  const score = averageFinite(metricRows.map((row) => row.score));
  if (!Number.isFinite(score)) return null;
  return {
    ...definition,
    score,
    metrics: metricRows.filter((row) => Number.isFinite(row.score)).slice(0, 4),
  };
}

function styleMetricRows(phaseKey, metrics, bodyScores) {
  if (phaseKey === "approach") {
    return [
      reportMetric("Phase score", bodyScores.approach),
      reportMetric("Rhythm", metrics.approachRhythm),
      reportMetric("Speed build", metrics.approachAcceleration),
      reportMetric("Pole carry", metrics.poleCarryControl),
    ];
  }
  if (phaseKey === "plant-takeoff") {
    return [
      reportMetric("Phase score", bodyScores.plantTakeoff),
      reportMetric("Plant arms", metrics.plantArmExtension),
      reportMetric("Hand height", metrics.plantHandPosition),
      reportMetric("Drive knee", metrics.takeoffKneeDrive),
      reportMetric("Takeoff angle", metrics.takeoffAngleQuality),
    ];
  }
  if (phaseKey === "swing-rockback") {
    return [
      reportMetric("Phase score", bodyScores.swingRockback),
      reportMetric("Trail leg", metrics.trailLegStraightness),
      reportMetric("Inversion entry", metrics.inversionQuality),
    ];
  }
  if (phaseKey === "extension-turn") {
    return [
      reportMetric("Phase score", bodyScores.extensionTurn),
      reportMetric("Hip rise", metrics.hipRise),
      reportMetric("Shoulder/hip line", metrics.shoulderHipAlignment),
      reportMetric("Turn timing", metrics.turnTiming),
    ];
  }
  return [
    reportMetric("Phase score", bodyScores.clearanceLanding),
    reportMetric("Clearance line", metrics.clearanceLine),
  ];
}

function buildVaultReport({
  metrics = {},
  bodyScores = {},
  issues = [],
  coachingBreakdown = [],
  confidence = {},
  overallScore = 0,
  vaultStyle = null,
  cameraAngle = "auto",
} = {}) {
  const primary = primaryReportIssue(issues);
  const drillRows = reportDrills(issues);

  return {
    pattern: "analysis-style-metrics-drills",
    sections: [
      { id: "analysis", label: "Analysis" },
      { id: "style", label: "Style" },
      { id: "metrics", label: "Metrics" },
      { id: "drills", label: "Drills" },
    ],
    analysis: {
      score: overallScore,
      status: statusForScore((overallScore ?? 0) / 100),
      primaryFocus: primary?.title ?? "Frame-by-frame vault review",
      summary: primary?.cue ?? "No major automatic red flags crossed the current scoring thresholds.",
      confidence: round(confidence.overall ?? 0, 2),
      cameraAngle,
      strengths: reportStrengths(bodyScores, coachingBreakdown).slice(0, 3),
    },
    style: vaultStyle,
    metrics: reportMetrics(metrics, bodyScores),
    drills: drillRows.length ? drillRows : reportFallbackDrills(primary),
  };
}

function primaryReportIssue(issues = []) {
  return (
    issues.find((issue) => issue.priority === "high" && issue.status !== "positive") ??
    issues.find((issue) => issue.status === "needs-work") ??
    issues.find((issue) => issue.status === "warning") ??
    issues[0] ??
    null
  );
}

function reportStrengths(bodyScores = {}, coachingBreakdown = []) {
  const phaseStrengths = coachingBreakdown
    .filter((item) => Number.isFinite(item.score))
    .map((item) => ({
      label: item.phase,
      detail: item.focus,
      score: item.score,
      status: statusForScore(item.score),
      display: percentText(item.score),
    }));
  const bodyStrengths = [
    ["Upper body", bodyScores.upperBody],
    ["Lower body", bodyScores.lowerBody],
    ["Core line", bodyScores.coreLine],
    ["Vault timing", bodyScores.vaultTiming],
  ]
    .filter(([, value]) => Number.isFinite(value))
    .map(([label, value]) => ({
      label,
      detail: `${label} score`,
      score: value,
      status: statusForScore(value),
      display: percentText(value),
    }));

  return [...phaseStrengths, ...bodyStrengths].sort((a, b) => b.score - a.score);
}

function reportMetrics(metrics = {}, bodyScores = {}) {
  return [
    reportMetric("Approach rhythm", metrics.approachRhythm, "Approach"),
    reportMetric("Speed build", metrics.approachAcceleration, "Approach"),
    reportMetric("Plant arms", metrics.plantArmExtension, "Plant"),
    reportMetric("Hand height", metrics.plantHandPosition, "Plant"),
    reportMetric("Drive knee", metrics.takeoffKneeDrive, "Takeoff"),
    reportMetric(
      "Takeoff angle",
      metrics.takeoffAngleQuality,
      "Takeoff",
      Number.isFinite(metrics.takeoffAngleDegrees) ? `${metrics.takeoffAngleDegrees} deg` : null,
    ),
    reportMetric("Trail leg", metrics.trailLegStraightness, "Swing"),
    reportMetric("Inversion", metrics.inversionQuality, "Rockback"),
    reportMetric("Hip rise", metrics.hipRise, "Extension"),
    reportMetric("Turn timing", metrics.turnTiming, "Turn"),
    reportMetric("Clearance line", metrics.clearanceLine, "Clearance"),
    reportMetric("Overall timing", bodyScores.vaultTiming, "Overall"),
  ].filter((row) => row.display);
}

function reportMetric(label, score, phase = "", display = null) {
  return {
    label,
    phase,
    score: round(score, 2),
    display: display ?? percentText(score),
    status: Number.isFinite(score) ? statusForScore(score) : "bad",
  };
}

function reportDrills(issues = []) {
  return issues
    .filter((issue) => issue.status !== "positive" && issue.id !== "confidence-warning")
    .slice(0, 4)
    .map((issue) => ({
      title: issue.title,
      phase: issue.phase,
      cue: issue.cue,
      drill: issue.drill,
      priority: issue.priority,
      status: priorityStatus(issue.priority),
      confidence: issue.confidence,
    }));
}

function reportFallbackDrills(primary) {
  if (!primary) return [];
  return [
    {
      title: primary.title,
      phase: primary.phase,
      cue: primary.cue,
      drill: primary.drill,
      priority: primary.priority,
      status: priorityStatus(primary.priority),
      confidence: primary.confidence,
    },
  ];
}

function priorityStatus(priority) {
  if (priority === "high") return "bad";
  if (priority === "medium") return "okay";
  return "good";
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function averageFinite(values) {
  return average(values);
}

function scoreSentence(label, value) {
  if (!Number.isFinite(value)) return `${label}: not enough data yet.`;
  return `${label}: ${percentText(value)} (${qualityLabel(value)}).`;
}

function qualityLabel(score) {
  if (score >= 0.72) return "strong";
  if (score >= 0.52) return "workable";
  return "needs attention";
}

function percentText(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "not measured";
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
    evidence: issue.evidence,
    measureNext: issue.measureNext,
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

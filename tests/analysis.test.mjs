import assert from "node:assert/strict";
import {
  analyzeVault,
  assignActivePoseTrack,
  detectPhases,
  prioritizeIssues,
  scoreIssues,
  selectActivePose,
} from "../src/analysis.js";
import { LM } from "../src/landmarks.js";
import { loadLocalSessions, saveLocalSession } from "../src/local-library.js";
import { angleBetween } from "../src/math.js";

function landmark(x, y, visibility = 0.95) {
  return { x, y, z: 0, visibility };
}

function makePose({
  x = 0.5,
  hipY = 0.62,
  shoulderY = 0.42,
  wristY = 0.24,
  ankleY = 0.84,
  bentArms = false,
  kneeDrive = 0.18,
  scale = 1,
  visibility = 0.95,
} = {}) {
  const l = Array.from({ length: 33 }, () => landmark(x, hipY, visibility));
  const half = 0.035 * scale;
  l[LM.leftHip] = landmark(x - half, hipY, visibility);
  l[LM.rightHip] = landmark(x + half, hipY, visibility);
  l[LM.leftShoulder] = landmark(x - half, shoulderY, visibility);
  l[LM.rightShoulder] = landmark(x + half, shoulderY, visibility);

  l[LM.leftKnee] = landmark(x - half * 1.2, hipY - kneeDrive, visibility);
  l[LM.rightKnee] = landmark(x + half * 1.2, hipY + 0.1, visibility);
  l[LM.leftAnkle] = landmark(x - half * 1.4, ankleY, visibility);
  l[LM.rightAnkle] = landmark(x + half * 1.4, ankleY + 0.01, visibility);
  l[LM.leftFootIndex] = landmark(x - half * 1.8, ankleY + 0.03, visibility);
  l[LM.rightFootIndex] = landmark(x + half * 1.8, ankleY + 0.03, visibility);
  l[LM.leftHeel] = landmark(x - half * 1.5, ankleY + 0.02, visibility);
  l[LM.rightHeel] = landmark(x + half * 1.5, ankleY + 0.02, visibility);

  if (bentArms) {
    l[LM.leftElbow] = landmark(x - 0.1 * scale, shoulderY - 0.02, visibility);
    l[LM.leftWrist] = landmark(x - 0.03 * scale, wristY, visibility);
    l[LM.rightElbow] = landmark(x + 0.1 * scale, shoulderY - 0.02, visibility);
    l[LM.rightWrist] = landmark(x + 0.03 * scale, wristY, visibility);
  } else {
    l[LM.leftElbow] = landmark(x - half * 1.4, (shoulderY + wristY) / 2, visibility);
    l[LM.leftWrist] = landmark(x - half * 1.6, wristY, visibility);
    l[LM.rightElbow] = landmark(x + half * 1.4, (shoulderY + wristY) / 2, visibility);
    l[LM.rightWrist] = landmark(x + half * 1.6, wristY, visibility);
  }

  l[LM.leftEar] = landmark(x - half, shoulderY - 0.08, visibility);
  l[LM.rightEar] = landmark(x + half, shoulderY - 0.08, visibility);
  return l;
}

function makeFrames() {
  return Array.from({ length: 80 }, (_, index) => {
    const t = index / 10;
    const progress = index / 79;
    const isPlant = index > 28 && index < 38;
    const isSwing = index >= 38 && index < 56;
    const isExtension = index >= 56;
    return {
      time: t,
      poses: [
        {
          landmarks: makePose({
            x: 0.2 + progress * 0.55,
            hipY: isExtension ? 0.26 : isSwing ? 0.43 : 0.62 - Math.max(0, progress - 0.35) * 0.16,
            shoulderY: isExtension ? 0.43 : 0.42,
            wristY: isPlant ? 0.16 : 0.27,
            ankleY: isSwing || isExtension ? 0.24 : 0.84,
            bentArms: isPlant,
            kneeDrive: isPlant ? 0.02 : 0.16,
          }),
        },
      ],
    };
  });
}

assert.equal(Math.round(angleBetween({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })), 90);

const activeIndex = selectActivePose([
  { landmarks: makePose({ scale: 0.45, visibility: 0.7 }) },
  { landmarks: makePose({ scale: 1.1, visibility: 0.95 }) },
]);
assert.equal(activeIndex, 1);

const trackingFrames = Array.from({ length: 20 }, (_, index) => ({
  time: index / 10,
  activePoseIndex: -1,
  poses: [
    { landmarks: makePose({ x: 0.52, scale: 1.45, visibility: 0.96 }) },
    { landmarks: makePose({ x: 0.1 + index * 0.028, scale: 0.55, visibility: 0.9 }) },
  ],
}));
assignActivePoseTrack(trackingFrames);
assert.ok(
  trackingFrames.filter((frame) => frame.activePoseIndex === 1).length > 14,
  "moving vaulter track should beat stationary foreground subject",
);

const frames = makeFrames();
const activeSeries = frames.map((frame) => ({ time: frame.time, pose: frame.poses[0] }));
const phases = detectPhases(activeSeries, 8);
assert.equal(phases.length, 5);
for (let index = 1; index < phases.length; index += 1) {
  assert.ok(phases[index].startTime >= phases[index - 1].startTime, "phase starts should be ordered");
}

const analysis = analyzeVault({
  frames,
  cameraAngle: "side",
  calibration: { box: [{ x: 0.8, y: 0.78 }], runway: [{ x: 0.1, y: 0.82 }, { x: 0.9, y: 0.78 }] },
  videoMeta: { fileName: "fixture.mp4", duration: 8, width: 1280, height: 720, sampleRate: 10 },
});
assert.equal(analysis.schemaVersion, "vault-vision.analysis.v1");
assert.ok(analysis.poseFrames.length > 50);
assert.ok(analysis.poseFrames.every((frame) => frame.form && ["good", "okay", "bad"].includes(frame.form.status)));
assert.ok(Number.isInteger(analysis.overallScore));
assert.ok(Number.isFinite(analysis.bodyScores.upperBody));
assert.ok(analysis.phaseRanges.every((phase) => Number.isFinite(phase.startTime)));
assert.ok(analysis.issues.some((issue) => issue.id === "plant-extension" || issue.id === "knee-drive"));
assert.equal(analysis.coachingBreakdown.length, 5);
assert.ok(analysis.coachingBreakdown.some((item) => item.id === "plant-takeoff" && item.measureNext.length));
assert.ok(analysis.researchBasis.some((item) => item.appliedTo.includes("takeoff angle")));
assert.ok(Number.isFinite(analysis.metrics.takeoffAngleQuality) || analysis.metrics.takeoffAngleQuality === null);

const prioritized = prioritizeIssues(
  scoreIssues(
    {
      approachRhythm: 0.4,
      plantArmExtension: 0.3,
      takeoffKneeDrive: 0.4,
      trailLegStraightness: 0.4,
      inversionQuality: 0.2,
      hipRise: 0.2,
      clearanceLine: 0.4,
      cameraReliability: 0.9,
    },
    phases,
    { overall: 0.8, pose: 0.9 },
    "side",
  ),
);
assert.equal(prioritized[0].priority, "high");

const lowConfidence = analyzeVault({
  frames: frames.slice(0, 10).map((frame) => ({
    ...frame,
    poses: [{ landmarks: makePose({ visibility: 0.15 }) }],
  })),
  cameraAngle: "front",
  videoMeta: { fileName: "low-confidence.mp4", duration: 1 },
});
assert.ok(lowConfidence.issues.some((issue) => issue.id === "confidence-warning"));

function mockStorage() {
  const rows = new Map();
  return {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => rows.set(key, value),
    removeItem: (key) => rows.delete(key),
  };
}

const storage = mockStorage();
const localSession = saveLocalSession(
  {
    analysis,
    athleteName: "Test Vaulter",
    sessionTitle: "Free browser save",
    cameraAngle: "side",
    calibration: { box: [{ x: 0.8, y: 0.78 }] },
  },
  storage,
);
const localSessions = loadLocalSessions(storage);
assert.equal(localSessions.length, 1);
assert.equal(localSessions[0].id, localSession.id);
assert.equal(localSessions[0].athletes.display_name, "Test Vaulter");
assert.equal(localSessions[0].analyses[0].result.poseFrames.length, 0);
assert.equal(localSessions[0].analyses[0].result.localFramesOmitted, true);

console.log("analysis tests passed");

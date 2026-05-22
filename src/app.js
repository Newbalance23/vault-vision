import { overrideAnalysisActiveTrack } from "./analysis.js?v=2026-05-22-esp-tracking";
import { analyzeVideoWithPose, detectVideoFrame } from "./pose-service.js?v=2026-05-22-esp-tracking";
import { canvasPointToVideoPoint, drawOverlay } from "./renderer.js?v=2026-05-22-esp-tracking";
import { createVaultCloud, loadSupabaseConfig, saveSupabaseConfig } from "./supabase-service.js?v=2026-05-22-esp-tracking";
import { loadLocalSessions, saveLocalSession } from "./local-library.js?v=2026-05-22-esp-tracking";
import { DEFAULT_SUPABASE_CONFIG } from "./config.js?v=2026-05-22-esp-tracking";

const elements = {
  appShell: document.querySelector(".app-shell"),
  entryGate: document.querySelector("#entryGate"),
  entryEmailInput: document.querySelector("#entryEmailInput"),
  entryPasswordInput: document.querySelector("#entryPasswordInput"),
  entrySignInButton: document.querySelector("#entrySignInButton"),
  entrySignUpButton: document.querySelector("#entrySignUpButton"),
  guestEntryButton: document.querySelector("#guestEntryButton"),
  entryMessage: document.querySelector("#entryMessage"),
  cloudStatus: document.querySelector("#cloudStatus"),
  refreshLibraryButton: document.querySelector("#refreshLibraryButton"),
  signOutButton: document.querySelector("#signOutButton"),
  supabaseUrlInput: document.querySelector("#supabaseUrlInput"),
  supabaseAnonInput: document.querySelector("#supabaseAnonInput"),
  saveConfigButton: document.querySelector("#saveConfigButton"),
  authControls: document.querySelector("#authControls"),
  emailInput: document.querySelector("#emailInput"),
  passwordInput: document.querySelector("#passwordInput"),
  signInButton: document.querySelector("#signInButton"),
  signUpButton: document.querySelector("#signUpButton"),
  setupMessage: document.querySelector("#setupMessage"),
  videoInput: document.querySelector("#videoInput"),
  runAnalysisButton: document.querySelector("#runAnalysisButton"),
  vaultVideo: document.querySelector("#vaultVideo"),
  overlayCanvas: document.querySelector("#overlayCanvas"),
  videoPlayButton: document.querySelector("#videoPlayButton"),
  emptyVideoState: document.querySelector("#emptyVideoState"),
  emptyVideoMessage: document.querySelector("#emptyVideoState p"),
  sessionSnapshot: document.querySelector("#sessionSnapshot"),
  phaseTimeline: document.querySelector("#phaseTimeline"),
  phaseLegend: document.querySelector("#phaseLegend"),
  timeSlider: document.querySelector("#timeSlider"),
  timeReadout: document.querySelector("#timeReadout"),
  liveFormStrip: document.querySelector("#liveFormStrip"),
  liveStatusDot: document.querySelector("#liveStatusDot"),
  liveStatusLabel: document.querySelector("#liveStatusLabel"),
  livePhaseLabel: document.querySelector("#livePhaseLabel"),
  liveScoreLabel: document.querySelector("#liveScoreLabel"),
  athleteNameInput: document.querySelector("#athleteNameInput"),
  sessionTitleInput: document.querySelector("#sessionTitleInput"),
  cameraAngleSelect: document.querySelector("#cameraAngleSelect"),
  modelVariantSelect: document.querySelector("#modelVariantSelect"),
  sampleRateSelect: document.querySelector("#sampleRateSelect"),
  calibrationMessage: document.querySelector("#calibrationMessage"),
  clearCalibrationButton: document.querySelector("#clearCalibrationButton"),
  saveAnalysisButton: document.querySelector("#saveAnalysisButton"),
  exportJsonButton: document.querySelector("#exportJsonButton"),
  progressBlock: document.querySelector("#progressBlock"),
  progressBar: document.querySelector("#progressBar"),
  progressText: document.querySelector("#progressText"),
  confidenceBadge: document.querySelector("#confidenceBadge"),
  scoreSummary: document.querySelector("#scoreSummary"),
  vaultReport: document.querySelector("#vaultReport"),
  actionPlan: document.querySelector("#actionPlan"),
  technicalBreakdown: document.querySelector("#technicalBreakdown"),
  issuesList: document.querySelector("#issuesList"),
  metricsGrid: document.querySelector("#metricsGrid"),
  libraryList: document.querySelector("#libraryList"),
};

const state = {
  cloud: null,
  session: null,
  config: loadSupabaseConfig() ?? defaultConfig(),
  file: null,
  sourceName: "",
  sourceKind: "",
  objectUrl: null,
  analysis: null,
  autoAnalysis: null,
  followTrackId: null,
  livePreview: null,
  liveDetecting: false,
  liveReady: false,
  lastLiveDetectionAt: 0,
  calibration: {},
  activeTool: null,
  library: [],
  localLibrary: loadLocalSessions(),
  entryDismissed: sessionStorage.getItem("vaultVisionEntry") === "guest",
};

init();

async function init() {
  bindEvents();
  hydrateConfig();
  await initCloud();
  loadVideoFromQuery();
  renderEntryGate();
  renderAll();
  requestAnimationFrame(syncOverlay);
  window.lucide?.createIcons();
}

function bindEvents() {
  elements.entrySignInButton.addEventListener("click", () => handleEntryAuth("signIn"));
  elements.entrySignUpButton.addEventListener("click", () => handleEntryAuth("signUp"));
  elements.guestEntryButton.addEventListener("click", enterGuestMode);
  elements.saveConfigButton.addEventListener("click", handleSaveConfig);
  elements.signInButton.addEventListener("click", () => handleAuth("signIn"));
  elements.signUpButton.addEventListener("click", () => handleAuth("signUp"));
  elements.signOutButton.addEventListener("click", handleSignOut);
  elements.refreshLibraryButton.addEventListener("click", refreshLibrary);
  elements.videoInput.addEventListener("change", handleVideoSelected);
  elements.runAnalysisButton.addEventListener("click", runAnalysis);
  elements.videoPlayButton.addEventListener("click", toggleVideoPlayback);
  elements.vaultVideo.addEventListener("loadedmetadata", handleVideoMetadata);
  elements.vaultVideo.addEventListener("play", () => {
    state.liveReady = true;
    updateVideoPlayButton();
    scheduleLivePreview();
  });
  elements.vaultVideo.addEventListener("pause", updateVideoPlayButton);
  elements.vaultVideo.addEventListener("ended", updateVideoPlayButton);
  elements.vaultVideo.addEventListener("timeupdate", handleTimeUpdate);
  elements.timeSlider.addEventListener("input", handleSliderInput);
  elements.overlayCanvas.addEventListener("click", handleCanvasClick);
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => setActiveTool(button.dataset.tool));
  });
  elements.clearCalibrationButton.addEventListener("click", () => {
    state.calibration = {};
    state.followTrackId = null;
    if (state.autoAnalysis) state.analysis = state.autoAnalysis;
    elements.calibrationMessage.textContent = "Markers and follow lock cleared.";
    renderResults();
    updateLiveForm();
    drawCurrentOverlay();
  });
  elements.saveAnalysisButton.addEventListener("click", saveAnalysis);
  elements.exportJsonButton.addEventListener("click", exportJson);
  window.addEventListener("resize", drawCurrentOverlay);
}

function hydrateConfig() {
  if (!state.config) return;
  elements.supabaseUrlInput.value = state.config.url ?? "";
  elements.supabaseAnonInput.value = state.config.anonKey ?? "";
}

async function handleEntryAuth(mode) {
  if (!state.cloud) {
    setEntryMessage("Cloud sign in is not configured yet. Use No sign in use to analyze videos now.", true);
    return;
  }
  elements.emailInput.value = elements.entryEmailInput.value.trim();
  elements.passwordInput.value = elements.entryPasswordInput.value;
  await handleAuth(mode, { fromEntry: true });
}

function enterGuestMode() {
  state.entryDismissed = true;
  sessionStorage.setItem("vaultVisionEntry", "guest");
  setEntryMessage("Guest mode ready. Load a clip to analyze.");
  renderEntryGate();
}

function renderEntryGate() {
  const shouldShow = !state.entryDismissed && !state.session?.user;
  elements.entryGate.classList.toggle("hidden", !shouldShow);
  elements.appShell.setAttribute("aria-hidden", String(shouldShow));
}

async function initCloud() {
  if (!state.config?.url || !state.config?.anonKey) {
    setCloudStatus("Cloud not configured", "muted");
    return;
  }
  try {
    state.cloud = await createVaultCloud(state.config);
    state.session = await state.cloud.getSession();
    state.cloud.onAuthStateChange((session) => {
      state.session = session;
      if (session?.user) state.entryDismissed = true;
      renderEntryGate();
      renderAuthState();
      refreshLibrary();
    });
    renderAuthState();
    if (state.session) await refreshLibrary();
  } catch (error) {
    setSetupMessage(error.message, true);
    setCloudStatus("Cloud config error", "bad");
  }
}

async function handleSaveConfig() {
  const url = elements.supabaseUrlInput.value.trim();
  const anonKey = elements.supabaseAnonInput.value.trim();
  if (!url || !anonKey) {
    setSetupMessage("Add a Supabase project URL and anon key.", true);
    return;
  }
  saveSupabaseConfig({ url, anonKey });
  state.config = { url, anonKey };
  state.cloud = null;
  state.session = null;
  setSetupMessage("Supabase project saved.");
  await initCloud();
  renderAll();
}

async function handleAuth(mode, options = {}) {
  if (!state.cloud) {
    setSetupMessage("Connect a Supabase project first.", true);
    return;
  }
  const email = elements.emailInput.value.trim();
  const password = elements.passwordInput.value;
  if (!email || !password) {
    setSetupMessage("Email and password are required.", true);
    return;
  }
  try {
    state.session = mode === "signIn" ? await state.cloud.signIn(email, password) : await state.cloud.signUp(email, password);
    setSetupMessage(mode === "signIn" ? "Signed in." : "Account created. Check email confirmation if required.");
    if (options.fromEntry) {
      state.entryDismissed = true;
      sessionStorage.setItem("vaultVisionEntry", "signed-in");
      setEntryMessage(mode === "signIn" ? "Signed in." : "Account created.");
      renderEntryGate();
    }
    await refreshLibrary();
    renderAll();
  } catch (error) {
    setSetupMessage(error.message, true);
    if (options.fromEntry) setEntryMessage(error.message, true);
  }
}

async function handleSignOut() {
  try {
    await state.cloud?.signOut();
    state.session = null;
    state.library = [];
    state.entryDismissed = false;
    sessionStorage.removeItem("vaultVisionEntry");
    renderEntryGate();
    renderAll();
  } catch (error) {
    setSetupMessage(error.message, true);
  }
}

function handleVideoSelected(event) {
  const [file] = event.target.files ?? [];
  if (!file) return;
  loadVideoSource({
    url: URL.createObjectURL(file),
    name: file.name,
    kind: "file",
    file,
    objectUrl: true,
  });
}

function handleVideoMetadata() {
  state.liveReady = true;
  elements.timeSlider.max = String(elements.vaultVideo.duration || 0);
  elements.timeSlider.disabled = false;
  updateTimeReadout();
  updateLiveForm();
  updateVideoPlayButton();
  drawCurrentOverlay();
}

function handleTimeUpdate() {
  if (!elements.timeSlider.matches(":active")) {
    elements.timeSlider.value = String(elements.vaultVideo.currentTime || 0);
  }
  updateTimeReadout();
  drawCurrentOverlay();
}

function handleSliderInput() {
  elements.vaultVideo.currentTime = Number(elements.timeSlider.value);
  updateTimeReadout();
  updateLiveForm();
}

async function toggleVideoPlayback() {
  if (!state.sourceName) return;
  try {
    if (elements.vaultVideo.paused || elements.vaultVideo.ended) {
      await elements.vaultVideo.play();
    } else {
      elements.vaultVideo.pause();
    }
    updateVideoPlayButton();
  } catch (error) {
    setProgressMessage(`Unable to play video: ${error.message}`, true);
  }
}

async function runAnalysis() {
  if (!state.file && !state.sourceName) {
    setProgressMessage("Load a video before running analysis.", true);
    return;
  }
  elements.runAnalysisButton.disabled = true;
  elements.saveAnalysisButton.disabled = true;
  elements.exportJsonButton.disabled = true;
  setProgress(0.02, "Preparing video...");
  try {
    const analysis = await analyzeVideoWithPose(elements.vaultVideo, {
      fileName: state.file?.name ?? state.sourceName,
      sampleRate: Number(elements.sampleRateSelect.value),
      modelVariant: elements.modelVariantSelect.value,
      cameraAngle: elements.cameraAngleSelect.value,
      calibration: state.calibration,
      onProgress: ({ progress, message }) => setProgress(progress, message),
    });
    state.autoAnalysis = analysis;
    state.analysis = analysis;
    state.followTrackId = null;
    elements.saveAnalysisButton.disabled = false;
    elements.exportJsonButton.disabled = false;
    renderResults();
    updateLiveForm();
    drawCurrentOverlay();
  } catch (error) {
    setProgressMessage(error.message, true);
  } finally {
    elements.runAnalysisButton.disabled = false;
    setTimeout(() => elements.progressBlock.classList.add("hidden"), 1600);
  }
}

function handleCanvasClick(event) {
  const point = canvasPointToVideoPoint(elements.overlayCanvas, elements.vaultVideo, event.clientX, event.clientY);
  if (!point) {
    elements.calibrationMessage.textContent = "Click inside the visible video frame.";
    return;
  }
  if (state.activeTool === "vaulter" || (!state.activeTool && state.analysis)) {
    selectVaulterAtPoint(point);
    return;
  }
  if (!state.activeTool) return;

  const current = state.calibration[state.activeTool] ?? [];
  const next = state.activeTool === "box" ? [point] : current.length >= 2 ? [point] : [...current, point];
  state.calibration = { ...state.calibration, [state.activeTool]: next };
  elements.calibrationMessage.textContent = markerMessage(state.activeTool, next.length);
  drawCurrentOverlay();
}

function setActiveTool(tool) {
  state.activeTool = state.activeTool === tool ? null : tool;
  elements.overlayCanvas.classList.toggle("is-calibrating", Boolean(state.activeTool));
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tool === state.activeTool);
  });
  elements.calibrationMessage.textContent =
    state.activeTool === "vaulter"
      ? "Click the vaulter skeleton to follow."
      : state.activeTool
        ? `Mark ${state.activeTool}; click the video frame.`
        : "Use Vaulter to choose who to follow, or mark box/runway/bar/pole.";
}

function selectVaulterAtPoint(point) {
  if (!state.analysis?.poseFrames?.length) {
    elements.calibrationMessage.textContent = "Run analysis first, then click the vaulter to follow.";
    return;
  }
  const frame = nearestPoseFrame(state.analysis.poseFrames, elements.vaultVideo.currentTime || 0);
  const match = findPoseAtPoint(frame, point);
  if (!match || !Number.isFinite(match.pose.trackId)) {
    elements.calibrationMessage.textContent = "No tracked vaulter found at that spot.";
    return;
  }

  const baseAnalysis = state.autoAnalysis ?? state.analysis;
  const updated = overrideAnalysisActiveTrack(baseAnalysis, match.pose.trackId);
  if (!updated || updated === baseAnalysis) {
    elements.calibrationMessage.textContent = "That track could not be followed across the jump.";
    return;
  }

  state.followTrackId = match.pose.trackId;
  state.analysis = updated;
  elements.calibrationMessage.textContent = "Following selected vaulter. Click another skeleton to switch.";
  renderResults();
  updateLiveForm();
  drawCurrentOverlay();
}

function findPoseAtPoint(frame, point) {
  if (!frame?.poses?.length) return null;
  const candidates = frame.poses
    .map((pose, poseIndex) => {
      const box = poseBox(pose.landmarks);
      if (!box) return null;
      const padded = {
        minX: box.minX - 0.04,
        minY: box.minY - 0.06,
        maxX: box.maxX + 0.04,
        maxY: box.maxY + 0.06,
      };
      const inside = point.x >= padded.minX && point.x <= padded.maxX && point.y >= padded.minY && point.y <= padded.maxY;
      const centerDistance = Math.hypot(point.x - (box.minX + box.maxX) / 2, point.y - (box.minY + box.maxY) / 2);
      const landmarkDistance = nearestLandmarkDistance(pose.landmarks, point);
      const score = (inside ? 0 : 0.35) + Math.min(centerDistance, 0.6) + Math.min(landmarkDistance, 0.6) * 0.8;
      return { pose, poseIndex, score };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);
  return candidates[0]?.score < 0.48 ? candidates[0] : null;
}

function poseBox(landmarks = []) {
  const valid = landmarks.filter((point) => (point.visibility ?? 1) > 0.22);
  if (!valid.length) return null;
  const xs = valid.map((point) => point.x);
  const ys = valid.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function nearestLandmarkDistance(landmarks = [], point) {
  return landmarks.reduce((best, landmark) => {
    if ((landmark.visibility ?? 1) < 0.3) return best;
    return Math.min(best, Math.hypot(point.x - landmark.x, point.y - landmark.y));
  }, Infinity);
}

async function saveAnalysis() {
  if (!state.analysis) return;
  if (!state.session || !state.cloud || !state.file) {
    saveAnalysisLocally();
    return;
  }
  try {
    elements.saveAnalysisButton.disabled = true;
    setProgress(0.12, "Uploading video and analysis...");
    await state.cloud.saveVaultSession({
      file: state.file,
      analysis: state.analysis,
      athleteName: elements.athleteNameInput.value,
      sessionTitle: elements.sessionTitleInput.value,
      cameraAngle: elements.cameraAngleSelect.value,
      calibration: state.calibration,
    });
    setProgress(1, "Saved to cloud library.");
    await refreshLibrary();
  } catch (error) {
    setProgressMessage(error.message, true);
  } finally {
    elements.saveAnalysisButton.disabled = false;
    setTimeout(() => elements.progressBlock.classList.add("hidden"), 1800);
  }
}

function saveAnalysisLocally() {
  try {
    elements.saveAnalysisButton.disabled = true;
    const saved = saveLocalSession({
      analysis: state.analysis,
      athleteName: elements.athleteNameInput.value,
      sessionTitle: elements.sessionTitleInput.value,
      cameraAngle: elements.cameraAngleSelect.value,
      calibration: state.calibration,
    });
    state.localLibrary = loadLocalSessions();
    setProgress(1, `Saved "${saved.title}" to this browser.`);
    renderLibrary();
  } catch (error) {
    setProgressMessage(error.message, true);
  } finally {
    elements.saveAnalysisButton.disabled = false;
    setTimeout(() => elements.progressBlock.classList.add("hidden"), 1800);
  }
}

function exportJson() {
  if (!state.analysis) return;
  const blob = new Blob([JSON.stringify(state.analysis, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.analysis.videoMeta.fileName.replace(/\.[^.]+$/, "")}-analysis.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function refreshLibrary() {
  state.localLibrary = loadLocalSessions();
  if (!state.cloud || !state.session) {
    state.library = [];
    renderLibrary();
    return;
  }
  try {
    state.library = await state.cloud.listSessions();
    renderLibrary();
  } catch (error) {
    elements.libraryList.innerHTML = `<p class="empty-copy">${escapeHtml(error.message)}</p>`;
  }
}

async function loadLibraryItem(item) {
  if (item.local) {
    loadLocalLibraryItem(item);
    return;
  }
  const analysis = latest(item.analyses)?.result;
  const video = latest(item.videos);
  if (!analysis || !video?.storage_path) return;
  try {
    const signedUrl = await state.cloud.signedVideoUrl(video.storage_path);
    state.file = null;
    state.sourceName = video.file_name ?? "saved-video";
    state.sourceKind = "cloud";
    state.analysis = analysis;
    state.autoAnalysis = analysis;
    state.followTrackId = analysis.selectedTrackId ?? null;
    state.calibration = analysis.calibration ?? {};
    elements.vaultVideo.src = signedUrl;
    elements.vaultVideo.load();
    elements.emptyVideoState.classList.add("hidden");
    elements.sessionTitleInput.value = item.title ?? "";
    elements.athleteNameInput.value = item.athletes?.display_name ?? "";
    elements.cameraAngleSelect.value = analysis.cameraAngle ?? "auto";
    elements.saveAnalysisButton.disabled = true;
    elements.exportJsonButton.disabled = false;
    elements.saveAnalysisButton.disabled = true;
    renderResults();
    updateLiveForm();
    drawCurrentOverlay();
  } catch (error) {
    setSetupMessage(error.message, true);
  }
}

function loadLocalLibraryItem(item) {
  const analysis = latest(item.analyses)?.result;
  const video = latest(item.videos);
  if (!analysis) return;
  state.file = null;
  state.sourceName = video?.file_name ?? "saved-report";
  state.sourceKind = "local";
  state.analysis = analysis;
  state.autoAnalysis = analysis;
  state.followTrackId = analysis.selectedTrackId ?? null;
  state.livePreview = null;
  state.calibration = analysis.calibration ?? item.calibration ?? {};
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null;
  elements.vaultVideo.removeAttribute("src");
  elements.vaultVideo.load();
  updateVideoPlayButton();
  elements.emptyVideoMessage.textContent = "Saved report loaded. Load the original clip to review the overlay again.";
  elements.emptyVideoState.classList.remove("hidden");
  elements.sessionTitleInput.value = item.title ?? "";
  elements.athleteNameInput.value = item.athletes?.display_name ?? "";
  elements.cameraAngleSelect.value = analysis.cameraAngle ?? item.camera_angle ?? "auto";
  elements.runAnalysisButton.disabled = true;
  elements.saveAnalysisButton.disabled = true;
  elements.exportJsonButton.disabled = false;
  renderResults();
  updateLiveForm();
  drawCurrentOverlay();
}

function renderAll() {
  renderAuthState();
  renderSessionSnapshot();
  renderResults();
  renderLibrary();
}

function renderAuthState() {
  if (!state.cloud) {
    setCloudStatus("Cloud not configured", "muted");
    elements.signOutButton.classList.add("hidden");
    elements.authControls.classList.remove("hidden");
    elements.saveAnalysisButton.disabled = !state.analysis;
    return;
  }
  if (state.session?.user) {
    setCloudStatus(`Signed in: ${state.session.user.email}`, "good");
    elements.signOutButton.classList.remove("hidden");
    elements.authControls.classList.add("hidden");
    elements.saveAnalysisButton.disabled = !state.analysis;
  } else {
    setCloudStatus("Cloud ready", "warn");
    elements.signOutButton.classList.add("hidden");
    elements.authControls.classList.remove("hidden");
    elements.saveAnalysisButton.disabled = !state.analysis;
  }
}

function renderResults() {
  const analysis = state.analysis;
  renderSessionSnapshot();
  if (!analysis) {
    elements.confidenceBadge.textContent = "No analysis";
    elements.confidenceBadge.className = "status-pill status-muted";
    elements.scoreSummary.classList.add("hidden");
    elements.scoreSummary.innerHTML = "";
    elements.vaultReport.classList.add("hidden");
    elements.vaultReport.innerHTML = "";
    elements.actionPlan.classList.add("hidden");
    elements.actionPlan.innerHTML = "";
    elements.technicalBreakdown.classList.add("hidden");
    elements.technicalBreakdown.innerHTML = "";
    elements.issuesList.innerHTML = '<p class="empty-copy">Analysis feedback will appear here.</p>';
    elements.metricsGrid.innerHTML = '<p class="empty-copy">Run analysis to calculate phase and body-line metrics.</p>';
    elements.phaseTimeline.innerHTML = "";
    elements.phaseLegend.innerHTML = "";
    window.lucide?.createIcons();
    return;
  }

  const confidence = analysis.confidence.overall ?? 0;
  elements.confidenceBadge.textContent = `Confidence ${Math.round(confidence * 100)}%`;
  elements.confidenceBadge.className = `status-pill ${confidence > 0.72 ? "status-good" : confidence > 0.48 ? "status-warn" : "status-bad"}`;

  elements.issuesList.innerHTML = analysis.issues
    .map(
      (issue) => `
        <article class="issue-item priority-${issue.priority}">
          <div class="issue-head">
            <h3>${escapeHtml(issue.title)}</h3>
            <span class="phase-tag">${escapeHtml(issue.phase)}</span>
          </div>
          <p>${escapeHtml(issue.cue)}</p>
          <p><strong>Drill:</strong> ${escapeHtml(issue.drill)}</p>
          ${issue.evidence ? `<p><strong>Evidence:</strong> ${escapeHtml(issue.evidence)}</p>` : ""}
          ${issue.measureNext ? `<p><strong>Measure next:</strong> ${escapeHtml(issue.measureNext)}</p>` : ""}
        </article>
      `,
    )
    .join("");

  elements.scoreSummary.classList.remove("hidden");
  elements.scoreSummary.innerHTML = renderScoreSummary(analysis);
  elements.vaultReport.classList.remove("hidden");
  elements.vaultReport.innerHTML = renderVaultReport(analysis);
  elements.actionPlan.classList.remove("hidden");
  elements.actionPlan.innerHTML = renderActionPlan(analysis);
  elements.technicalBreakdown.classList.remove("hidden");
  elements.technicalBreakdown.innerHTML = renderTechnicalBreakdown(analysis);
  elements.metricsGrid.innerHTML = metricTiles(analysis.metrics).join("");
  renderTimeline(analysis);
  window.lucide?.createIcons();
}

function renderTimeline(analysis) {
  const duration = analysis.videoMeta.duration || 1;
  elements.phaseTimeline.innerHTML = analysis.phaseRanges
    .map((phase) => {
      const width = Math.max(1, ((phase.endTime - phase.startTime) / duration) * 100);
      return `<span class="phase-segment ${phase.className}" title="${escapeHtml(phase.label)}" style="width: ${width}%"></span>`;
    })
    .join("");
  elements.phaseLegend.innerHTML = renderPhaseLegend(analysis);
}

function renderLibrary() {
  const rows = state.session ? [...state.library, ...state.localLibrary] : state.localLibrary;
  if (!rows.length) {
    elements.libraryList.innerHTML = state.session
      ? '<p class="empty-copy">No saved sessions yet. Cloud saves need sign-in; local reports save free in this browser.</p>'
      : '<p class="empty-copy">No local reports yet. Run analysis, then save it free in this browser.</p>';
    return;
  }
  elements.libraryList.innerHTML = "";
  rows.forEach((item) => {
    const button = document.createElement("button");
    button.className = `library-item${item.local ? " is-local" : ""}`;
    button.type = "button";
    const athleteName = item.athletes?.display_name ?? "Unnamed vaulter";
    const created = item.created_at ? new Date(item.created_at).toLocaleDateString() : "";
    const video = latest(item.videos);
    const source = item.local ? "This browser" : "Cloud";
    button.innerHTML = `
      <h3>${escapeHtml(item.title ?? "Vault review")}</h3>
      <p>${escapeHtml(athleteName)} &middot; ${escapeHtml(created)} &middot; ${escapeHtml(source)} &middot; ${escapeHtml(video?.file_name ?? "video")}</p>
    `;
    button.addEventListener("click", () => loadLibraryItem(item));
    elements.libraryList.append(button);
  });
}

function metricTiles(metrics) {
  const rows = [
    ["Frames", metrics.frameCount],
    ["Approach", percent(metrics.approachRhythm)],
    ["Speed build", percent(metrics.approachAcceleration)],
    ["Pole carry", percent(metrics.poleCarryControl)],
    ["Plant arms", percent(metrics.plantArmExtension)],
    ["Plant hands", percent(metrics.plantHandPosition)],
    ["Foot/box", percent(metrics.plantPosition)],
    ["Takeoff angle", Number.isFinite(metrics.takeoffAngleDegrees) ? `${metrics.takeoffAngleDegrees}deg` : null],
    ["Knee drive", percent(metrics.takeoffKneeDrive)],
    ["Trail leg", percent(metrics.trailLegStraightness)],
    ["Inversion", percent(metrics.inversionQuality)],
    ["Hip rise", percent(metrics.hipRise)],
    ["Turn timing", percent(metrics.turnTiming)],
    ["Clearance", percent(metrics.clearanceLine)],
  ];
  return rows.map(([label, value]) => `<div class="metric-tile"><span>${label}</span><strong>${value ?? "N/A"}</strong></div>`);
}

function renderTechnicalBreakdown(analysis) {
  const rows = analysis.coachingBreakdown ?? [];
  if (!rows.length) return "";
  return `
    <div class="breakdown-heading">
      <div>
        <p class="eyebrow">Research pass</p>
        <h3>Phase-by-phase analysis</h3>
      </div>
      <span>${rows.length} phases</span>
    </div>
    <div class="breakdown-grid">
      ${rows
        .map(
          (item) => `
            <article class="breakdown-card tone-${escapeHtml(item.status)}">
              <div class="breakdown-card-head">
                <span>${escapeHtml(item.phase)}</span>
                <strong>${Math.round((item.score ?? 0) * 100)}%</strong>
              </div>
              <h4>${escapeHtml(item.focus)}</h4>
              <p>${escapeHtml(item.summary)}</p>
              ${breakdownList("Looks good", item.good)}
              ${breakdownList("Needs review", item.watch)}
              ${breakdownList("Measure next", item.measureNext)}
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function breakdownList(label, items = []) {
  if (!items.length) return "";
  return `
    <div class="breakdown-list">
      <span>${escapeHtml(label)}</span>
      ${items.slice(0, 3).map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
    </div>
  `;
}

function renderScoreSummary(analysis) {
  const score = analysis.overallScore ?? 0;
  const status = score >= 72 ? "good" : score >= 52 ? "okay" : "bad";
  const items = [
    ["Upper body", analysis.bodyScores?.upperBody],
    ["Lower body", analysis.bodyScores?.lowerBody],
    ["Core line", analysis.bodyScores?.coreLine],
    ["Vault timing", analysis.bodyScores?.vaultTiming],
  ];
  return `
    <div class="overall-score" style="background: ${statusColor(status)}">
      <strong>${score}</strong>
      <span>Vault score</span>
    </div>
    <div class="score-bars">
      ${items
        .map(([label, value]) => {
          const pct = Math.round((value ?? 0) * 100);
          const itemStatus = pct >= 72 ? "good" : pct >= 52 ? "okay" : "bad";
          return `
            <div class="score-bar">
              <span>${escapeHtml(label)}</span>
              <div class="score-track"><i style="width:${pct}%; background:${statusColor(itemStatus)}"></i></div>
              <span>${pct}%</span>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderVaultReport(analysis) {
  const report = analysis.vaultReport ?? {};
  const analysisBlock = report.analysis ?? {
    score: analysis.overallScore ?? 0,
    status: scoreTone(analysis.overallScore ?? 0),
    primaryFocus: primaryCoachingIssue(analysis)?.title ?? "Frame-by-frame vault review",
    summary: primaryCoachingIssue(analysis)?.cue ?? "Review the strongest and weakest frames before changing the plan.",
    confidence: analysis.confidence?.overall ?? 0,
    strengths: strengthLabels(analysis.bodyScores).slice(0, 3).map((label) => ({ label, display: "", status: "okay" })),
  };
  const style = report.style ?? analysis.vaultStyle ?? {};
  const styleConfidence = Math.round(((style.styleConfidence ?? analysisBlock.confidence ?? 0) || 0) * 100);
  const sections = report.sections?.length
    ? report.sections
    : [
        { id: "analysis", label: "Analysis" },
        { id: "style", label: "Style" },
        { id: "metrics", label: "Metrics" },
        { id: "drills", label: "Drills" },
      ];
  const metrics = report.metrics?.length ? report.metrics : fallbackReportMetrics(analysis);
  const drills = report.drills?.length ? report.drills : fallbackReportDrills(analysis);
  const bestPhase = style.bestPhase?.label ? `${style.bestPhase.label} ${formatRatio(style.bestPhase.score)}` : "Keep reviewing";
  const workPhase = style.workPhase?.label ? `${style.workPhase.label} ${formatRatio(style.workPhase.score)}` : "Build a baseline";

  return `
    <div class="report-heading">
      <div>
        <p class="eyebrow">Vault report</p>
        <h3>Analysis, style, metrics, drills</h3>
      </div>
      <span class="status-pill ${styleConfidence >= 72 ? "status-good" : styleConfidence >= 48 ? "status-warn" : "status-bad"}">
        Style confidence ${styleConfidence}%
      </span>
    </div>
    <div class="report-tabs">
      ${sections.map((section) => `<span>${escapeHtml(section.label)}</span>`).join("")}
    </div>
    <div class="report-grid">
      <article class="report-card tone-${escapeHtml(analysisBlock.status ?? scoreTone(analysisBlock.score ?? 0))}">
        <div class="report-card-head">
          <i data-lucide="radar"></i>
          <span>Analysis</span>
          <strong>${escapeHtml(String(analysisBlock.score ?? analysis.overallScore ?? 0))}</strong>
        </div>
        <h4>${escapeHtml(analysisBlock.primaryFocus ?? "Frame review")}</h4>
        <p>${escapeHtml(analysisBlock.summary ?? "Use the phase timeline and overlay to confirm the jump shape.")}</p>
        ${renderReportStrengths(analysisBlock.strengths)}
      </article>

      <article class="report-card tone-${escapeHtml(style.status ?? "okay")}">
        <div class="report-card-head">
          <i data-lucide="activity"></i>
          <span>Style</span>
          <strong>${escapeHtml(formatRatio(style.score))}</strong>
        </div>
        <h4>${escapeHtml(style.label ?? "Vault Style")}</h4>
        <p>${escapeHtml(style.summary ?? "The app is building a style picture from the available phase scores.")}</p>
        <div class="style-split">
          <span><strong>Best</strong>${escapeHtml(bestPhase)}</span>
          <span><strong>Work</strong>${escapeHtml(workPhase)}</span>
        </div>
        ${style.cues?.length ? `<div class="report-cues">${style.cues.slice(0, 2).map((cue) => `<p>${escapeHtml(cue)}</p>`).join("")}</div>` : ""}
      </article>

      <article class="report-card report-card-wide">
        <div class="report-card-head">
          <i data-lucide="line-chart"></i>
          <span>Metrics</span>
          <strong>${metrics.length}</strong>
        </div>
        <div class="report-metric-grid">
          ${metrics.slice(0, 8).map(renderReportMetric).join("")}
        </div>
      </article>

      <article class="report-card report-card-wide">
        <div class="report-card-head">
          <i data-lucide="dumbbell"></i>
          <span>Drills</span>
          <strong>${drills.length}</strong>
        </div>
        <div class="report-drill-list">
          ${drills.slice(0, 3).map(renderReportDrill).join("")}
        </div>
      </article>
    </div>
  `;
}

function renderReportStrengths(strengths = []) {
  const rows = strengths.filter(Boolean).slice(0, 3);
  if (!rows.length) return "";
  return `
    <div class="report-strengths">
      ${rows
        .map(
          (item) => `
            <span class="report-mini tone-${escapeHtml(item.status ?? "okay")}">
              <strong>${escapeHtml(item.display || item.label)}</strong>
              ${escapeHtml(item.display ? item.label : "")}
            </span>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderReportMetric(metric) {
  return `
    <span class="report-metric tone-${escapeHtml(metric.status ?? "bad")}">
      <small>${escapeHtml(metric.phase || "Metric")}</small>
      <strong>${escapeHtml(metric.display ?? "N/A")}</strong>
      ${escapeHtml(metric.label)}
    </span>
  `;
}

function renderReportDrill(drill) {
  return `
    <div class="report-drill tone-${escapeHtml(drill.status ?? priorityTone(drill.priority))}">
      <span>${escapeHtml(drill.phase ?? "Overall")}</span>
      <strong>${escapeHtml(drill.title ?? "Review this phase")}</strong>
      <p>${escapeHtml(drill.drill ?? drill.cue ?? "Repeat the same camera angle and compare the next jump.")}</p>
    </div>
  `;
}

function renderSessionSnapshot() {
  const analysis = state.analysis;
  if (analysis) {
    const primaryIssue = primaryCoachingIssue(analysis);
    const confidence = Math.round((analysis.confidence?.overall ?? 0) * 100);
    elements.sessionSnapshot.innerHTML = [
      snapshotCard("Vault score", String(analysis.overallScore ?? 0), scoreTone(analysis.overallScore ?? 0), "trending-up"),
      snapshotCard("Top focus", primaryIssue?.title ?? "Frame review", priorityTone(primaryIssue?.priority), "target"),
      snapshotCard("Confidence", `${confidence}%`, confidence >= 72 ? "good" : confidence >= 48 ? "okay" : "bad", "radar"),
    ].join("");
    window.lucide?.createIcons();
    return;
  }

  if (state.sourceName) {
    elements.sessionSnapshot.innerHTML = [
      snapshotCard("Clip", state.sourceName, "neutral", "video"),
      snapshotCard("Tracking", state.livePreview ? "People visible" : "Ready", state.livePreview ? "good" : "neutral", "activity"),
      snapshotCard("Score", "--", "neutral", "gauge"),
    ].join("");
  } else {
    elements.sessionSnapshot.innerHTML = [
      snapshotCard("Status", "Ready", "good", "zap"),
      snapshotCard("Video", "No clip", "neutral", "video"),
      snapshotCard("Tracking", "All people", "neutral", "activity"),
    ].join("");
  }
  window.lucide?.createIcons();
}

function snapshotCard(label, value, tone, icon) {
  return `
    <article class="snapshot-card tone-${tone}">
      <i data-lucide="${icon}"></i>
      <div>
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    </article>
  `;
}

function renderPhaseLegend(analysis) {
  const phaseScores = {
    approach: analysis.bodyScores?.approach,
    "plant-takeoff": analysis.bodyScores?.plantTakeoff,
    "swing-rockback": analysis.bodyScores?.swingRockback,
    "extension-turn": analysis.bodyScores?.extensionTurn,
    "clearance-landing": analysis.bodyScores?.clearanceLanding,
  };
  return analysis.phaseRanges
    .map((phase) => {
      const score = phaseScores[phase.key];
      const scoreText = Number.isFinite(score) ? `${Math.round(score * 100)}%` : "--";
      return `
        <span class="phase-chip ${phase.className}">
          <i></i>
          ${escapeHtml(phase.label)}
          <strong>${scoreText}</strong>
        </span>
      `;
    })
    .join("");
}

function renderActionPlan(analysis) {
  const primary = primaryCoachingIssue(analysis);
  const nextIssues = analysis.issues.filter((issue) => issue.id !== primary?.id && issue.status !== "positive").slice(0, 2);
  const strengths = strengthLabels(analysis.bodyScores);
  const planCopy = "Use this as the first review pass, then confirm details frame by frame before changing the plan.";

  return `
    <div class="plan-heading">
      <div>
        <p class="eyebrow">Next session</p>
        <h3>Action plan</h3>
      </div>
      <span class="status-pill ${
        primary?.priority === "high" ? "status-bad" : primary?.priority === "medium" ? "status-warn" : "status-good"
      }">
        ${escapeHtml(primary?.phase ?? "Overall")}
      </span>
    </div>
    <p class="plan-copy">${escapeHtml(planCopy)}</p>
    <div class="plan-grid">
      <article>
        <i data-lucide="target"></i>
        <span>Focus cue</span>
        <strong>${escapeHtml(primary?.cue ?? "Use the overlay to compare the strongest and weakest frames.")}</strong>
      </article>
      <article>
        <i data-lucide="dumbbell"></i>
        <span>Drill</span>
        <strong>${escapeHtml(primary?.drill ?? "Repeat the same camera angle and compare the next jump.")}</strong>
      </article>
      <article>
        <i data-lucide="badge-check"></i>
        <span>Strength</span>
        <strong>${escapeHtml(strengths[0] ?? "Full-body tracking is ready for review.")}</strong>
      </article>
    </div>
    ${
      nextIssues.length
        ? `<div class="mini-focus-row">${nextIssues
            .map((issue) => `<span>${escapeHtml(issue.phase)}: ${escapeHtml(issue.title)}</span>`)
            .join("")}</div>`
        : ""
    }
  `;
}

function primaryCoachingIssue(analysis) {
  return (
    analysis.issues.find((issue) => issue.priority === "high" && issue.status !== "positive") ??
    analysis.issues.find((issue) => issue.status === "needs-work") ??
    analysis.issues.find((issue) => issue.status === "warning") ??
    analysis.issues[0] ??
    null
  );
}

function fallbackReportMetrics(analysis) {
  const metrics = analysis.metrics ?? {};
  const rows = [
    ["Approach rhythm", metrics.approachRhythm, "Approach"],
    ["Plant arms", metrics.plantArmExtension, "Plant"],
    ["Drive knee", metrics.takeoffKneeDrive, "Takeoff"],
    ["Trail leg", metrics.trailLegStraightness, "Swing"],
    ["Hip rise", metrics.hipRise, "Extension"],
    ["Clearance line", metrics.clearanceLine, "Clearance"],
  ];
  return rows
    .map(([label, value, phase]) => ({
      label,
      phase,
      score: value,
      display: percent(value),
      status: ratioTone(value),
    }))
    .filter((row) => row.display);
}

function fallbackReportDrills(analysis) {
  const primary = primaryCoachingIssue(analysis);
  if (!primary) return [];
  return [
    {
      title: primary.title,
      phase: primary.phase,
      cue: primary.cue,
      drill: primary.drill,
      priority: primary.priority,
      status: priorityTone(primary.priority),
    },
  ];
}

function strengthLabels(bodyScores = {}) {
  const labels = [
    ["Upper body", bodyScores.upperBody],
    ["Lower body", bodyScores.lowerBody],
    ["Core line", bodyScores.coreLine],
    ["Vault timing", bodyScores.vaultTiming],
    ["Plant takeoff", bodyScores.plantTakeoff],
    ["Swing", bodyScores.swingRockback],
    ["Extension", bodyScores.extensionTurn],
  ];
  return labels
    .filter(([, value]) => Number.isFinite(value))
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => `${label} is at ${Math.round(value * 100)}%`);
}

function ratioTone(value) {
  if (!Number.isFinite(value)) return "bad";
  return scoreTone(value * 100);
}

function formatRatio(value) {
  if (!Number.isFinite(value)) return "--";
  if (value <= 1) return `${Math.round(value * 100)}%`;
  return String(Math.round(value));
}

function drawCurrentOverlay() {
  drawOverlay({
    canvas: elements.overlayCanvas,
    video: elements.vaultVideo,
    analysis: state.analysis ?? state.livePreview,
    calibration: state.calibration,
    currentTime: elements.vaultVideo.currentTime || 0,
  });
}

function updateLiveForm() {
  const frame = nearestPoseFrame((state.analysis ?? state.livePreview)?.poseFrames ?? [], elements.vaultVideo.currentTime || 0);
  if (!frame?.form) {
    elements.liveFormStrip.classList.add("hidden");
    return;
  }
  const { form } = frame;
  const score = Math.round((form.overall ?? 0) * 100);
  elements.liveFormStrip.classList.remove("hidden");
  elements.liveStatusDot.className = `live-dot status-${form.status}`;
  elements.liveStatusLabel.textContent = labelForStatus(form.status);
  elements.livePhaseLabel.textContent = form.phaseLabel ?? "Current frame";
  elements.liveScoreLabel.textContent = `${score}%`;
  renderSessionSnapshot();
}

function updateVideoPlayButton() {
  const hasVideo = Boolean(state.sourceName && elements.vaultVideo.readyState >= 1);
  const shouldShow = hasVideo && (elements.vaultVideo.paused || elements.vaultVideo.ended);
  elements.videoPlayButton.classList.toggle("hidden", !shouldShow);
}

function loadVideoSource({ url, name, kind, file = null, objectUrl = false }) {
  state.file = file;
  state.sourceName = name || "vault-video";
  state.sourceKind = kind || "url";
  state.analysis = null;
  state.autoAnalysis = null;
  state.followTrackId = null;
  state.livePreview = null;
  state.liveReady = false;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = objectUrl ? url : null;
  if (kind === "url") {
    elements.vaultVideo.crossOrigin = "anonymous";
  } else {
    elements.vaultVideo.removeAttribute("crossorigin");
  }
  elements.vaultVideo.src = url;
  elements.vaultVideo.load();
  updateVideoPlayButton();
  elements.emptyVideoMessage.textContent = "Load a pole vault clip to begin review.";
  elements.emptyVideoState.classList.add("hidden");
  elements.sessionTitleInput.value ||= state.sourceName.replace(/\.[^.]+$/, "");
  elements.runAnalysisButton.disabled = false;
  elements.saveAnalysisButton.disabled = true;
  elements.exportJsonButton.disabled = true;
  elements.liveFormStrip.classList.add("hidden");
  renderResults();
}

function loadVideoFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const videoUrl = params.get("video");
  if (!videoUrl) return;
  loadVideoSource({
    url: videoUrl,
    name: params.get("name") || videoUrl.split("/").pop() || "vault-video",
    kind: "url",
  });
}

function nearestPoseFrame(frames, currentTime) {
  if (!frames.length) return null;
  return frames.reduce(
    (best, frame) => (Math.abs(frame.time - currentTime) < Math.abs(best.time - currentTime) ? frame : best),
    frames[0],
  );
}

function syncOverlay() {
  scheduleLivePreview();
  drawCurrentOverlay();
  requestAnimationFrame(syncOverlay);
}

function scheduleLivePreview() {
  if (state.analysis || !state.liveReady || state.liveDetecting || elements.vaultVideo.paused || elements.vaultVideo.ended) {
    return;
  }
  const now = performance.now();
  if (now - state.lastLiveDetectionAt < 120) return;
  state.liveDetecting = true;
  state.lastLiveDetectionAt = now;
  detectVideoFrame(elements.vaultVideo, {
    modelVariant: elements.modelVariantSelect.value === "heavy" ? "full" : elements.modelVariantSelect.value,
    cameraAngle: elements.cameraAngleSelect.value,
    duration: elements.vaultVideo.duration || 0,
  })
    .then((preview) => {
      state.livePreview = preview;
      updateLiveForm();
    })
    .catch((error) => {
      if (!state.livePreview) {
        elements.liveFormStrip.classList.remove("hidden");
        elements.liveStatusDot.className = "live-dot status-unknown";
        elements.liveStatusLabel.textContent = "Live tracker loading";
        elements.livePhaseLabel.textContent = error.message.includes("model") ? "Model is still loading" : "Play video to track";
        elements.liveScoreLabel.textContent = "";
      }
    })
    .finally(() => {
      state.liveDetecting = false;
    });
}

function updateTimeReadout() {
  const time = Number(elements.vaultVideo.currentTime || elements.timeSlider.value || 0);
  elements.timeSlider.value = String(time);
  elements.timeReadout.textContent = `${time.toFixed(2)}s`;
}

function setProgress(progress, message) {
  elements.progressBlock.classList.remove("hidden");
  elements.progressBar.style.width = `${Math.round(progress * 100)}%`;
  elements.progressText.textContent = message;
  elements.progressText.style.color = "var(--muted)";
}

function setProgressMessage(message, isError = false) {
  elements.progressBlock.classList.remove("hidden");
  elements.progressText.textContent = message;
  elements.progressText.style.color = isError ? "var(--red)" : "var(--muted)";
}

function setSetupMessage(message, isError = false) {
  elements.setupMessage.textContent = message;
  elements.setupMessage.style.color = isError ? "var(--red)" : "var(--muted)";
}

function setEntryMessage(message, isError = false) {
  elements.entryMessage.textContent = message;
  elements.entryMessage.style.color = isError ? "var(--red)" : "var(--muted)";
}

function setCloudStatus(message, tone) {
  elements.cloudStatus.textContent = message;
  elements.cloudStatus.className = `status-pill status-${tone}`;
}

function markerMessage(tool, count) {
  if (tool === "box") return "Plant box marker set.";
  if (count === 1) return `First ${tool} marker set; click once more.`;
  return `${tool[0].toUpperCase()}${tool.slice(1)} line set.`;
}

function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : null;
}

function labelForStatus(status) {
  if (status === "good") return "Good form";
  if (status === "okay") return "Okay form";
  if (status === "bad") return "Needs work";
  return "Live form";
}

function statusColor(status) {
  if (status === "good") return "#20c777";
  if (status === "okay") return "#f2c94c";
  if (status === "bad") return "#ff5a5f";
  return "#8b9692";
}

function scoreTone(score) {
  if (score >= 72) return "good";
  if (score >= 52) return "okay";
  return "bad";
}

function priorityTone(priority) {
  if (priority === "high") return "bad";
  if (priority === "medium") return "okay";
  if (priority === "low") return "good";
  return "neutral";
}

function defaultConfig() {
  if (!DEFAULT_SUPABASE_CONFIG.url || !DEFAULT_SUPABASE_CONFIG.anonKey) return null;
  return {
    url: DEFAULT_SUPABASE_CONFIG.url,
    anonKey: DEFAULT_SUPABASE_CONFIG.anonKey,
  };
}

function latest(rows) {
  if (!Array.isArray(rows)) return rows ?? null;
  return rows[0] ?? null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

import { analyzeVideoWithPose, detectVideoFrame } from "./pose-service.js";
import { canvasPointToVideoPoint, drawOverlay, drawRunwaySketch } from "./renderer.js";
import { createVaultCloud, loadSupabaseConfig, saveSupabaseConfig } from "./supabase-service.js";
import { loadLocalSessions, saveLocalSession } from "./local-library.js";
import { DEFAULT_SUPABASE_CONFIG } from "./config.js";

const elements = {
  appShell: document.querySelector(".app-shell"),
  coachModeButton: document.querySelector("#coachModeButton"),
  athleteModeButton: document.querySelector("#athleteModeButton"),
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
  emptyVideoState: document.querySelector("#emptyVideoState"),
  emptyVideoMessage: document.querySelector("#emptyVideoState p"),
  runwaySketch: document.querySelector("#runwaySketch"),
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
  actionPlan: document.querySelector("#actionPlan"),
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
  livePreview: null,
  liveDetecting: false,
  liveReady: false,
  lastLiveDetectionAt: 0,
  calibration: {},
  activeTool: null,
  library: [],
  localLibrary: loadLocalSessions(),
  viewMode: "coach",
};

init();

async function init() {
  drawRunwaySketch(elements.runwaySketch);
  bindEvents();
  setReviewMode("coach");
  hydrateConfig();
  await initCloud();
  loadVideoFromQuery();
  renderAll();
  requestAnimationFrame(syncOverlay);
  window.lucide?.createIcons();
}

function bindEvents() {
  [elements.coachModeButton, elements.athleteModeButton].forEach((button) => {
    button.addEventListener("click", () => setReviewMode(button.dataset.mode));
  });
  elements.saveConfigButton.addEventListener("click", handleSaveConfig);
  elements.signInButton.addEventListener("click", () => handleAuth("signIn"));
  elements.signUpButton.addEventListener("click", () => handleAuth("signUp"));
  elements.signOutButton.addEventListener("click", handleSignOut);
  elements.refreshLibraryButton.addEventListener("click", refreshLibrary);
  elements.videoInput.addEventListener("change", handleVideoSelected);
  elements.runAnalysisButton.addEventListener("click", runAnalysis);
  elements.vaultVideo.addEventListener("loadedmetadata", handleVideoMetadata);
  elements.vaultVideo.addEventListener("play", () => {
    state.liveReady = true;
    scheduleLivePreview();
  });
  elements.vaultVideo.addEventListener("timeupdate", handleTimeUpdate);
  elements.timeSlider.addEventListener("input", handleSliderInput);
  elements.overlayCanvas.addEventListener("click", handleCanvasClick);
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => setActiveTool(button.dataset.tool));
  });
  elements.clearCalibrationButton.addEventListener("click", () => {
    state.calibration = {};
    elements.calibrationMessage.textContent = "Calibration markers cleared.";
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

async function handleAuth(mode) {
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
    await refreshLibrary();
    renderAll();
  } catch (error) {
    setSetupMessage(error.message, true);
  }
}

async function handleSignOut() {
  try {
    await state.cloud?.signOut();
    state.session = null;
    state.library = [];
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
  elements.timeSlider.max = String(elements.vaultVideo.duration || 0);
  elements.timeSlider.disabled = false;
  updateTimeReadout();
  updateLiveForm();
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
    state.analysis = await analyzeVideoWithPose(elements.vaultVideo, {
      fileName: state.file?.name ?? state.sourceName,
      sampleRate: Number(elements.sampleRateSelect.value),
      modelVariant: elements.modelVariantSelect.value,
      cameraAngle: elements.cameraAngleSelect.value,
      calibration: state.calibration,
      onProgress: ({ progress, message }) => setProgress(progress, message),
    });
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
  if (!state.activeTool) return;
  const point = canvasPointToVideoPoint(elements.overlayCanvas, elements.vaultVideo, event.clientX, event.clientY);
  if (!point) {
    elements.calibrationMessage.textContent = "Click inside the visible video frame.";
    return;
  }

  const current = state.calibration[state.activeTool] ?? [];
  const next = state.activeTool === "box" ? [point] : current.length >= 2 ? [point] : [...current, point];
  state.calibration = { ...state.calibration, [state.activeTool]: next };
  elements.calibrationMessage.textContent = markerMessage(state.activeTool, next.length);
  drawCurrentOverlay();
}

function setActiveTool(tool) {
  state.activeTool = state.activeTool === tool ? null : tool;
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tool === state.activeTool);
  });
  elements.calibrationMessage.textContent = state.activeTool
    ? `Mark ${state.activeTool}; click the video frame.`
    : "Select a marker, then click the video.";
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
    state.calibration = analysis.calibration ?? {};
    elements.vaultVideo.src = signedUrl;
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
  state.livePreview = null;
  state.calibration = analysis.calibration ?? item.calibration ?? {};
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null;
  elements.vaultVideo.removeAttribute("src");
  elements.vaultVideo.load();
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
    elements.actionPlan.classList.add("hidden");
    elements.actionPlan.innerHTML = "";
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
        </article>
      `,
    )
    .join("");

  elements.scoreSummary.classList.remove("hidden");
  elements.scoreSummary.innerHTML = renderScoreSummary(analysis);
  elements.actionPlan.classList.remove("hidden");
  elements.actionPlan.innerHTML = renderActionPlan(analysis);
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
    ["Plant arms", percent(metrics.plantArmExtension)],
    ["Knee drive", percent(metrics.takeoffKneeDrive)],
    ["Trail leg", percent(metrics.trailLegStraightness)],
    ["Inversion", percent(metrics.inversionQuality)],
    ["Hip rise", percent(metrics.hipRise)],
    ["Clearance", percent(metrics.clearanceLine)],
  ];
  return rows.map(([label, value]) => `<div class="metric-tile"><span>${label}</span><strong>${value ?? "N/A"}</strong></div>`);
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

function renderSessionSnapshot() {
  const analysis = state.analysis;
  if (analysis) {
    const primaryIssue = primaryCoachingIssue(analysis);
    const confidence = Math.round((analysis.confidence?.overall ?? 0) * 100);
    elements.sessionSnapshot.innerHTML = [
      snapshotCard("Vault score", String(analysis.overallScore ?? 0), scoreTone(analysis.overallScore ?? 0), "trending-up"),
      snapshotCard("Top focus", primaryIssue?.title ?? "Frame review", priorityTone(primaryIssue?.priority), "target"),
      snapshotCard("Confidence", `${confidence}%`, confidence >= 72 ? "good" : confidence >= 48 ? "okay" : "bad", "radar"),
      snapshotCard("Mode", state.viewMode === "athlete" ? "Athlete" : "Coach", "neutral", state.viewMode === "athlete" ? "sparkles" : "clipboard-check"),
    ].join("");
    window.lucide?.createIcons();
    return;
  }

  if (state.sourceName) {
    elements.sessionSnapshot.innerHTML = [
      snapshotCard("Clip", state.sourceName, "neutral", "video"),
      snapshotCard("Overlay", state.livePreview ? "Tracking" : "Ready", state.livePreview ? "good" : "neutral", "activity"),
      snapshotCard("Score", "--", "neutral", "gauge"),
      snapshotCard("Mode", state.viewMode === "athlete" ? "Athlete" : "Coach", "neutral", state.viewMode === "athlete" ? "sparkles" : "clipboard-check"),
    ].join("");
  } else {
    elements.sessionSnapshot.innerHTML = [
      snapshotCard("Status", "Ready", "good", "zap"),
      snapshotCard("Video", "No clip", "neutral", "video"),
      snapshotCard("Overlay", "Standby", "neutral", "activity"),
      snapshotCard("Mode", state.viewMode === "athlete" ? "Athlete" : "Coach", "neutral", state.viewMode === "athlete" ? "sparkles" : "clipboard-check"),
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
  const modeCopy =
    state.viewMode === "athlete"
      ? "Keep this simple: one cue, one drill, one thing to feel on the next jump."
      : "Use this as the first review pass, then confirm details frame by frame before changing the plan.";

  return `
    <div class="plan-heading">
      <div>
        <p class="eyebrow">Next session</p>
        <h3>${state.viewMode === "athlete" ? "Your jump plan" : "Coach action plan"}</h3>
      </div>
      <span class="status-pill ${
        primary?.priority === "high" ? "status-bad" : primary?.priority === "medium" ? "status-warn" : "status-good"
      }">
        ${escapeHtml(primary?.phase ?? "Overall")}
      </span>
    </div>
    <p class="plan-copy">${escapeHtml(modeCopy)}</p>
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

function setReviewMode(mode) {
  state.viewMode = mode === "athlete" ? "athlete" : "coach";
  elements.appShell.dataset.mode = state.viewMode;
  [elements.coachModeButton, elements.athleteModeButton].forEach((button) => {
    const isActive = button.dataset.mode === state.viewMode;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  renderSessionSnapshot();
  if (state.analysis) {
    elements.actionPlan.innerHTML = renderActionPlan(state.analysis);
    window.lucide?.createIcons();
  }
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

function loadVideoSource({ url, name, kind, file = null, objectUrl = false }) {
  state.file = file;
  state.sourceName = name || "vault-video";
  state.sourceKind = kind || "url";
  state.analysis = null;
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

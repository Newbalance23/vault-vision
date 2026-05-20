const LOCAL_LIBRARY_KEY = "vaultVision.localSessions";
const LOCAL_LIBRARY_LIMIT = 20;

export function loadLocalSessions(storage = localStorage) {
  try {
    const rows = JSON.parse(storage.getItem(LOCAL_LIBRARY_KEY) || "[]");
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((row) => row?.id && row?.analyses?.[0]?.result)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, LOCAL_LIBRARY_LIMIT);
  } catch {
    return [];
  }
}

export function saveLocalSession({ analysis, athleteName, sessionTitle, cameraAngle, calibration } = {}, storage = localStorage) {
  if (!analysis) throw new Error("Run analysis before saving a local report.");

  const createdAt = new Date().toISOString();
  const existing = loadLocalSessions(storage);
  const session = {
    id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    local: true,
    title: sessionTitle?.trim() || analysis.videoMeta?.fileName?.replace(/\.[^.]+$/, "") || "Vault review",
    created_at: createdAt,
    camera_angle: cameraAngle || analysis.cameraAngle || "auto",
    calibration: calibration ?? analysis.calibration ?? {},
    athletes: {
      display_name: athleteName?.trim() || "Unnamed vaulter",
    },
    videos: [
      {
        file_name: analysis.videoMeta?.fileName ?? "local-video",
        duration_seconds: analysis.videoMeta?.duration ?? null,
      },
    ],
    analyses: [
      {
        id: `analysis-${Date.now()}`,
        created_at: createdAt,
        result: compactAnalysisForStorage(analysis),
      },
    ],
  };

  storage.setItem(LOCAL_LIBRARY_KEY, JSON.stringify([session, ...existing].slice(0, LOCAL_LIBRARY_LIMIT)));
  return session;
}

export function clearLocalSessions(storage = localStorage) {
  storage.removeItem(LOCAL_LIBRARY_KEY);
}

function compactAnalysisForStorage(analysis) {
  return {
    ...analysis,
    poseFrames: [],
    localFramesOmitted: true,
    limitations: [
      ...(analysis.limitations ?? []),
      "This browser-saved report omits full pose landmarks to keep local storage free and lightweight. Load the original clip and re-run analysis for overlay playback.",
    ],
  };
}

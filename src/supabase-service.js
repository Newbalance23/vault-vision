const CONFIG_KEY = "vaultVision.supabaseConfig";

let supabaseModulePromise;

export function loadSupabaseConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
  } catch {
    return null;
  }
}

export function saveSupabaseConfig(config) {
  localStorage.setItem(
    CONFIG_KEY,
    JSON.stringify({
      url: config.url.trim(),
      anonKey: config.anonKey.trim(),
    }),
  );
}

export async function createVaultCloud(config) {
  if (!config?.url || !config?.anonKey) return null;
  if (!supabaseModulePromise) {
    supabaseModulePromise = import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  }
  const { createClient } = await supabaseModulePromise;
  const client = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return new VaultCloud(client);
}

export class VaultCloud {
  constructor(client) {
    this.client = client;
  }

  async getSession() {
    const { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    return data.session;
  }

  onAuthStateChange(callback) {
    return this.client.auth.onAuthStateChange((_event, session) => callback(session));
  }

  async signIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  }

  async signUp(email, password) {
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) throw error;
    return data.session;
  }

  async signOut() {
    const { error } = await this.client.auth.signOut();
    if (error) throw error;
  }

  async ensureAthlete(displayName) {
    const name = displayName?.trim() || "Unnamed vaulter";
    const { data: existing, error: lookupError } = await this.client
      .from("athletes")
      .select("id, display_name")
      .ilike("display_name", name)
      .limit(1);
    if (lookupError) throw lookupError;
    if (existing?.length) return existing[0];

    const { data, error } = await this.client
      .from("athletes")
      .insert({ display_name: name })
      .select("id, display_name")
      .single();
    if (error) throw error;
    return data;
  }

  async saveVaultSession({ file, analysis, athleteName, sessionTitle, cameraAngle, calibration }) {
    const session = await this.getSession();
    if (!session?.user) throw new Error("Sign in before saving cloud analyses.");
    if (!file) throw new Error("Load the source video before saving.");

    const athlete = await this.ensureAthlete(athleteName);
    const { data: vaultSession, error: sessionError } = await this.client
      .from("vault_sessions")
      .insert({
        athlete_id: athlete.id,
        title: sessionTitle?.trim() || analysis.videoMeta.fileName || "Vault review",
        recorded_at: new Date().toISOString(),
        camera_angle: cameraAngle,
        calibration,
      })
      .select("id, title")
      .single();
    if (sessionError) throw sessionError;

    const safeName = file.name.replace(/[^\w.\-]+/g, "_");
    const storagePath = `${session.user.id}/${vaultSession.id}/${Date.now()}-${safeName}`;
    const { error: uploadError } = await this.client.storage.from("vault-videos").upload(storagePath, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type || "video/mp4",
    });
    if (uploadError) throw uploadError;

    const { error: videoError } = await this.client.from("videos").insert({
      session_id: vaultSession.id,
      storage_path: storagePath,
      file_name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
      duration_seconds: analysis.videoMeta.duration,
    });
    if (videoError) throw videoError;

    const { data: savedAnalysis, error: analysisError } = await this.client
      .from("analyses")
      .insert({
        session_id: vaultSession.id,
        schema_version: analysis.schemaVersion,
        result: analysis,
      })
      .select("id, created_at")
      .single();
    if (analysisError) throw analysisError;

    return { session: vaultSession, athlete, analysis: savedAnalysis, storagePath };
  }

  async listSessions() {
    const { data, error } = await this.client
      .from("vault_sessions")
      .select(
        "id,title,created_at,camera_angle,calibration,athletes(id,display_name),videos(id,file_name,storage_path,duration_seconds),analyses(id,created_at,result)",
      )
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) throw error;
    return data ?? [];
  }

  async signedVideoUrl(storagePath) {
    const { data, error } = await this.client.storage.from("vault-videos").createSignedUrl(storagePath, 60 * 60);
    if (error) throw error;
    return data.signedUrl;
  }
}

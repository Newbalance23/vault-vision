# Vault Vision Verification

## Local Checks

Run the analysis test harness:

```powershell
& "C:\Users\heroc\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" tests/analysis.test.mjs
```

Serve the app locally:

```powershell
& "C:\Users\heroc\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m http.server 4173
```

Open `http://localhost:4173`.

To test a local clip without the file picker, serve the video folder with CORS:

```powershell
& "C:\Users\heroc\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" tools/cors_static_server.py "C:\Users\heroc\Downloads" --port 4175
```

Then open:

```text
http://localhost:4173/?video=http%3A%2F%2F127.0.0.1%3A4175%2FIMG_0062.MOV&name=IMG_0062.MOV
```

## Supabase Manual Checks

1. Run `docs/supabase-schema.sql` in the Supabase SQL editor.
2. Create two test users in Supabase Auth or through the app.
3. Sign in as user A, upload a short vault clip, run analysis, and save it.
4. Sign out and sign in as user B. User B should not see user A's session.
5. In Storage, confirm uploaded video paths start with the signed-in user ID.
6. Attempt to create a signed URL for another user's path from the app session; RLS should reject it.

## Pose QA Notes

The app can be verified without a vault clip for layout, auth, calibration, and test fixtures. Full pose-quality validation requires real pole vault footage with the full body visible through approach, plant, swing, extension, and landing.

# Vault Vision

[![CI](https://github.com/Newbalance23/vault-vision/actions/workflows/ci.yml/badge.svg)](https://github.com/Newbalance23/vault-vision/actions/workflows/ci.yml)

Vault Vision is a static browser app for pole vault video review. It uploads and analyzes video locally in the browser, draws MediaPipe stick-figure tracking over the athlete, produces rule-based coaching cues, and can save private sessions to Supabase.

## Run Locally

This project intentionally has no npm build step. Serve the folder over HTTP so browser modules and video APIs work correctly:

```powershell
& "C:\Users\heroc\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m http.server 4173
```

Then open `http://localhost:4173`.

## Free Local Mode

Vault Vision can run without Supabase. Load a clip, run analysis, and use Save analysis to store a lightweight report in the current browser's local library. Local reports do not upload video or full pose landmarks, so they stay free and device-only.

## Supabase Setup

1. Create a Supabase project.
2. Run `docs/supabase-schema.sql` in the SQL editor.
3. Copy the project URL and anon key into the app, or add them to `src/config.js` for a public deployment.
4. Create or sign into an account.
5. Upload a pole vault video, run analysis, and save the session.

The app expects a private `vault-videos` bucket and row-level security policies from the SQL file.

## GoDaddy Deployment

See `docs/godaddy-deploy.md`. V1 is designed to work well as static files on GoDaddy while Supabase handles auth, storage, and saved analyses.

## Analysis Scope

V1 uses MediaPipe Pose Landmarker and transparent rules. It does not train a custom AI model. Camera angle, occlusion, video quality, and whether the pole or box are marked all affect confidence. The live stick figure uses green, yellow, and red to show good, okay, and needs-work form. Treat feedback as a coaching aid, not a safety guarantee.

The current scoring pass includes a research-grounded phase report for approach, plant/takeoff, swing/rockback, extension/turn, and clearance. Each report calls out what looks good, what needs review, and what should be measured next.

The dashboard now also has an Ochy-inspired vault report with four coachable sections: Analysis, Style, Metrics, and Drills. The style label is adapted for pole vault phases and remains confidence-gated when the video angle or tracking quality is weak.

## Tests

```powershell
& "C:\Users\heroc\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" tests/analysis.test.mjs
```

GitHub Actions also runs these tests on every push and pull request to `main`.

## Local Video QA

For repeatable testing with a local clip, serve the clip folder with `tools/cors_static_server.py` and open the app with `?video=<encoded video url>&name=<file name>`. This is only for local QA; normal users should use the Load video button.

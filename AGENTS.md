# Agent Guide

## Mission

Vault Vision is a browser-based pole vault analyzer. It loads a video, tracks athletes with MediaPipe Pose Landmarker, overlays a green/yellow/red stick figure, scores form with transparent rules, and can save private sessions through Supabase.

## Ground Rules

- Keep V1 deployable as static files unless a task explicitly requires a backend.
- Do not commit Supabase service-role keys, private videos, `.env` files, or local logs.
- Treat automated form feedback as a coaching aid, not a safety or medical guarantee.
- Prefer small, testable changes. Run the analysis tests before handing off.
- If changing pose scoring, update `tests/analysis.test.mjs` with a fixture that captures the intended behavior.

## Local Run

```powershell
& "C:\Users\heroc\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m http.server 4173
```

Open `http://localhost:4173`.

## Tests

Codex local check:

```powershell
powershell -ExecutionPolicy Bypass -File tools/codex_check.ps1
```

GitHub/Node check:

```powershell
npm run check
```

## Repo Map

- `index.html`: app shell.
- `src/app.js`: browser workflow, UI state, Supabase save/load.
- `src/pose-service.js`: MediaPipe model loading, live frame detection, full-video sampling.
- `src/analysis.js`: phase detection, active vaulter selection, metrics, scoring, feedback.
- `src/renderer.js`: canvas stick figure, color-coded form overlay, calibration markers.
- `src/supabase-service.js`: Supabase Auth, Storage, and saved session APIs.
- `docs/supabase-schema.sql`: backend schema and row-level security policies.
- `docs/codex-automation.md`: Codex automation workflow and research-analysis handoff rules.
- `docs/godaddy-deploy.md`: static website deployment notes.
- `docs/verification.md`: manual QA steps.
- `tools/cors_static_server.py`: local video QA helper.

## Collaboration Protocol

- Open an issue for each meaningful feature, bug, or experiment.
- Use concise issue titles prefixed by area: `analysis:`, `ui:`, `cloud:`, `deploy:`, or `docs:`.
- Leave a short handoff note in the issue or PR with what changed, how it was tested, and what remains risky.
- Do not rewrite large parts of the app unless the issue explicitly calls for a refactor.

## Codex Automation Contract

- Use `docs/codex-automation.md` for recurring Codex research work.
- Each automated research pass should either open a `codex/` pull request or leave a clear written status note explaining why no change was made.
- Before publishing, run `npm run check`.
- In Codex on this machine, run `powershell -ExecutionPolicy Bypass -File tools/codex_check.ps1`.
- For analysis changes, include the research source, the metric or rule changed, the confidence/uncertainty behavior, and fixture or browser validation.

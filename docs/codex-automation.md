# Codex Automation Runbook

This project is set up so Codex can work on Vault Vision from the local workspace and publish changes through GitHub.

## Current Automation

- Automation id: `autonomation-hourly-research-for-analysis`
- Purpose: improve the uploaded-video analysis output with research-grounded pole vault feedback.
- Scope: `src/analysis.js`, `src/pose-service.js`, `src/app.js` results rendering, tests, and analysis docs.
- Expected output: a `codex/` branch and pull request, or a written status note if no code change is safe.

## Required Workflow

1. Start from a clean `main`.
2. Create a new branch with the `codex/` prefix.
3. Inspect the current analysis path before editing.
4. Use credible pole vault technique or biomechanics references.
5. Improve only uploaded-video analysis, scoring, feedback, metrics, or results display.
6. Add or update tests for changed scoring/report behavior.
7. Run the Codex-local check:

```powershell
powershell -ExecutionPolicy Bypass -File tools/codex_check.ps1
```

For GitHub or environments with npm, this equivalent check also works:

```powershell
npm run check
```

8. Push the branch and open a pull request.
9. Include a PR note with changed files, validation, research sources, and remaining uncertainty.

## Research Baseline

The first manual research pass shipped in PR #9. It added:

- Phase-by-phase reports for approach, plant/takeoff, swing/rockback, extension/turn, and clearance.
- Evidence and "measure next" notes in priority issues.
- Metrics for speed build, pole-carry/hand-path proxy, plant hand position, foot-to-box position, takeoff angle, and turn timing.

Good follow-up work should refine those rules with better fixtures, calibration, and real-video validation rather than replacing the whole app.

## Verification

Use the local app for visual QA:

```powershell
& "C:\Users\heroc\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m http.server 4173
```

Open:

```text
http://127.0.0.1:4173/
```

For the sample clip on this machine, use:

```text
http://127.0.0.1:4173/?video=http%3A%2F%2F127.0.0.1%3A4175%2FIMG_0062.MOV&name=IMG_0062.MOV
```

Pose accuracy must remain marked as best-effort unless verified on real pole vault clips.

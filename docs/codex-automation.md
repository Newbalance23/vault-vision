# Codex Automation Runbook

This project is set up so Codex can work on Vault Vision from the local workspace and publish changes through GitHub.

## Automation Team

- Automation id: `autonomation-hourly-research-for-analysis`
- Purpose: improve the uploaded-video analysis output with research-grounded pole vault feedback.
- Scope: `src/analysis.js`, `src/pose-service.js`, `src/app.js` results rendering, tests, and analysis docs.
- Expected output: a `codex/` branch and pull request, or a written status note if no code change is safe.

- Automation id: `vault-vision-ui-polish-agent`
- Purpose: improve the athlete/coach user interface, responsive layout, results scanability, and first-screen workflow.
- Scope: `index.html`, `src/app.js`, `src/styles.css`, and verification docs.
- Schedule: weekly on Monday morning.

- Automation id: `vault-vision-coach-workflow-agent`
- Purpose: improve coach review workflows around calibration, local/cloud saves, library loading, export, and report handoff.
- Scope: `src/app.js`, `src/local-library.js`, `src/supabase-service.js` when needed, UI files, and behavior tests.
- Schedule: weekly on Tuesday morning.

- Automation id: `vault-vision-browser-qa-agent`
- Purpose: run local/live browser QA and catch workflow, layout, cache, and visible regression issues.
- Scope: verification docs and small verified UI fixes.
- Schedule: weekly on Wednesday morning.

- Automation id: `vault-vision-deployment-agent`
- Purpose: keep GitHub Pages, GoDaddy, CI, caching, and deployment documentation accurate.
- Scope: README, deployment docs, verification docs, workflows, and cache/version references.
- Schedule: weekly on Thursday morning.

- Automation id: `vault-vision-product-manager-agent`
- Purpose: keep issues, handoffs, and project priorities organized for future Codex work.
- Scope: GitHub issues/PRs and process docs.
- Schedule: weekly on Friday morning.

- Automation id: `update-agents-md`
- Purpose: keep `AGENTS.md` current with newly discovered workflows and commands.
- Scope: `AGENTS.md`.
- Schedule: hourly.

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

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$node = if (Test-Path $bundledNode) { $bundledNode } else { "node" }

Push-Location $repoRoot
try {
  & $node --check "src/analysis.js"
  & $node --check "src/app.js"
  & $node --check "src/pose-service.js"
  & $node "tests/analysis.test.mjs"
} finally {
  Pop-Location
}

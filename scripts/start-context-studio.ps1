param(
  [int]$Port = 43117
)

$pluginRoot = Split-Path -Parent $PSScriptRoot
$env:CONTEXT_STUDIO_PORT = $Port
node --no-warnings (Join-Path $pluginRoot "server.mjs") --open

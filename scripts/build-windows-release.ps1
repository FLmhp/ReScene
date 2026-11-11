# Build the Windows x64 NSIS installer from the repository root.
# Set RELEASE_API_URL / RELEASE_WEB_URL only for a non-production build.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$env:VITE_API_URL = if ($env:RELEASE_API_URL) { $env:RELEASE_API_URL } else { "https://api.rescene.xyz" }
$env:VITE_WEB_URL = if ($env:RELEASE_WEB_URL) { $env:RELEASE_WEB_URL } else { "https://app.rescene.xyz" }

node (Join-Path $root "scripts\check-versions.mjs")
if ($LASTEXITCODE -ne 0) { throw "Version metadata check failed" }

Push-Location $root
try {
    pnpm --filter @rescene/desktop tauri build --target x86_64-pc-windows-msvc --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw "Tauri NSIS build failed" }
} finally {
    Pop-Location
}

$installerDirs = @(
    (Join-Path $root "apps\desktop\src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis"),
    (Join-Path $root "apps\desktop\src-tauri\target\release\bundle\nsis")
)
$files = @($installerDirs | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem $_ -Filter "*.exe" })
if ($files.Count -ne 1) { throw "Expected exactly one NSIS installer, found $($files.Count)" }
Get-FileHash -Algorithm SHA256 $files[0].FullName | Format-List
Write-Output $files[0].FullName

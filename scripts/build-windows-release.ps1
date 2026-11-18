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

$version = (Get-Content -LiteralPath (Join-Path $root "VERSION") -Raw).Trim()
$installer = Join-Path $root "apps\desktop\src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\ReScene_${version}_x64-setup.exe"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "NSIS installer not found: $installer" }
$stream = [System.IO.File]::OpenRead($installer)
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $digest = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
} finally {
    $sha256.Dispose()
    $stream.Dispose()
}
Write-Output "SHA256 $digest"
Write-Output $installer

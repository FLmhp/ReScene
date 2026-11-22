# Build the Windows NSIS installer locally, mirroring the release workflow.
# Use this when GitHub Actions minutes are unavailable; the installer is unsigned
# unless a code-signing certificate is supplied out of band.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw -LiteralPath (Join-Path $root "VERSION")).Trim()
$env:VITE_API_URL = if ($env:VITE_API_URL) { $env:VITE_API_URL } else { "https://api.rescene.xyz" }
$env:VITE_WEB_URL = if ($env:VITE_WEB_URL) { $env:VITE_WEB_URL } else { "https://app.rescene.xyz" }

foreach ($name in @("VITE_API_URL", "VITE_WEB_URL")) {
    $url = $null
    if (-not [Uri]::TryCreate([Environment]::GetEnvironmentVariable($name), [UriKind]::Absolute, [ref]$url) -or $url.Scheme -ne "https") {
        throw "$name must be an absolute HTTPS URL"
    }
    if ($name -eq "VITE_API_URL" -and $url.GetLeftPart([UriPartial]::Authority) -ne "https://api.rescene.xyz") {
        throw "VITE_API_URL origin must match the desktop CSP: https://api.rescene.xyz"
    }
}

Push-Location $root
try {
    node scripts/check-versions.mjs
    if ($LASTEXITCODE -ne 0) { throw "Version metadata is inconsistent" }
    pnpm --filter @rescene/desktop tauri build --target x86_64-pc-windows-msvc --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw "Tauri NSIS build failed" }
} finally {
    Pop-Location
}

$installerPath = Join-Path $root "apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/ReScene_${version}_x64-setup.exe"
if (-not (Test-Path -LiteralPath $installerPath)) { throw "Installer not found: $installerPath" }
$installer = Get-Item -LiteralPath $installerPath
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $digest = [System.BitConverter]::ToString($sha256.ComputeHash([System.IO.File]::ReadAllBytes($installer.FullName))).Replace("-", "").ToLowerInvariant()
} finally {
    $sha256.Dispose()
}
Write-Output "version $version"
Write-Output "size $($installer.Length)"
Write-Output "SHA256 $digest"
Write-Output $installer.FullName

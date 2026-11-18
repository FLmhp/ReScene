# Build the signed Android release APK locally.
# Signing values are read from the protected env file and never printed.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $env:USERPROFILE ".rescene\android-signing.env"
if (-not (Test-Path $envFile)) {
    throw "Missing signing env: $envFile"
}

Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $name, $value = $line -split "=", 2
    if (-not $name -or $null -eq $value) { throw "Invalid signing env line" }
    Set-Item -Path "Env:$($name.Trim())" -Value $value
}

foreach ($name in @("RESCENE_ANDROID_KEYSTORE_PATH", "RESCENE_ANDROID_KEYSTORE_PASSWORD", "RESCENE_ANDROID_KEY_ALIAS", "RESCENE_ANDROID_KEY_PASSWORD")) {
    if (-not (Get-Item "Env:$name" -ErrorAction SilentlyContinue)) { throw "$name is required" }
}

if (-not $env:ANDROID_HOME) {
    $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android\Sdk"
}
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
if (-not $env:JAVA_HOME) {
    $env:JAVA_HOME = (Get-Command java | Select-Object -ExpandProperty Source | Split-Path -Parent | Split-Path -Parent)
}
if (-not $env:EXPO_PUBLIC_API_URL) { $env:EXPO_PUBLIC_API_URL = "https://api.rescene.xyz" }
if (-not $env:EXPO_PUBLIC_WEB_URL) { $env:EXPO_PUBLIC_WEB_URL = "https://app.rescene.xyz" }

$android = Join-Path $root "apps\mobile\android"
if (-not (Test-Path (Join-Path $android "gradlew.bat"))) {
    throw "Android native project is missing; run Expo prebuild before this script"
}
$app = (Get-Content -Raw -LiteralPath (Join-Path $root "apps\mobile\app.json") | ConvertFrom-Json).expo
$gradle = Get-Content -Raw -LiteralPath (Join-Path $android "app\build.gradle")
$version = [regex]::Escape($app.version)
$versionCode = [int]$app.android.versionCode
if ($gradle -notmatch "(?m)^\s*versionName\s+`"$version`"\s*$" -or
    $gradle -notmatch "(?m)^\s*versionCode\s+$versionCode\s*$") {
    throw "Android native version is stale; regenerate with Expo prebuild from the current app.json before building"
}

Push-Location $android
try {
    # React Native's bundle task can miss changes in sibling workspace packages.
    & .\gradlew.bat --no-daemon -I (Join-Path $PSScriptRoot "android-windows-cmake.init.gradle") :app:createBundleReleaseJsAndAssets --rerun :app:assembleRelease "-PreactNativeArchitectures=arm64-v8a,x86_64"
    if ($LASTEXITCODE -ne 0) { throw "Gradle release build failed" }
} finally {
    Pop-Location
}

$apk = Join-Path $android "app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $apk)) { throw "Release APK not found: $apk" }
$apksigner = Join-Path $env:ANDROID_HOME "build-tools\36.0.0\apksigner.bat"
if (Test-Path $apksigner) {
    & $apksigner verify --print-certs $apk
    if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed" }
}
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $digest = [System.BitConverter]::ToString($sha256.ComputeHash([System.IO.File]::ReadAllBytes($apk))).Replace("-", "").ToLowerInvariant()
} finally {
    $sha256.Dispose()
}
Write-Output "SHA256 $digest"
Write-Output $apk

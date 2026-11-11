param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet('sync', 'bootstrap', 'model', 'smoke', 'run', 'benchmark', 'status', 'logs', 'fetch', 'worker-start', 'worker-drain', 'worker-stop', 'worker-status', 'worker-logs')]
    [string]$Action,
    [string]$Profile = 'balanced',
    [string]$InputPath,
    [string]$RunId,
    [string]$ModelPath,
    [Parameter(Mandatory = $true)]
    [string]$Remote,
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [switch]$Resume
)

$ErrorActionPreference = 'Stop'
$LocalRoot = Split-Path -Parent $PSScriptRoot

function Assert-ExternalCommand {
    if ($LASTEXITCODE -ne 0) { throw "External command failed with exit code $LASTEXITCODE" }
}

switch ($Action) {
    'sync' {
        ssh $Remote "mkdir -p $Root"
        Assert-ExternalCommand
        $Archive = Join-Path ([System.IO.Path]::GetTempPath()) 'rescene-sync.tar.gz'
        tar --exclude='__pycache__' --exclude='*.pyc' -C $LocalRoot -czf $Archive VERSION pyproject.toml README.md configs src scripts tests
        Assert-ExternalCommand
        scp $Archive "${Remote}:$Root/.sync.tar.gz"
        Assert-ExternalCommand
        ssh $Remote "tar -C $Root -xzf $Root/.sync.tar.gz"
        Assert-ExternalCommand
        Remove-Item -LiteralPath $Archive
        ssh $Remote "chmod +x $Root/scripts/*.sh $Root/scripts/workerctl $Root/workerctl"
        Assert-ExternalCommand
    }
    'bootstrap' { ssh $Remote "cd $Root && ./scripts/bootstrap_5090.sh"; Assert-ExternalCommand }
    'model' {
        if (-not $ModelPath) { throw '-ModelPath is required' }
        $Leaf = Split-Path -Leaf $ModelPath
        if ($Leaf -notin @('model.safetensors', 'model.pt')) { throw 'Model filename must be model.safetensors or model.pt' }
        ssh $Remote "mkdir -p $Root/.cache/models/VGGT-1B"
        Assert-ExternalCommand
        scp $ModelPath "${Remote}:$Root/.cache/models/VGGT-1B/$Leaf"
        Assert-ExternalCommand
        ssh $Remote "cd $Root/.cache/models/VGGT-1B && sha256sum $Leaf | tee $Leaf.sha256"
        Assert-ExternalCommand
    }
    'smoke' { ssh $Remote "cd $Root && .venv/bin/python scripts/smoke_gpu.py"; Assert-ExternalCommand }
    'worker-start' { ssh $Remote "cd $Root && ./workerctl start"; Assert-ExternalCommand }
    'worker-drain' { ssh $Remote "cd $Root && ./workerctl drain"; Assert-ExternalCommand }
    'worker-stop' { ssh $Remote "cd $Root && ./workerctl stop"; Assert-ExternalCommand }
    'worker-status' { ssh $Remote "cd $Root && ./workerctl status"; Assert-ExternalCommand }
    'worker-logs' { ssh $Remote "cd $Root && ./workerctl logs"; Assert-ExternalCommand }
    'run' {
        if (-not $InputPath -or -not $RunId) { throw '-InputPath and -RunId are required' }
        $ResumeValue = if ($Resume) { 'true' } else { 'false' }
        ssh $Remote "cd $Root && ./scripts/launch_remote.sh '$Profile' '$InputPath' '$RunId' '$ResumeValue'"
    }
    'benchmark' {
        if (-not $RunId) { $RunId = 'academic-v1' }
        $ResumeValue = if ($Resume) { 'true' } else { 'false' }
        ssh $Remote "cd $Root && ./scripts/launch_benchmark_remote.sh '$RunId' '$ResumeValue'"
    }
    'status' {
        if (-not $RunId) { throw '-RunId is required' }
        ssh $Remote "if pgrep -F '$Root/runs/$RunId/pid' > /dev/null 2>&1; then echo RUNNING; else echo STOPPED; fi; find '$Root/runs/$RunId/stages' -maxdepth 1 -type f -print -exec cat {} \; 2>/dev/null"
    }
    'logs' {
        if (-not $RunId) { throw '-RunId is required' }
        ssh $Remote "tail -n 200 '$Root/runs/$RunId/launcher.log'"
    }
    'fetch' {
        if (-not $RunId) { throw '-RunId is required' }
        $Destination = Join-Path $LocalRoot "fetched/$RunId"
        New-Item -ItemType Directory -Force $Destination | Out-Null
        scp -r "${Remote}:$Root/runs/$RunId/metrics.json" "${Remote}:$Root/runs/$RunId/report.md" "${Remote}:$Root/runs/$RunId/scene.spz" $Destination
    }
}

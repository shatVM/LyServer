#requires -Version 5.1
<#
.SYNOPSIS
    LyServer dispatcher v0.2 - stage 1: preflight checks and preview mode.
.DESCRIPTION
    Stage 1 implements ONLY read-only checks and a preview of pending tasks.
    It never changes GitHub state, branches, or repository files.
    Later stages (locks, isolated worktrees, OpenCode execution, publishing)
    are intentionally NOT implemented yet.
.NOTES
    PowerShell 5.1 compatible. No secrets are stored or logged.
#>
[CmdletBinding()]
param(
    # Default resolved below: in PS 5.1 $PSScriptRoot is empty during param binding
    [string]$ConfigPath,
    # Stage 1 is preview-by-default; there is no write mode yet.
    [switch]$SkipModelPing
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($ConfigPath)) {
    $ConfigPath = Join-Path -Path $PSScriptRoot -ChildPath 'config.psd1'
}

# ---------------------------------------------------------------------------
# Logging (always outside the repository, never contains secrets)
# ---------------------------------------------------------------------------
$script:LogFile = $null

function Write-Log {
    param([string]$Level, [string]$Message)
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    switch ($Level) {
        'ERROR' { Write-Host $line -ForegroundColor Red }
        'WARN'  { Write-Host $line -ForegroundColor Yellow }
        'OK'    { Write-Host $line -ForegroundColor Green }
        default { Write-Host $line }
    }
    if ($script:LogFile) { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 }
}

function Stop-Dispatcher {
    param([string]$Message)
    Write-Log 'ERROR' $Message
    Write-Log 'INFO' 'Dispatcher stopped. No GitHub or repository state was modified.'
    exit 1
}

# ---------------------------------------------------------------------------
# Safe native command invocation (avoids the PS 5.1 stderr-redirect pitfall
# where 2>$null under $ErrorActionPreference='Stop' raises NativeCommandError)
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Command resolution: PATH entries may be shims (.ps1/.cmd from npm) which
# System.Diagnostics.Process cannot start directly; wrap them in a shell.
# Returns @{ FilePath = <exe>; PrefixArgs = <args inserted before ours> }
# ---------------------------------------------------------------------------
function Resolve-Command {
    param([Parameter(Mandatory)][string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    $src = $cmd.Source
    switch -Regex ($src) {
        '\.ps1$' {
            return @{ FilePath = 'powershell.exe'; PrefixArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $src) }
        }
        '\.(cmd|bat)$' {
            return @{ FilePath = 'cmd.exe'; PrefixArgs = @('/c', $src) }
        }
        default {
            return @{ FilePath = $src; PrefixArgs = @() }
        }
    }
}

function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Tool,
        [string[]]$ArgumentList = @(),
        [int]$TimeoutSec = 0
    )
    $resolved = Resolve-Command -Name $Tool
    if (-not $resolved) { throw "Cannot resolve tool: $Tool" }
    $allArgs = @($resolved.PrefixArgs) + @($ArgumentList)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $resolved.FilePath
    # Quote arguments containing spaces
    $psi.Arguments = ($allArgs | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join ' '
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()

    # Async read avoids deadlock on large output
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()

    if ($TimeoutSec -gt 0) {
        if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
            try { $proc.Kill() } catch { }
            return [pscustomobject]@{ ExitCode = $null; StdOut = $stdoutTask.Result; StdErr = $stderrTask.Result; TimedOut = $true }
        }
    }
    else {
        $proc.WaitForExit()
    }

    return [pscustomobject]@{ ExitCode = $proc.ExitCode; StdOut = $stdoutTask.Result; StdErr = $stderrTask.Result; TimedOut = $false }
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'LyServer dispatcher v0.2 (stage 1: checks + preview)' -ForegroundColor Cyan
Write-Host 'Mode: READ-ONLY PREVIEW. No write operations are implemented yet.' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    Write-Host "STOP: config not found: $ConfigPath" -ForegroundColor Red
    Write-Host "Copy config.example.psd1 to config.psd1 and adjust it." -ForegroundColor Yellow
    exit 1
}

try {
    $cfg = Import-PowerShellDataFile -Path $ConfigPath
}
catch {
    Write-Host "STOP: cannot parse config: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Init logging after config is known
if (-not (Test-Path -LiteralPath $cfg.LogDir -PathType Container)) {
    New-Item -ItemType Directory -Path $cfg.LogDir -Force | Out-Null
}
$script:LogFile = Join-Path $cfg.LogDir ('dispatcher-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

Write-Log 'INFO' '=== Dispatcher started (stage 1: checks + preview) ==='
Write-Log 'INFO' ("Config: {0}" -f $ConfigPath)
Write-Log 'INFO' ("RepoPath: {0}" -f $cfg.RepoPath)
Write-Log 'INFO' ("GitHubRepo: {0}" -f $cfg.GitHubRepo)
Write-Log 'INFO' ("Model: {0}" -f $cfg.Model)
Write-Log 'INFO' ("PowerShell: {0}" -f $PSVersionTable.PSVersion)

# ---------------------------------------------------------------------------
# Preflight 1: required tools
# ---------------------------------------------------------------------------
foreach ($toolName in @('git', 'gh', 'opencode')) {
    $cmd = Get-Command $toolName -ErrorAction SilentlyContinue
    if (-not $cmd) { Stop-Dispatcher ("Required tool not found in PATH: {0}" -f $toolName) }
    Write-Log 'OK' ("Tool available: {0}" -f $toolName)
}

# ---------------------------------------------------------------------------
# Preflight 2: GitHub CLI authentication
# ---------------------------------------------------------------------------
$auth = Invoke-Native -Tool 'gh' -ArgumentList @('auth', 'status')
if ($auth.ExitCode -ne 0) { Stop-Dispatcher ('gh is not authenticated. Exit code: {0}' -f $auth.ExitCode) }
Write-Log 'OK' 'gh: authenticated'

# ---------------------------------------------------------------------------
# Preflight 3: local repository path, remote, work tree
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $cfg.RepoPath -PathType Container)) {
    Stop-Dispatcher ("Repository directory does not exist: {0}" -f $cfg.RepoPath)
}

$wt = Invoke-Native -Tool 'git' -ArgumentList @('-C', $cfg.RepoPath, 'rev-parse', '--is-inside-work-tree')
if ($wt.ExitCode -ne 0 -or $wt.StdOut.Trim() -ne 'true') {
    Stop-Dispatcher ("Not a git working tree: {0}" -f $cfg.RepoPath)
}
Write-Log 'OK' 'git: directory is a working tree'

$remote = Invoke-Native -Tool 'git' -ArgumentList @('-C', $cfg.RepoPath, 'remote', 'get-url', 'origin')
if ($remote.ExitCode -ne 0) { Stop-Dispatcher 'Cannot read origin remote.' }
$foundRemote = $remote.StdOut.Trim().TrimEnd('/')
$expectedRemote = $cfg.ExpectedRemote.TrimEnd('/')
if ($foundRemote -ne $expectedRemote) {
    Stop-Dispatcher ("origin mismatch. Found: {0}, expected: {1}" -f $foundRemote, $expectedRemote)
}
Write-Log 'OK' ("git: origin matches expected remote ({0})" -f $foundRemote)

# ---------------------------------------------------------------------------
# Preflight 4: GitHub API reachability + default branch
# ---------------------------------------------------------------------------
$repoApi = Invoke-Native -Tool 'gh' -ArgumentList @('api', ("repos/{0}" -f $cfg.GitHubRepo), '--jq', '.default_branch')
if ($repoApi.ExitCode -ne 0) {
    Stop-Dispatcher ('GitHub API is unreachable for {0}. StdErr: {1}' -f $cfg.GitHubRepo, $repoApi.StdErr.Trim())
}
$defaultBranch = $repoApi.StdOut.Trim()
if ([string]::IsNullOrWhiteSpace($defaultBranch)) { Stop-Dispatcher 'GitHub returned an empty default branch.' }
Write-Log 'OK' ("GitHub API reachable; default branch: {0}" -f $defaultBranch)

# ---------------------------------------------------------------------------
# Preflight 5: model availability (test ping). On failure the dispatcher stops
# WITHOUT touching any Issue state (acceptance criterion 4).
# ---------------------------------------------------------------------------
if ($SkipModelPing) {
    Write-Log 'WARN' 'Model ping SKIPPED by -SkipModelPing switch.'
}
else {
    Write-Log 'INFO' ("Pinging model {0} (timeout {1}s)..." -f $cfg.Model, $cfg.ModelPingTimeoutSec)
    $pingPrompt = 'Reply with exactly the single word: PONG'
    $ping = Invoke-Native -Tool 'opencode' -ArgumentList @('run', '--model', $cfg.Model, $pingPrompt) -TimeoutSec ([int]$cfg.ModelPingTimeoutSec)
    if ($ping.TimedOut) {
        Stop-Dispatcher ('Model ping TIMED OUT after {0}s. Task state untouched.' -f $cfg.ModelPingTimeoutSec)
    }
    if ($ping.ExitCode -ne 0) {
        Stop-Dispatcher ('Model ping FAILED (exit {0}): {1}. Task state untouched.' -f $ping.ExitCode, $ping.StdErr.Trim())
    }
    if ($ping.StdOut -notmatch 'PONG') {
        Stop-Dispatcher ('Model ping returned unexpected output (first 200 chars): {0}. Task state untouched.' -f $ping.StdOut.Trim().Substring(0, [Math]::Min(200, $ping.StdOut.Trim().Length)))
    }
    Write-Log 'OK' 'Model ping succeeded.'
}

# ---------------------------------------------------------------------------
# Preflight 6: clean working tree of the MAIN clone
# ---------------------------------------------------------------------------
$status = Invoke-Native -Tool 'git' -ArgumentList @('-C', $cfg.RepoPath, 'status', '--porcelain')
if ($status.ExitCode -ne 0) { Stop-Dispatcher 'Cannot read working tree status.' }
if (-not [string]::IsNullOrWhiteSpace($status.StdOut)) {
    Write-Log 'WARN' 'Working tree is NOT clean:'
    $status.StdOut -split "`r?`n" | Where-Object { $_ } | ForEach-Object { Write-Log 'WARN' ("  {0}" -f $_) }
    Stop-Dispatcher 'Main clone working tree must be clean before the dispatcher runs.'
}
Write-Log 'OK' 'git: working tree is clean'

# ---------------------------------------------------------------------------
# Discovery: open Issues with the ready label (read-only)
# ---------------------------------------------------------------------------
$issuesRaw = Invoke-Native -Tool 'gh' -ArgumentList @(
    'issue', 'list', '--repo', $cfg.GitHubRepo,
    '--state', 'open', '--label', $cfg.LabelReady,
    '--json', 'number,title,url,labels', '--limit', '50'
)
if ($issuesRaw.ExitCode -ne 0) { Stop-Dispatcher ('gh issue list failed: {0}' -f $issuesRaw.StdErr.Trim()) }

$issues = @()
if (-not [string]::IsNullOrWhiteSpace($issuesRaw.StdOut)) {
    try {
        # PS 5.1 quirk: ConvertFrom-Json returns a JSON array as ONE Object[]
        # element; pipe through ForEach-Object to flatten into a real array.
        $issues = @(($issuesRaw.StdOut | ConvertFrom-Json) | ForEach-Object { $_ })
    }
    catch { Stop-Dispatcher ('gh returned invalid JSON: {0}' -f $_.Exception.Message) }
}

# Client-side filter: never touch issues that also carry in-progress
$candidates = @()
foreach ($issue in $issues) {
    $labelNames = @($issue.labels | ForEach-Object { $_.name })
    if ($labelNames -contains $cfg.LabelInProgress) {
        Write-Log 'WARN' ("Issue #{0} has '{1}' label - skipped (already being processed)." -f $issue.number, $cfg.LabelInProgress)
        continue
    }
    $candidates += , $issue
}

Write-Log 'INFO' ("Found {0} candidate Issue(s) with label '{1}'." -f $candidates.Count, $cfg.LabelReady)

# Stage 1 limit: at most one task per run (preview only)
$planned = @()
if ($candidates.Count -gt 0) {
    $planned = @($candidates[0])
    if ($candidates.Count -gt 1) {
        $rest = ($candidates | Select-Object -Skip 1 | ForEach-Object { '#{0}' -f $_.number }) -join ', '
        Write-Log 'INFO' ("Stage 1 processes one task per run. Remaining: {0}" -f $rest)
    }
}

# ---------------------------------------------------------------------------
# Preview (stage 1 ends here - no claims, no branches, no sessions)
# ---------------------------------------------------------------------------
if ($planned.Count -eq 0) {
    Write-Log 'INFO' 'No tasks to process. Nothing was changed.'
    Write-Log 'INFO' '=== Dispatcher finished (stage 1) ==='
    exit 0
}

foreach ($task in $planned) {
    Write-Host ''
    Write-Host '--- PLANNED TASK (preview only; nothing was executed) ---' -ForegroundColor Cyan
    Write-Host ("Issue:     #{0} {1}" -f $task.number, $task.title)
    Write-Host ("URL:       {0}" -f $task.url)
    Write-Host ("Branch:    {0}/issue-{1}" -f 'opencode', $task.number)
    Write-Host ("Target:    {0} (default branch)" -f $defaultBranch)
    Write-Host ("Model:     {0}" -f $cfg.Model)
    Write-Host 'Next stages (not implemented yet):'
    Write-Host '  2. lock file + isolated git worktree'
    Write-Host '  3. OpenCode session with timeout and logging'
    Write-Host '  4. result verification and label transitions'
    Write-Host '  5. branch push, PR creation, Issue comment'
    Write-Host '-----------------------------------------------------' -ForegroundColor Cyan
}

Write-Log 'INFO' 'Preview completed. No claims, branches, sessions, or GitHub changes were made.'
Write-Log 'INFO' '=== Dispatcher finished (stage 1) ==='
exit 0

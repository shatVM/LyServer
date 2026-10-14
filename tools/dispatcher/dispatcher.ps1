#requires -Version 5.1
<#
.SYNOPSIS
    LyServer dispatcher v0.2 - stage 1: preflight checks and preview mode.
.DESCRIPTION
    Stage 1 performs read-only checks and shows a preview of pending tasks.
    It does not change GitHub state, branches, or repository files.
    Side effects are limited to: creating/writing log files in LogDir
    (validated to be OUTSIDE the repository) and running `opencode run`
    as a model ping. Later stages (locks, worktrees, task execution,
    publishing) are intentionally NOT implemented yet.
.NOTES
    PowerShell 5.1 compatible. No secrets are stored or logged.
#>
[CmdletBinding()]
param(
    # Default resolved below: in PS 5.1 $PSScriptRoot is empty during param binding
    [string]$ConfigPath,
    # Diagnostics only: skip the model ping. The preview then reports
    # "MODEL NOT VERIFIED"; do not use for real runs.
    [switch]$SkipModelPing
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($ConfigPath)) {
    $ConfigPath = Join-Path -Path $PSScriptRoot -ChildPath 'config.psd1'
}

# ---------------------------------------------------------------------------
# Logging (outside the repository, never contains secrets)
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
    if ($script:LogFile) {
        try { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 }
        catch { Write-Host ("(log write failed: {0})" -f $_.Exception.Message) -ForegroundColor Yellow }
    }
}

function Stop-Dispatcher {
    param([string]$Message)
    Write-Log 'ERROR' $Message
    Write-Log 'INFO' 'Dispatcher stopped. No GitHub or repository state was modified.'
    exit 1
}

# ---------------------------------------------------------------------------
# Windows command-line argument escaping (CommandLineToArgvW rules):
#   - empty arguments are emitted as "" so they survive argument parsing;
#   - backslashes are literal unless followed by a double quote;
#   - a run of backslashes before a double quote is doubled, the quote is
#     escaped with a backslash;
#   - trailing backslashes inside a quoted argument are doubled.
#   - arguments containing cmd.exe metacharacters (& | < > ^ ( )) are quoted
#     as well: .cmd wrappers are launched via `cmd /d /c`, where
#     CommandLineToArgvW rules alone do NOT protect against shell parsing.
#     Known limitation: % expansion inside .cmd files is not prevented by
#     quoting; .cmd wrappers must not forward such arguments unchecked.
# ---------------------------------------------------------------------------
function ConvertTo-WinArg {
    param([string]$Value)
    if ([string]::IsNullOrEmpty($Value)) { return '""' }
    if ($Value -notmatch '[\s"&|<>^()]') { return $Value }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $pendingBackslashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $pendingBackslashes++; continue }
        if ($ch -eq '"') {
            [void]$sb.Append(('\' * ($pendingBackslashes * 2 + 1)))
            [void]$sb.Append('"')
        }
        else {
            if ($pendingBackslashes -gt 0) { [void]$sb.Append(('\' * $pendingBackslashes)) }
            [void]$sb.Append($ch)
        }
        $pendingBackslashes = 0
    }
    [void]$sb.Append(('\' * ($pendingBackslashes * 2)))
    [void]$sb.Append('"')
    return $sb.ToString()
}

# Quoting for cmd.exe wrappers (.cmd/.bat via `cmd /d /c`).
# cmd.exe does NOT understand CommandLineToArgvW backslash escaping, and it
# applies its own quote-stripping heuristic to the /c command line. The only
# reliable form is: cmd /d /c ""script" "arg1" "arg2"" (double-wrapped), with
# every argument in plain double quotes.
# Refused loudly instead of being silently corrupted:
#   - an embedded double quote: cmd.exe has NO escaping for `"` at all;
#   - a trailing backslash: cmd passes it literally, but the FINAL receiver
#     (node/powershell via CommandLineToArgvW) decodes \" as a literal quote,
#     merging neighbouring arguments. Fidelity across both layers is
#     impossible, so such arguments are rejected with a clear message;
#   - any % character: cmd.exe expands %VAR% (and lone %) even INSIDE
#     double quotes, so an argument containing % cannot be passed without
#     environment-dependent corruption. Callers must avoid % entirely
#     (e.g. pass long prompts via a UTF-8 temp file instead).
function ConvertTo-WinCmdArg {
    param([string]$Value)
    if ($Value -match '"') {
        throw "cmd.exe wrappers cannot receive arguments containing a double quote: '$Value'"
    }
    if ($Value.EndsWith('\')) {
        throw "cmd.exe wrappers cannot receive arguments ending with a backslash (would corrupt argument parsing downstream): '$Value'"
    }
    if ($Value -match '%') {
        throw "cmd.exe wrappers cannot receive arguments containing '%' (cmd expands %VAR% even inside quotes): '$Value'"
    }
    if ([string]::IsNullOrEmpty($Value)) { return '""' }
    return '"' + $Value + '"'
}

# ---------------------------------------------------------------------------
# Command resolution: PATH entries may be shims (.ps1/.cmd from npm) which
# System.Diagnostics.Process cannot start directly; wrap them in a shell.
# Returns @{ FilePath = <exe>; PrefixArgs = <args inserted before ours> }
# ---------------------------------------------------------------------------
function Resolve-Command {
    param([Parameter(Mandatory)][string]$Name)
    # Supported types are requested EXPLICITLY:
    #   Application    - real executables (.exe);
    #   ExternalScript - .ps1 shims (e.g. npm's opencode.ps1). A plain
    #                    -CommandType Application would exclude them and
    #                    make the .ps1 branch below unreachable.
    $candidates = @(Get-Command $Name -All -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandType -eq 'Application' -or $_.CommandType -eq 'ExternalScript' })
    if ($candidates.Count -eq 0) { return $null }
    # Take the first resolution result only (PATH order)
    $src = $candidates[0].Source
    switch -Regex ($src) {
        '\.ps1$' {
            return @{ FilePath = 'powershell.exe'; PrefixArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $src) }
        }
        '\.(cmd|bat)$' {
            # /d disables registry AutoRun scripts for this cmd.exe instance.
            # UseCmdQuoting: arguments must be quoted with cmd.exe rules
            # (double-wrapped command line), not CommandLineToArgvW rules.
            return @{ FilePath = 'cmd.exe'; PrefixArgs = @('/d', '/c', $src); UseCmdQuoting = $true }
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
    if ($resolved.ContainsKey('UseCmdQuoting')) {
        # cmd.exe wrapper: build /d /s /c ""script" "arg1" "arg2"" - see
        # ConvertTo-WinCmdArg for why CommandLineToArgvW quoting fails here.
        # /s makes cmd strip exactly the outer quote pair (predictable
        # handling of the surrounding quotes); /d disables registry AutoRun.
        $core = @($allArgs | Select-Object -Skip 2)   # skip the fixed /d /c
        $quoted = ($core | ForEach-Object { ConvertTo-WinCmdArg $_ }) -join ' '
        $psi.Arguments = '/d /s /c "' + $quoted + '"'
    }
    else {
        $psi.Arguments = ($allArgs | ForEach-Object { ConvertTo-WinArg $_ }) -join ' '
    }
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
            # Kill the whole process TREE: Process.Kill() alone leaves
            # grandchildren (e.g. node behind the opencode shim) alive.
            $prevEap = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try { & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null } catch { }
            $ErrorActionPreference = $prevEap
            try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
            return [pscustomobject]@{ ExitCode = $null; StdOut = $stdoutTask.Result; StdErr = $stderrTask.Result; TimedOut = $true }
        }
    }
    else {
        $proc.WaitForExit()
    }

    return [pscustomobject]@{ ExitCode = $proc.ExitCode; StdOut = $stdoutTask.Result; StdErr = $stderrTask.Result; TimedOut = $false }
}

# ---------------------------------------------------------------------------
# Model answer check: strip ANSI sequences, normalize lines, require the
# FINAL non-empty line to be exactly "PONG" (case-sensitive). "NOT PONG",
# "pong" or a multi-line blob containing PONG somewhere are rejected.
# ---------------------------------------------------------------------------
function Test-PongResponse {
    param([string]$Output)
    if ([string]::IsNullOrEmpty($Output)) { return $false }
    $clean = [regex]::Replace($Output, "\x1B\[[0-9;]*[A-Za-z]", '')
    $lines = @($clean -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($lines.Count -eq 0) { return $false }
    return ($lines[-1] -ceq 'PONG')
}

function Test-PathInside {
    # Is $Child the same as, or nested inside, $Parent?
    param([string]$Child, [string]$Parent)
    $c = [IO.Path]::GetFullPath($Child).TrimEnd('\') + '\'
    $p = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    return $c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)
}

# ---------------------------------------------------------------------------
# Configuration: load and validate BEFORE any process is started
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'LyServer dispatcher v0.2 (stage 1: checks + preview)' -ForegroundColor Cyan
Write-Host 'Mode: no changes to GitHub, branches, or repository files.' -ForegroundColor Cyan
Write-Host 'Side effects: log files in LogDir; `opencode run` model ping.' -ForegroundColor Cyan
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

# --- validation: required keys, types, ranges, path placement -------------
$validationErrors = @()
$requiredStringKeys = @(
    'RepoPath', 'GitHubRepo', 'ExpectedRemote', 'Model',
    'LabelReady', 'LabelInProgress', 'LabelReview',
    'LogDir', 'RunRootDir', 'LockDir'
)
foreach ($key in $requiredStringKeys) {
    if (-not $cfg.ContainsKey($key) -or [string]::IsNullOrWhiteSpace([string]$cfg[$key])) {
        $validationErrors += "missing or empty required key: $key"
    }
}
foreach ($key in @('ModelPingTimeoutSec', 'TaskTimeoutSec')) {
    if (-not $cfg.ContainsKey($key)) {
        $validationErrors += "missing required key: $key"
        continue
    }
    $parsed = 0
    if (-not [int]::TryParse([string]$cfg[$key], [ref]$parsed) -or $parsed -le 0) {
        $validationErrors += "must be a positive integer: $key = '$($cfg[$key])'"
    }
}
if ($validationErrors.Count -eq 0) {
    if ($cfg.GitHubRepo -notmatch '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$') {
        $validationErrors += "GitHubRepo must be 'owner/name': '$($cfg.GitHubRepo)'"
    }
    foreach ($key in @('RepoPath', 'LogDir', 'RunRootDir', 'LockDir')) {
        if (-not [IO.Path]::IsPathRooted([string]$cfg[$key])) {
            $validationErrors += "path must be absolute: $key = '$($cfg[$key])'"
        }
    }
    if ($validationErrors.Count -eq 0) {
        # Log/run/lock directories must never live inside the clone:
        # a log file there would make the tree dirty and self-sabotage.
        foreach ($key in @('LogDir', 'RunRootDir', 'LockDir')) {
            if (Test-PathInside -Child ([string]$cfg[$key]) -Parent ([string]$cfg.RepoPath)) {
                $validationErrors += "$key must be OUTSIDE the repository ($($cfg.RepoPath)): '$($cfg[$key])'"
            }
        }
    }
}
if ($validationErrors.Count -gt 0) {
    Write-Host 'STOP: invalid configuration:' -ForegroundColor Red
    $validationErrors | ForEach-Object { Write-Host ("  - {0}" -f $_) -ForegroundColor Red }
    exit 1
}

# --- log directory: create and verify writability BEFORE anything else ----
try {
    if (-not (Test-Path -LiteralPath $cfg.LogDir -PathType Container)) {
        New-Item -ItemType Directory -Path $cfg.LogDir -Force | Out-Null
    }
    $script:LogFile = Join-Path $cfg.LogDir ('dispatcher-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Set-Content -LiteralPath $script:LogFile -Value '' -Encoding UTF8 -ErrorAction Stop
}
catch {
    Write-Host ("STOP: cannot write logs to '{0}': {1}" -f $cfg.LogDir, $_.Exception.Message) -ForegroundColor Red
    exit 1
}

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
    $resolvedTool = Resolve-Command -Name $toolName
    if (-not $resolvedTool) { Stop-Dispatcher ("Required tool not found in PATH: {0}" -f $toolName) }
    Write-Log 'OK' ("Tool available: {0} -> {1}" -f $toolName, $resolvedTool.FilePath)
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
#    gh api performs GET by default (read-only) for this endpoint.
# ---------------------------------------------------------------------------
$repoApi = Invoke-Native -Tool 'gh' -ArgumentList @('api', ("repos/{0}" -f $cfg.GitHubRepo), '--jq', '.default_branch')
if ($repoApi.ExitCode -ne 0) {
    Stop-Dispatcher ('GitHub API is unreachable for {0}. StdErr: {1}' -f $cfg.GitHubRepo, $repoApi.StdErr.Trim())
}
$defaultBranch = $repoApi.StdOut.Trim()
if ([string]::IsNullOrWhiteSpace($defaultBranch)) { Stop-Dispatcher 'GitHub returned an empty default branch.' }
Write-Log 'OK' ("GitHub API reachable; default branch: {0}" -f $defaultBranch)

# ---------------------------------------------------------------------------
# Preflight 5: clean working tree of the MAIN clone.
#    MUST run before the model ping: the ping launches an external agent,
#    which must never start against a dirty tree.
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
# Preflight 6: model availability (exact-answer ping). On failure the
# dispatcher stops WITHOUT touching any Issue state (acceptance criterion 4).
# ---------------------------------------------------------------------------
if ($SkipModelPing) {
    Write-Log 'WARN' 'Model ping SKIPPED by -SkipModelPing switch. Model availability is NOT verified.'
}
else {
    Write-Log 'INFO' ("Pinging model {0} (timeout {1}s)..." -f $cfg.Model, $cfg.ModelPingTimeoutSec)
    $pingPrompt = 'Reply with exactly the single word: PONG'
    $ping = Invoke-Native -Tool 'opencode' -ArgumentList @('run', '--model', $cfg.Model, $pingPrompt) -TimeoutSec ([int]$cfg.ModelPingTimeoutSec)
    if ($ping.TimedOut) {
        Stop-Dispatcher ('Model ping TIMED OUT after {0}s (process tree killed). Task state untouched.' -f $cfg.ModelPingTimeoutSec)
    }
    if ($ping.ExitCode -ne 0) {
        Stop-Dispatcher ('Model ping FAILED (exit {0}): {1}. Task state untouched.' -f $ping.ExitCode, $ping.StdErr.Trim())
    }
    if (-not (Test-PongResponse -Output $ping.StdOut)) {
        $normalized = ($ping.StdOut -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) -join ' | '
        if ($normalized.Length -gt 200) { $normalized = $normalized.Substring(0, 200) + '...' }
        Stop-Dispatcher ("Model ping returned unexpected answer (normalized: '{0}'). Task state untouched." -f $normalized)
    }
    Write-Log 'OK' 'Model ping succeeded (exact answer PONG).'
}

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
    Write-Host ("Model:     {0}{1}" -f $cfg.Model, $(if ($SkipModelPing) { ' [NOT VERIFIED - ping skipped]' } else { '' }))
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

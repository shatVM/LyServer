#requires -Version 5.1
<#
.SYNOPSIS
    Stage 1 test harness for dispatcher.ps1 (PowerShell 5.1).
.DESCRIPTION
    Runs intentional negative and positive scenarios against the REAL
    dispatcher functions (extracted via AST from dispatcher.ps1) and the
    real script as a child process. All temp state lives outside the
    repository; the harness verifies GitHub state is unchanged at the end.
    The REAL repository is never a target of a run: Stage 1 executes
    against a throwaway local repository, Stage 2 against its own temp
    repositories. The real repository is only compared with a baseline
    snapshot - no commit, stash, skip-worktree or assume-unchanged is ever
    required or used (checked explicitly in T0/T34).
    Usage: powershell -NoProfile -ExecutionPolicy Bypass -File dispatcher.tests.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$DispatcherPath = Join-Path $PSScriptRoot 'dispatcher.ps1'
if (-not (Test-Path -LiteralPath $DispatcherPath)) { Write-Host "FAIL: dispatcher.ps1 not found next to tests"; exit 1 }

$script:Results = @()
function Test-Case {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    $script:Results += [pscustomobject]@{ Name = $Name; Passed = $Passed; Detail = $Detail }
    $color = if ($Passed) { 'Green' } else { 'Red' }
    $mark = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host ("{0}  {1}  {2}" -f $mark, $Name, $Detail) -ForegroundColor $color
}

# --- extract functions from dispatcher.ps1 (test the real code) -----------
$ast = [System.Management.Automation.Language.Parser]::ParseFile($DispatcherPath, [ref]$null, [ref]$null)
$fnAsts = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true))
# Write-Log is a dependency of the Stage 2 lock functions: extract it too and
# keep its file sink off ($script:LogFile = $null -> console only).
$script:LogFile = $null
foreach ($fnName in @(
    'ConvertTo-WinArg', 'ConvertTo-WinCmdArg', 'Resolve-Command', 'Invoke-Native', 'Test-PongResponse', 'Test-PathInside',
    # Stage 2
    'Write-Log',
    'Test-ProcessAlive', 'Get-DispatcherLockInfo', 'Enter-DispatcherLock', 'Exit-DispatcherLock',
    'Get-VerifiedBaseSha', 'Test-BaseShaRequirement', 'Get-UntrustedFindings',
    'New-TaskWorktree', 'Remove-TaskWorktree', 'Get-WorktreeChanges',
    # Issue #9: publishing
    'New-Stage2ReportComment', 'Save-LocalIssueReport', 'Publish-IssueReport', 'Verify-IssueForPublish'
)) {
    $match = @($fnAsts | Where-Object { $_.Name -eq $fnName })
    if ($match.Count -eq 0) { Write-Host ("FAIL: function {0} not found in dispatcher.ps1" -f $fnName); exit 1 }
    Invoke-Expression $match[0].Extent.Text
}

# --- temp workspace (outside the repository) ------------------------------
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('lyserver-dispatcher-tests-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

# The REAL repository: only ever compared against the baseline captured in
# T0. Pending edits by the developer are fine - the suite must run without
# commits, stashes or index flags (skip-worktree / assume-unchanged are
# forbidden and are checked explicitly in T0 and T34).
$realRepoPath = Join-Path $HOME 'Documents\LyServer'
# Single source of truth for the repository under test; Get-GhJsonSnapshot
# reads $script:GitHubRepo, so the suite cannot silently switch repos.
$GitHubRepo = 'shatVM/LyServer'

# === T0: baseline of the REAL repository + preparation of a TEMPORARY =====
#     stage-1 repository.
#     (The old T0 refused to run against a dirty tree, which forced a
#      commit/stash - or an index flag - just to run the tests. The
#      dispatcher never runs against the real repository anymore, so a
#      dirty developer tree is harmless: all we require is that the suite
#      leaves the real repository EXACTLY as it found it, verified in T34.)
if (-not (Test-Path -LiteralPath $realRepoPath -PathType Container)) {
    Write-Host ("FAIL T0: real repository not found: {0}" -f $realRepoPath) -ForegroundColor Red
    exit 1
}
$realStatusBefore = & git -C $realRepoPath status --porcelain | Out-String
$realWorktreesBefore = @((& git -C $realRepoPath worktree list --porcelain | Out-String) -split "`r?`n" | Where-Object { $_ -match '^worktree ' }).Count
$realHiddenBefore = @(& git -C $realRepoPath ls-files -v | Where-Object { $_ -cmatch '^S\s' -or $_ -cmatch '^[a-z]' })
if ($LASTEXITCODE -ne 0) {
    Write-Host 'FAIL T0: cannot read the real repository with git' -ForegroundColor Red
    exit 1
}
Test-Case 'T0 real repository baseline captured, no skip-worktree/assume-unchanged flags' ($realHiddenBefore.Count -eq 0) ("hidden index entries: {0}" -f $realHiddenBefore.Count)

# Temporary stage-1 repository: a throwaway local git repo with the origin
# URL the config expects. Stage 1 only reads it (work tree / remote / status).
$repoPath = Join-Path $testRoot 'stage1-repo'
New-Item -ItemType Directory -Path $repoPath -Force | Out-Null
$null = & git -C $repoPath init 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host ("FAIL T0: cannot create the temporary stage-1 repository: {0}" -f $repoPath) -ForegroundColor Red
    exit 1
}
$null = & git -C $repoPath remote add origin 'https://github.com/shatVM/LyServer.git' 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host 'FAIL T0: cannot set origin on the temporary stage-1 repository' -ForegroundColor Red
    exit 1
}
$stage1Status = & git -C $repoPath status --porcelain | Out-String
Test-Case 'T0 temporary stage-1 repository ready (clean, expected origin)' ([string]::IsNullOrWhiteSpace($stage1Status)) $repoPath

# === Snapshot of GitHub state BEFORE the suite (used by T10) ==============
# Get-GhJsonSnapshot THROWS on gh failure, empty output or invalid JSON,
# so a broken snapshot can never be mistaken for "state unchanged".
function Get-GhJsonSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('Issues', 'PullRequests')]
        [string]$Kind
    )

    if ($Kind -eq 'Issues') {
        $raw = & gh issue list `
            --repo $script:GitHubRepo `
            --state open `
            --limit 1000 `
            --json number,title,labels 2>&1
    }
    else {
        $raw = & gh pr list `
            --repo $script:GitHubRepo `
            --state all `
            --limit 1000 `
            --json number,title,url 2>&1
    }

    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
        throw "gh $Kind snapshot failed with exit code $exitCode. Output: $($raw -join "`n")"
    }

    $jsonText = $raw -join "`n"

    if ([string]::IsNullOrWhiteSpace($jsonText)) {
        throw "gh $Kind snapshot returned empty output."
    }

    try {
        # PS 5.1 quirk (same as in dispatcher.ps1): ConvertFrom-Json returns
        # a JSON array as ONE Object[] element; flatten it into real items.
        $items = @(($jsonText | ConvertFrom-Json) | ForEach-Object { $_ })
    }
    catch {
        throw "gh $Kind snapshot returned invalid JSON: $($_.Exception.Message)"
    }

    if ($items.Count -eq 0) {
        throw "gh $Kind snapshot returned no items (unexpected empty listing)."
    }

    if ($Kind -eq 'Issues') {
        $normalized = @(
            foreach ($item in $items) {
                [PSCustomObject]@{
                    number = [int]$item.number
                    title  = [string]$item.title
                    labels = @(
                        $item.labels |
                            ForEach-Object { [string]$_.name } |
                            Sort-Object
                    )
                }
            }
        )
    }
    else {
        $normalized = @(
            foreach ($item in $items) {
                [PSCustomObject]@{
                    number = [int]$item.number
                    title  = [string]$item.title
                    url    = [string]$item.url
                }
            }
        )
    }

    $normalized = @(
        $normalized | Sort-Object number
    )

    return ConvertTo-Json -InputObject @($normalized) -Depth 10 -Compress
}

$prsBefore = Get-GhJsonSnapshot -Kind PullRequests
$issuesBefore = Get-GhJsonSnapshot -Kind Issues

function New-TestConfig {
    # Builds a valid config psd1 in $testRoot, with optional overrides.
    param([hashtable]$Overrides = @{})
    $cfg = @{
        RepoPath            = $repoPath
        GitHubRepo          = 'shatVM/LyServer'
        ExpectedRemote      = 'https://github.com/shatVM/LyServer.git'
        Model               = 'opencode/mimo-v2.6-flash-free'
        ModelPingTimeoutSec = 120
        TaskTimeoutSec      = 1800
        LabelReady          = 'ready-for-opencode'
        LabelInProgress     = 'in-progress'
        LabelReview         = 'opencode-review'
        LogDir              = (Join-Path $testRoot 'logs')
        RunRootDir          = (Join-Path $testRoot 'runs')
        LockDir             = (Join-Path $testRoot 'locks')
    }
    foreach ($k in $Overrides.Keys) { $cfg[$k] = $Overrides[$k] }
    $path = Join-Path $testRoot ('cfg-{0}.psd1' -f [guid]::NewGuid().ToString('N').Substring(0, 6))
    $lines = @('@{')
    foreach ($k in $cfg.Keys) { $lines += ("    {0} = '{1}'" -f $k, $cfg[$k]) }
    $lines += '}'
    Set-Content -LiteralPath $path -Value ($lines -join "`r`n") -Encoding UTF8
    return $path
}

function Invoke-Dispatcher {
    param([string]$ConfigPath, [switch]$SkipModelPing, [switch]$Stage2)
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $DispatcherPath)
    if ($ConfigPath) { $argList += @('-ConfigPath', $ConfigPath) }
    if ($SkipModelPing) { $argList += '-SkipModelPing' }
    if ($Stage2) { $argList += '-Stage2' }
    $out = & powershell.exe @argList 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out -join "`n") }
}

Write-Host ''
Write-Host ('Test workspace: {0}' -f $testRoot) -ForegroundColor Cyan
Write-Host ''

# === T1: argument quoting round-trip through a REAL child process:
#         powershell.exe -File echo-args.ps1 writes received $args to a file;
#         we compare what the child actually received, not the string builder
$echoScript = Join-Path $testRoot 'echo-args.ps1'
Set-Content -LiteralPath $echoScript -Encoding UTF8 -Value @'
param([string]$OutFile)
[System.IO.File]::WriteAllLines($OutFile, $args, (New-Object System.Text.UTF8Encoding($false)))
'@
# T1 covers the empty argument: it must round-trip as an empty string,
# not get lost when the command line is assembled.
$expectedArgs = @('plain', '', 'with space', 'quo"te', 'trail\', 'back\slash', 'mix \"quoted\" tail', 'Кирилиця перевірка', 'tab	value')
$outFile = Join-Path $testRoot 'args-out.txt'
$run = Invoke-Native -Tool 'powershell.exe' -ArgumentList (@('-NoProfile', '-File', $echoScript, $outFile) + $expectedArgs)
$actualArgs = if (Test-Path $outFile) { @([IO.File]::ReadAllLines($outFile)) } else { @() }
$t1ok = ($run.ExitCode -eq 0) -and ($actualArgs.Count -eq $expectedArgs.Count)
if ($t1ok) {
    for ($i = 0; $i -lt $expectedArgs.Count; $i++) { if ($actualArgs[$i] -cne $expectedArgs[$i]) { $t1ok = $false; break } }
}
Test-Case 'T1 quoting round-trip (empty/space/quotes/backslash/Cyrillic/tab)' $t1ok ("received {0}/{1} args" -f $actualArgs.Count, $expectedArgs.Count)

# === T2: PONG answer exactness (unit on the real function)
$pongCases = @(
    @{ In = "PONG`n";                   Expect = $true;  Label = 'exact single line' }
    @{ In = "  PONG  `r`n";             Expect = $true;  Label = 'trimmed whitespace' }
    @{ In = "NOT PONG`n";               Expect = $false; Label = 'NOT PONG rejected' }
    @{ In = "pong`n";                   Expect = $false; Label = 'lowercase rejected' }
    @{ In = "PONG`nextra text`n";       Expect = $false; Label = 'multi-line blob rejected' }
    # PS 5.1 has no `e escape; build ESC via [char]27
    @{ In = ([char]27 + '[32mPONG' + [char]27 + '[0m' + "`n"); Expect = $true;  Label = 'ANSI-wrapped accepted' }
    @{ In = '';                          Expect = $false; Label = 'empty rejected' }
    @{ In = "`n`n";                      Expect = $false; Label = 'blank-only rejected' }
)
$pongOk = $true
foreach ($c in $pongCases) {
    $got = Test-PongResponse -Output $c.In
    if ($got -ne $c.Expect) { $pongOk = $false; Write-Host ("    PONG case '{0}': expected {1}, got {2}" -f $c.Label, $c.Expect, $got) -ForegroundColor Yellow }
}
Test-Case 'T2 PONG exact-answer check (8 cases)' $pongOk 'NOT PONG/pong/multi-line rejected'

# === T3: Resolve-Command for a missing tool returns $null
$nullResolved = Resolve-Command -Name 'definitely-not-a-tool-xyz'
Test-Case 'T3 Resolve-Command returns null for missing tool' ($null -eq $nullResolved) ''

# === T4: missing config file
$run = Invoke-Dispatcher -ConfigPath (Join-Path $testRoot 'no-such-config.psd1')
Test-Case 'T4 missing config -> safe stop' ($run.ExitCode -eq 1 -and $run.Output -match 'config not found') ("exit {0}" -f $run.ExitCode)

# === T5: invalid configs (missing key / negative timeout / LogDir inside repo)
$bad1 = New-TestConfig -Overrides @{ Model = '' }
$run = Invoke-Dispatcher -ConfigPath $bad1
Test-Case 'T5a empty required key rejected' ($run.ExitCode -eq 1 -and $run.Output -match 'missing or empty required key: Model') ("exit {0}" -f $run.ExitCode)

$bad2 = New-TestConfig -Overrides @{ ModelPingTimeoutSec = '-5' }
$run = Invoke-Dispatcher -ConfigPath $bad2
Test-Case 'T5b negative timeout rejected' ($run.ExitCode -eq 1 -and $run.Output -match 'positive integer') ("exit {0}" -f $run.ExitCode)

$bad3 = New-TestConfig -Overrides @{ LogDir = (Join-Path $repoPath 'logs-inside-repo') }
$run = Invoke-Dispatcher -ConfigPath $bad3
Test-Case 'T5c LogDir inside repository rejected' ($run.ExitCode -eq 1 -and $run.Output -match 'must be OUTSIDE the repository') ("exit {0}" -f $run.ExitCode)

# === T6: dirty working tree -> stop BEFORE the model ping (order check)
$dirtyProbe = Join-Path $repoPath 'zz-dirty-probe.tmp'
Set-Content -LiteralPath $dirtyProbe -Value 'test' -Encoding UTF8
try {
    $cfgDirty = New-TestConfig   # valid config; own LogDir in temp
    $run = Invoke-Dispatcher -ConfigPath $cfgDirty
    $logFile = @()
    $dirtyLogDir = Join-Path $testRoot 'logs'
    if (Test-Path $dirtyLogDir) { $logFile = @(Get-ChildItem $dirtyLogDir -Filter '*.log' | Sort-Object LastWriteTime | Select-Object -Last 1) }
    $logText = if ($logFile.Count -gt 0) { [IO.File]::ReadAllText($logFile[0].FullName) } else { '' }
    $stopped = ($run.ExitCode -eq 1 -and $run.Output -match 'must be clean')
    $noPing = ($logText -notmatch 'Pinging model')
    Test-Case 'T6a dirty tree -> safe stop' $stopped ("exit {0}" -f $run.ExitCode)
    Test-Case 'T6b dirty tree -> NO model ping happened (order)' $noPing 'checked log of this run'
}
finally {
    Remove-Item -LiteralPath $dirtyProbe -Force -ErrorAction SilentlyContinue
}

# === T7: model timeout -> safe stop (kills process tree)
$cfgTimeout = New-TestConfig -Overrides @{ ModelPingTimeoutSec = '1' }
$run = Invoke-Dispatcher -ConfigPath $cfgTimeout
Test-Case 'T7 model ping timeout -> safe stop' ($run.ExitCode -eq 1 -and $run.Output -match 'TIMED OUT') ("exit {0}" -f $run.ExitCode)

# === T8: unavailable model -> safe stop (not treated as success)
$cfgBadModel = New-TestConfig -Overrides @{ Model = 'opencode/nonexistent-model-xyz' }
$run = Invoke-Dispatcher -ConfigPath $cfgBadModel
Test-Case 'T8 unavailable model -> safe stop' ($run.ExitCode -eq 1 -and $run.Output -match 'FAILED') ("exit {0}" -f $run.ExitCode)

# === T9: full preview run (real model ping) succeeds
$cfgOk = New-TestConfig
$run = Invoke-Dispatcher -ConfigPath $cfgOk
Test-Case 'T9 full preview run -> exit 0' ($run.ExitCode -eq 0 -and $run.Output -match 'Preview completed') ("exit {0}" -f $run.ExitCode)

# === T10: GitHub state unchanged by the whole suite.
#     SCOPE OF THIS CHECK (be precise): it compares normalized JSON listings
#       (a) OPEN issues with fields number,title,labels, and
#       (b) PRs in ALL states with fields number,title,url,
#     captured before the suite vs after it, via Get-GhJsonSnapshot (which
#     throws on gh failure, empty output or invalid JSON, and sorts items
#     by number and labels by name so the comparison is order-insensitive).
#     It does NOT snapshot: closed issues, issue bodies/comments, PR
#     diff/review state, labels metadata, workflow runs, or any repo
#     content beyond the git working tree check in T10d. It proves the
#     suite created no new PRs and changed no open issues/labels - it is
#     not a byte-level snapshot of the entire GitHub account state.
$issuesAfter = Get-GhJsonSnapshot -Kind Issues
$prsAfter = Get-GhJsonSnapshot -Kind PullRequests
$issuesNow = @(($issuesAfter | ConvertFrom-Json) | ForEach-Object { $_ })
function Get-LabelNames($issue) { return @($issue.labels | ForEach-Object { $_ }) }
$issue3 = @($issuesNow | Where-Object { $_.number -eq 3 })
$issue2 = @($issuesNow | Where-Object { $_.number -eq 2 })
$labelsSanity = ($issue3.Count -eq 1 -and (Get-LabelNames $issue3[0]) -contains 'in-progress' -and
             $issue2.Count -eq 1 -and (Get-LabelNames $issue2[0]) -contains 'ready-for-opencode')
$issuesUnchanged = ($issuesBefore -ceq $issuesAfter)
$prsUnchanged = ($prsBefore -ceq $prsAfter)
Test-Case 'T10a open Issues unchanged (normalized snapshot, before vs after)' $issuesUnchanged 'gh exit code + JSON validity enforced'
Test-Case 'T10b PRs unchanged (normalized snapshot, before vs after)' $prsUnchanged 'gh exit code + JSON validity enforced'
Test-Case 'T10c label sanity: #3 in-progress, #2 ready' $labelsSanity ''
$gitStatus = & git -C $repoPath status --porcelain | Out-String
$realStatusT10 = & git -C $realRepoPath status --porcelain | Out-String
Test-Case 'T10d temporary stage-1 repository clean (probe removed)' ([string]::IsNullOrWhiteSpace($gitStatus)) 'no probe/temp files left'
Test-Case 'T10e real repository unchanged vs baseline (no commits, no index flags)' ($realStatusT10 -ceq $realStatusBefore) ("identical: {0}" -f ($realStatusT10 -ceq $realStatusBefore))

# === T11: Test-PathInside boundary rules (unit on the real function)
$pathCases = @(
    @{ Child = 'C:\LyServerLogs';              Parent = 'C:\LyServer';        Expect = $false; Label = 'sibling prefix is NOT inside' }
    @{ Child = 'C:\LyServer\logs';             Parent = 'C:\LyServer';        Expect = $true;  Label = 'true subdirectory is inside' }
    @{ Child = 'C:\lyserver\LOGS';             Parent = 'C:\LYSERVER';        Expect = $true;  Label = 'case-insensitive match' }
    @{ Child = 'C:\LyServer';                  Parent = 'C:\LyServer\';       Expect = $true;  Label = 'same path, trailing sep on parent' }
    @{ Child = 'C:\LyServer\';                 Parent = 'C:\LyServer';        Expect = $true;  Label = 'same path, trailing sep on child' }
    @{ Child = 'C:\LyServer';                  Parent = 'C:\LyServer\sub';    Expect = $false; Label = 'parent nested in child' }
    @{ Child = 'C:\Other';                     Parent = 'C:\LyServer';        Expect = $false; Label = 'unrelated path' }
)
$pathOk = $true
foreach ($c in $pathCases) {
    $got = Test-PathInside -Child $c.Child -Parent $c.Parent
    if ($got -ne $c.Expect) { $pathOk = $false; Write-Host ("    path case '{0}': expected {1}, got {2}" -f $c.Label, $c.Expect, $got) -ForegroundColor Yellow }
}
Test-Case 'T11 Test-PathInside boundaries (7 cases)' $pathOk 'sibling prefix C:\LyServerLogs excluded'

# === T12: timeout kills the process TREE, spares unrelated processes,
#           and reports the timeout instead of masking it
$sentinel = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 300') -PassThru -WindowStyle Hidden
$treeTarget = Join-Path $testRoot 'tree-target.ps1'
$pidFile = Join-Path $testRoot 'grandchild.pid'
$treeTargetBody = @'
$gc = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 300') -PassThru -WindowStyle Hidden
Set-Content -LiteralPath '__PIDFILE__' -Value $gc.Id
Start-Sleep 300
'@ -replace '__PIDFILE__', $pidFile
Set-Content -LiteralPath $treeTarget -Value $treeTargetBody -Encoding UTF8
try {
    $treeRun = Invoke-Native -Tool 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $treeTarget) -TimeoutSec 5
    $reportedTimeout = ($treeRun.TimedOut -eq $true)
    $gcId = if (Test-Path $pidFile) { [int]([IO.File]::ReadAllText($pidFile).Trim()) } else { 0 }
    $grandchildDead = $false
    if ($gcId -gt 0) {
        Start-Sleep -Milliseconds 500
        try { $left = Get-Process -Id $gcId -ErrorAction Stop; $null = $left } catch { $grandchildDead = $true }
    }
    Test-Case 'T12a timeout reported as TimedOut (reason not masked)' $reportedTimeout ''
    Test-Case 'T12b grandchild process killed by tree kill' ($gcId -gt 0 -and $grandchildDead) ("grandchild pid {0}" -f $gcId)
    $sentinelAlive = $false
    try { $s = Get-Process -Id $sentinel.Id -ErrorAction Stop; $sentinelAlive = ($s.Id -eq $sentinel.Id) } catch { }
    Test-Case 'T12c unrelated sentinel process survives' $sentinelAlive ("sentinel pid {0}" -f $sentinel.Id)
}
finally {
    try { Stop-Process -Id $sentinel.Id -Force -ErrorAction SilentlyContinue } catch { }
    Remove-Item -LiteralPath $pidFile, $treeTarget -Force -ErrorAction SilentlyContinue
}

# === T13: full-run ORDER of stages, read from the real log of T9
#     (T6-T9 already execute dispatcher.ps1 as a whole child process;
#      this asserts the execution order inside that full run)
$latestLogPath = $null
$logDirT = Join-Path $testRoot 'logs'
if (Test-Path $logDirT) {
    $allLogs = @(Get-ChildItem $logDirT -Filter '*.log' | Sort-Object LastWriteTime)
    if ($allLogs.Count -gt 0) { $latestLogPath = $allLogs[-1].FullName }
}
function Get-LineIndex($text, $pattern) {
    $lines = @($text -split "`r?`n")
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match $pattern) { return $i } }
    return -1
}
$logTextT = if ($latestLogPath) { [IO.File]::ReadAllText($latestLogPath) } else { '' }
$iTree = Get-LineIndex $logTextT 'working tree is clean'
$iPing = Get-LineIndex $logTextT 'Pinging model'
$iPong = Get-LineIndex $logTextT 'Model ping succeeded'
$iDisc = Get-LineIndex $logTextT 'Found \d+ candidate'
$iPrev = Get-LineIndex $logTextT 'Preview completed'
$orderOk = ($iTree -ge 0 -and $iPing -gt $iTree -and $iPong -gt $iPing -and $iDisc -gt $iPong -and $iPrev -gt $iDisc)
Test-Case 'T13 full run order: tree -> ping -> pong -> discovery -> preview' $orderOk ("lines {0}<{1}<{2}<{3}<{4}" -f $iTree, $iPing, $iPong, $iDisc, $iPrev)

# === T14: REAL .cmd wrapper launch through cmd.exe /d /c
#     The wrapper mirrors real npm-style .cmd shims: it forwards %* to
#     powershell.exe -File echo-args.ps1. This exercises cmd.exe
#     metacharacter parsing (&, parens), path-with-space quoting,
#     empty args and Cyrillic end-to-end. NOTE: embedded double quotes,
#     trailing backslashes and % CANNOT cross the cmd.exe -> final-receiver
#     boundary faithfully - ConvertTo-WinCmdArg refuses all three; refusals
#     are tested in T14b/T14c/T14d.
$wrapDir = Join-Path $testRoot 'wrap dir'   # space in the path on purpose
New-Item -ItemType Directory -Path $wrapDir -Force | Out-Null
$wrapCmd = Join-Path $wrapDir 'fakecmd.cmd'
Set-Content -LiteralPath $wrapCmd -Encoding ASCII -Value @"
@echo off
powershell.exe -NoProfile -File "$echoScript" %*
"@
$env:Path = "$wrapDir;$env:Path"
$cmdOutFile = Join-Path $testRoot 'cmd-args-out.txt'
$cmdArgs = @($cmdOutFile, 'with space', 'a&b', 'x(y)', 'mid\path', 'Кирилиця', '')
$run = Invoke-Native -Tool 'fakecmd.cmd' -ArgumentList $cmdArgs
$cmdActual = if (Test-Path $cmdOutFile) { @([IO.File]::ReadAllLines($cmdOutFile)) } else { @() }
$cmdOk = ($run.ExitCode -eq 0) -and ($cmdActual.Count -eq ($cmdArgs.Count - 1))
if ($cmdOk) {
    $expectedTail = @($cmdArgs | Select-Object -Skip 1)
    for ($i = 0; $i -lt $expectedTail.Count; $i++) { if ($cmdActual[$i] -cne $expectedTail[$i]) { $cmdOk = $false; break } }
}
Test-Case 'T14 .cmd wrapper round-trip (space/&/parens/mid-backslash/empty/Cyrillic, dir with space)' $cmdOk ("received {0}/{1} args" -f $cmdActual.Count, ($cmdArgs.Count - 1))

# T14b: an argument containing a double quote must be REFUSED, not corrupted
$t14b = $false
try {
    $null = Invoke-Native -Tool 'fakecmd.cmd' -ArgumentList @($cmdOutFile, 'quo"te')
}
catch { $t14b = ($_.Exception.Message -match 'double quote') }
Test-Case 'T14b .cmd wrapper refuses embedded double quote (no silent corruption)' $t14b 'cmd.exe has no escaping for "'

# T14c: an argument ending with a backslash must be REFUSED, not merged
$t14c = $false
try {
    $null = Invoke-Native -Tool 'fakecmd.cmd' -ArgumentList @($cmdOutFile, 'trail\')
}
catch { $t14c = ($_.Exception.Message -match 'backslash') }
Test-Case 'T14c .cmd wrapper refuses trailing backslash (would merge args)' $t14c 'two-layer parse boundary'

# T14d: an argument containing % must be REFUSED - cmd.exe expands %VAR%
# even inside double quotes, so passing it would corrupt the value in an
# environment-dependent way.
$t14d = $false
try {
    $null = Invoke-Native -Tool 'fakecmd.cmd' -ArgumentList @($cmdOutFile, 'a%PATH%b')
}
catch { $t14d = ($_.Exception.Message -match "cannot receive arguments containing '%'") }
Test-Case 'T14d .cmd wrapper refuses % (cmd expands %VAR% inside quotes)' $t14d 'no environment-dependent corruption'

# T14e: the wrapper PATH goes through the SAME ConvertTo-WinCmdArg
# validation as the arguments (Invoke-Native keeps $src in $core and only
# skips the fixed /d /c). A wrapper living in a directory with % in its
# name must be refused before any process is started.
$wrapDirPct = Join-Path $testRoot 'pct%dir'
New-Item -ItemType Directory -Path $wrapDirPct -Force | Out-Null
$wrapCmdPct = Join-Path $wrapDirPct 'fakepct.cmd'
Set-Content -LiteralPath $wrapCmdPct -Encoding ASCII -Value "@echo off`r`necho ran"
$env:Path = "$wrapDirPct;$env:Path"
$t14e = $false
try {
    $null = Invoke-Native -Tool 'fakepct.cmd' -ArgumentList @('x')
}
catch {
    # the message must cite the PATH (fakepct), not an argument
    $t14e = ($_.Exception.Message -match "containing '%'" -and $_.Exception.Message -match 'fakepct')
}
Test-Case 'T14e .cmd wrapper PATH with % refused (same validation as args)' $t14e 'no process started'

# === T15: Resolve-Command handles every supported command type explicitly
$rExe = Resolve-Command -Name 'powershell.exe'
$rCmd = Resolve-Command -Name 'fakecmd.cmd'
$ps1Wrap = Join-Path $wrapDir 'fakeps.ps1'
Set-Content -LiteralPath $ps1Wrap -Encoding UTF8 -Value '"ps1-wrapper-ran"'
$t15a = ($null -ne $rExe -and $rExe.FilePath -match 'powershell\.exe$' -and $rExe.PrefixArgs.Count -eq 0)
$t15b = ($null -ne $rCmd -and $rCmd.FilePath -eq 'cmd.exe' -and ($rCmd.PrefixArgs -join ' ') -eq ('/d /c ' + $wrapCmd))
$rPs1 = Resolve-Command -Name 'fakeps'
$t15c = ($null -ne $rPs1 -and $rPs1.FilePath -eq 'powershell.exe' -and ($rPs1.PrefixArgs -contains '-File') -and ($rPs1.PrefixArgs -contains $ps1Wrap))
Test-Case 'T15a Resolve-Command .exe type (direct, no prefix)' $t15a ''
Test-Case 'T15b Resolve-Command .cmd type (cmd.exe /d /c)' $t15b ''
Test-Case 'T15c Resolve-Command .ps1 type (powershell -File)' $t15c ''

# =============================================================================
# STAGE 2 TESTS (T16-T34)
# Everything below runs against TEMPORARY local git repositories and fake
# agents. The real GitHub project is never touched: no push, no PR, no label
# or issue mutations, and no real OpenCode session is started.
# =============================================================================

# --- Stage 2 unit: lock lifecycle -------------------------------------------
$lockDirT16 = Join-Path $testRoot 't16-locks'
$lockA = Enter-DispatcherLock -LockDir $lockDirT16 -Name 't16' -StaleSec 900
$t16a = Test-Path -LiteralPath $lockA.Path
$t16b = $false
try { $null = Enter-DispatcherLock -LockDir $lockDirT16 -Name 't16' -StaleSec 900 }
catch { $t16b = ($_.Exception.Message -match 'another dispatcher instance is active') }
# Stale lock: an old file whose PID is not running -> archived + reclaimed
$stalePath = Join-Path $lockDirT16 't16-stale.lock'
Set-Content -LiteralPath $stalePath -Value ("pid=999999`r`nhost={0}`r`ncreated=old" -f $env:COMPUTERNAME) -Encoding UTF8
(Get-Item -LiteralPath $stalePath).LastWriteTime = (Get-Date).AddHours(-3)
$lockB = Enter-DispatcherLock -LockDir $lockDirT16 -Name 't16-stale' -StaleSec 900
$archivedCount = @(Get-ChildItem $lockDirT16 -Filter 't16-stale.lock.stale-*').Count
$releasedA = Exit-DispatcherLock -Lock $lockA
$releasedB = Exit-DispatcherLock -Lock $lockB
$t16c = ($archivedCount -ge 1 -and -not (Test-Path -LiteralPath $lockB.Path))
Test-Case 'T16a lock acquired and second acquire refused (parallel protection)' ($t16a -and $t16b) ''
Test-Case 'T16b stale lock archived (not deleted) and reclaimed' $t16c ("archived {0}" -f $archivedCount)
Test-Case 'T16c lock released on exit' ($releasedA -and $releasedB -and -not (Test-Path -LiteralPath $lockA.Path)) ''

# --- Stage 2 fixture: temporary local git repo + fake agents -----------------
$gitRepoT = Join-Path $testRoot 't2x-repo'
$fakeBin = Join-Path $testRoot 'fakebin'
New-Item -ItemType Directory -Path $gitRepoT, $fakeBin -Force | Out-Null
& git -C $gitRepoT init 2>&1 | Out-Null
& git -C $gitRepoT symbolic-ref HEAD refs/heads/main 2>&1 | Out-Null
Set-Content -LiteralPath (Join-Path $gitRepoT 'seed.txt') -Value 'seed' -Encoding UTF8
& git -C $gitRepoT add seed.txt 2>&1 | Out-Null
& git -C $gitRepoT -c user.email=tests@example.invalid -c user.name=Tests commit -m 'seed' 2>&1 | Out-Null
$baseShaT = (& git -C $gitRepoT rev-parse HEAD | Out-String).Trim()
$gitCleanBefore = [string]::IsNullOrWhiteSpace((& git -C $gitRepoT status --porcelain | Out-String))

# Fake agents: launched exactly like the real one (name from PATH, args
# "run --model <m> <prompt>", working directory = the task worktree).
$agentOk = Join-Path $fakeBin 'fakeagent-ok.ps1'
Set-Content -LiteralPath $agentOk -Encoding UTF8 -Value @'
param()
Set-Content -LiteralPath 'agent-output.txt' -Value ('fake change ' + (Get-Date -Format o)) -Encoding UTF8
exit 0
'@
$agentNoop = Join-Path $fakeBin 'fakeagent-noop.ps1'
Set-Content -LiteralPath $agentNoop -Encoding UTF8 -Value @'
param()
exit 0
'@
$agentFail = Join-Path $fakeBin 'fakeagent-fail.ps1'
Set-Content -LiteralPath $agentFail -Encoding UTF8 -Value @'
param()
Write-Error 'fake agent failure'
exit 3
'@
$agentHang = Join-Path $fakeBin 'fakeagent-hang.ps1'
Set-Content -LiteralPath $agentHang -Encoding UTF8 -Value @'
param()
$gc = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 300') -PassThru -WindowStyle Hidden
if ($env:FAKE_GC_PIDFILE) { Set-Content -LiteralPath $env:FAKE_GC_PIDFILE -Value $gc.Id }
Start-Sleep 300
'@
# Fails AFTER writing a real change: used to prove that an ERROR result
# never destroys the agent's data (T28).
$agentFailWrites = Join-Path $fakeBin 'fakeagent-fail-writes.ps1'
Set-Content -LiteralPath $agentFailWrites -Encoding UTF8 -Value @'
param()
Set-Content -LiteralPath 'partial.txt' -Value ('agent work before failure ' + (Get-Date -Format o)) -Encoding UTF8
Write-Error 'fake agent failed after writing a file'
exit 3
'@
# Writes a real change and then hangs: used to prove that a TIMEOUT result
# never destroys the agent's data (T29).
$agentHangWrites = Join-Path $fakeBin 'fakeagent-hang-writes.ps1'
Set-Content -LiteralPath $agentHangWrites -Encoding UTF8 -Value @'
param()
Set-Content -LiteralPath 'partial.txt' -Value ('agent work before hang ' + (Get-Date -Format o)) -Encoding UTF8
Start-Sleep 300
'@
# Writes a change and then deletes the worktree's .git pointer file, so
# every git verification command in that directory fails: the worktree
# state becomes UNKNOWN and must never be reported as success (T33).
$agentBreaksVerification = Join-Path $fakeBin 'fakeagent-break-verification.ps1'
Set-Content -LiteralPath $agentBreaksVerification -Encoding UTF8 -Value @'
param()
Set-Content -LiteralPath 'partial.txt' -Value 'written before the worktree state became unreadable' -Encoding UTF8
Remove-Item -LiteralPath '.git' -Force -ErrorAction SilentlyContinue
exit 0
'@
$env:Path = "$fakeBin;$env:Path"

function New-LocalTaskFile {
    # Builds a Local-mode task file; returns its path.
    param([int]$Number = 901, [string]$Body = 'Add a hello file.', [string]$State = 'open', [string[]]$Labels = @('ready-for-opencode'))
    $obj = [pscustomobject]@{ number = $Number; title = "T2x task $Number"; state = $State; labels = $Labels; body = $Body }
    $p = Join-Path $testRoot ('task-{0}-{1}.json' -f $Number, [guid]::NewGuid().ToString('N').Substring(0, 6))
    Set-Content -LiteralPath $p -Value (ConvertTo-Json -InputObject $obj -Compress) -Encoding UTF8
    return $p
}

function New-Stage2Config {
    param([string]$TaskFile, [string]$Agent = 'fakeagent-ok', [string]$TaskTimeout = '180', [string]$RunRoot = '')
    if ([string]::IsNullOrEmpty($RunRoot)) { $RunRoot = Join-Path $testRoot ('runs-' + [guid]::NewGuid().ToString('N').Substring(0, 6)) }
    return New-TestConfig -Overrides @{
        RepoPath        = $gitRepoT
        TaskSource      = 'Local'
        LocalTaskFile   = $TaskFile
        BaseBranch      = 'main'
        AgentCommand    = $Agent
        TaskTimeoutSec  = $TaskTimeout
        RunRootDir      = $RunRoot
        LockDir         = (Join-Path $testRoot ('locks-' + [guid]::NewGuid().ToString('N').Substring(0, 6)))
        LogDir          = (Join-Path $testRoot ('logs-t2-' + [guid]::NewGuid().ToString('N').Substring(0, 6)))
    }
}
function Get-WorktreeDirs {
    # NOTE: PowerShell unrolls arrays on return, so the caller MUST wrap
    # this in @(...) to always get a real array (StrictMode-safe .Count).
    param([string]$RunRoot)
    if (-not (Test-Path -LiteralPath $RunRoot)) { return }
    Get-ChildItem -LiteralPath $RunRoot -Directory -Filter 'issue-*'
}

# --- T17: worktree create/remove unit on the temp repo ----------------------
$wtPathT17 = Join-Path $testRoot 't17-worktree'
$wtNew = New-TaskWorktree -RepoPath $gitRepoT -WorktreePath $wtPathT17 -Branch 't17/branch' -BaseSha $baseShaT
$wtHead = if ($wtNew.Ok) { (& git -C $wtPathT17 rev-parse HEAD | Out-String).Trim() } else { '' }
$wtDup = New-TaskWorktree -RepoPath $gitRepoT -WorktreePath $wtPathT17 -Branch 't17/other' -BaseSha $baseShaT
$wtDupRefused = (-not $wtDup.Ok -and $wtDup.Message -match 'already exists')
Test-Case 'T17a worktree created from explicit base SHA (HEAD verified)' ($wtNew.Ok -and $wtHead -eq $baseShaT) $baseShaT
Test-Case 'T17b existing worktree path refused (no reuse)' $wtDupRefused ''
# Dirty worktree: removal must refuse and keep the data (never force)
Set-Content -LiteralPath (Join-Path $wtPathT17 'dirty.txt') -Value 'uncommitted' -Encoding UTF8
$wtRmDirty = Remove-TaskWorktree -RepoPath $gitRepoT -WorktreePath $wtPathT17 -Branch 't17/branch' -BaseSha $baseShaT
$dirtyKept = (-not $wtRmDirty.Ok -and (Test-Path -LiteralPath (Join-Path $wtPathT17 'dirty.txt')))
Test-Case 'T17c dirty worktree NOT removed (data preserved, never forced)' $dirtyKept $wtRmDirty.Message
Remove-Item -LiteralPath (Join-Path $wtPathT17 'dirty.txt') -Force
$wtRmClean = Remove-TaskWorktree -RepoPath $gitRepoT -WorktreePath $wtPathT17 -Branch 't17/branch' -BaseSha $baseShaT
$branchGone = (& git -C $gitRepoT rev-parse --verify --quiet refs/heads/t17/branch 2>&1 | Out-String) -eq ''
Test-Case 'T17d clean worktree removed and base-only branch dropped' ($wtRmClean.Ok -and -not (Test-Path -LiteralPath $wtPathT17) -and $branchGone) ''

# --- T18: base-SHA requirement parsing (unit on the real function) ----------
$r1 = Test-BaseShaRequirement -Text 'please use base-sha: 054ef0a here' -ActualSha ('054ef0a' + ('b' * 33))
$r2 = Test-BaseShaRequirement -Text 'please use base-sha: 054ef0a here' -ActualSha ('ffff' + ('b' * 36))
$r3 = Test-BaseShaRequirement -Text 'no pinned sha in this task' -ActualSha $baseShaT
Test-Case 'T18a base-sha requirement satisfied by prefix match' ($r1.Required -eq '054ef0a' -and $r1.Match) ''
Test-Case 'T18b base-sha mismatch detected' ($r2.Required -eq '054ef0a' -and -not $r2.Match) ''
Test-Case 'T18c no marker -> no requirement' ([string]::IsNullOrEmpty($r3.Required) -and $r3.Match) ''

# --- T19: untrusted-text findings (unit on the real function) ---------------
$fPush  = @(Get-UntrustedFindings -Text 'just git push the branch please')
$fPr    = @(Get-UntrustedFindings -Text 'і створи PR після цього')
$fLabel = @(Get-UntrustedFindings -Text 'додай мітку in-progress')
$fGh    = @(Get-UntrustedFindings -Text 'gh label edit x and gh issue close 2')
$fClean = @(Get-UntrustedFindings -Text 'Опиши структуру модуля і додай тести.')
Test-Case 'T19a untrusted: git push / PR / label / gh mutations flagged' (($fPush.Count + $fPr.Count + $fLabel.Count + $fGh.Count) -ge 4) ''
Test-Case 'T19b untrusted: benign task text passes the scan' ($fClean.Count -eq 0) ''

# --- T20: full Stage 2 run, SUCCESS (fake agent makes a real change) --------
$task20 = New-LocalTaskFile -Number 901 -Body ('Add a hello file.' + "`n" + ('base-sha: ' + $baseShaT))
$cfg20 = New-Stage2Config -TaskFile $task20 -Agent 'fakeagent-ok'
$run20 = Invoke-Dispatcher -ConfigPath $cfg20 -SkipModelPing -Stage2
# RunRootDir/LockDir live inside the config; read them back from its text
$runRoot20 = ([regex]::Match([IO.File]::ReadAllText($cfg20), "RunRootDir\s*=\s*'([^']+)'")).Groups[1].Value
$wt20 = @(Get-WorktreeDirs -RunRoot $runRoot20)
$lockDir20 = ([regex]::Match([IO.File]::ReadAllText($cfg20), "LockDir\s*=\s*'([^']+)'")).Groups[1].Value
$lockLeft20 = @(Get-ChildItem -LiteralPath $lockDir20 -Filter '*.lock' -ErrorAction SilentlyContinue).Count
$t20changed = $false
if ($wt20.Count -eq 1) {
    $t20changed = Test-Path -LiteralPath (Join-Path $wt20[0].FullName 'agent-output.txt')
    $wt20Head = (& git -C $wt20[0].FullName rev-parse HEAD | Out-String).Trim()
    $t20changed = $t20changed -and ($wt20Head -eq $baseShaT)
}
Test-Case 'T20a stage2 SUCCESS: exit 0, result SUCCESS' ($run20.ExitCode -eq 0 -and $run20.Output -match 'result: SUCCESS') ("exit {0}" -f $run20.ExitCode)
Test-Case 'T20b worktree kept with verified changes at base SHA' ($t20changed -and $wt20.Count -eq 1) ''
Test-Case 'T20c lock released after success' ($lockLeft20 -eq 0) ("locks left {0}" -f $lockLeft20)
Test-Case 'T20d temp repo stayed clean (main clone untouched)' ([string]::IsNullOrWhiteSpace((& git -C $gitRepoT status --porcelain | Out-String))) ''

# --- T21: full Stage 2 run, NO_CHANGES (agent exits 0, changes nothing) -----
$task21 = New-LocalTaskFile -Number 902 -Body 'Do nothing at all.'
$cfg21 = New-Stage2Config -TaskFile $task21 -Agent 'fakeagent-noop'
$run21 = Invoke-Dispatcher -ConfigPath $cfg21 -SkipModelPing -Stage2
$runRoot21 = ([regex]::Match([IO.File]::ReadAllText($cfg21), "RunRootDir\s*=\s*'([^']+)'")).Groups[1].Value
$wt21 = @(Get-WorktreeDirs -RunRoot $runRoot21)
$lockDir21 = ([regex]::Match([IO.File]::ReadAllText($cfg21), "LockDir\s*=\s*'([^']+)'")).Groups[1].Value
$lockLeft21 = @(Get-ChildItem -LiteralPath $lockDir21 -Filter '*.lock' -ErrorAction SilentlyContinue).Count
Test-Case 'T21a exit 0 with NO_CHANGES (empty result is NOT a success)' ($run21.ExitCode -eq 0 -and $run21.Output -match 'result: NO_CHANGES') ("exit {0}" -f $run21.ExitCode)
Test-Case 'T21b empty worktree removed by cleanup' ($wt21.Count -eq 0) ("worktrees left {0}" -f $wt21.Count)
Test-Case 'T21c lock released after NO_CHANGES' ($lockLeft21 -eq 0) ''

# --- T22: base-SHA mismatch -> REFUSED, no worktree created -----------------
$task22 = New-LocalTaskFile -Number 903 -Body ('Pin a different base. base-sha: deadbee')
$cfg22 = New-Stage2Config -TaskFile $task22 -Agent 'fakeagent-ok'
$run22 = Invoke-Dispatcher -ConfigPath $cfg22 -SkipModelPing -Stage2
$runRoot22 = ([regex]::Match([IO.File]::ReadAllText($cfg22), "RunRootDir\s*=\s*'([^']+)'")).Groups[1].Value
$wt22 = @(Get-WorktreeDirs -RunRoot $runRoot22)
$lockDir22 = ([regex]::Match([IO.File]::ReadAllText($cfg22), "LockDir\s*=\s*'([^']+)'")).Groups[1].Value
$lockLeft22 = @(Get-ChildItem -LiteralPath $lockDir22 -Filter '*.lock' -ErrorAction SilentlyContinue).Count
Test-Case 'T22 base-SHA mismatch refused: exit 4, no worktree, lock released' ($run22.ExitCode -eq 4 -and $run22.Output -match 'REFUSED' -and $wt22.Count -eq 0 -and $lockLeft22 -eq 0) ("exit {0}" -f $run22.ExitCode)

# --- T23: untrusted task text -> REFUSED, agent never runs ------------------
$task23 = New-LocalTaskFile -Number 904 -Body 'Do the work, then git push everything.'
$cfg23 = New-Stage2Config -TaskFile $task23 -Agent 'fakeagent-ok'
$run23 = Invoke-Dispatcher -ConfigPath $cfg23 -SkipModelPing -Stage2
$runRoot23 = ([regex]::Match([IO.File]::ReadAllText($cfg23), "RunRootDir\s*=\s*'([^']+)'")).Groups[1].Value
$wt23 = @(Get-WorktreeDirs -RunRoot $runRoot23)
Test-Case 'T23 untrusted text refused: exit 4, no worktree (agent not run)' ($run23.ExitCode -eq 4 -and $run23.Output -match 'untrusted task text' -and $wt23.Count -eq 0) ("exit {0}" -f $run23.ExitCode)

# --- T24: agent failure -> ERROR, and the NEXT run recovers -----------------
$task24 = New-LocalTaskFile -Number 905 -Body 'This agent always fails.'
$cfg24 = New-Stage2Config -TaskFile $task24 -Agent 'fakeagent-fail'
$run24 = Invoke-Dispatcher -ConfigPath $cfg24 -SkipModelPing -Stage2
$lockDir24 = ([regex]::Match([IO.File]::ReadAllText($cfg24), "LockDir\s*=\s*'([^']+)'")).Groups[1].Value
$lockLeft24 = @(Get-ChildItem -LiteralPath $lockDir24 -Filter '*.lock' -ErrorAction SilentlyContinue).Count
Test-Case 'T24a agent failure -> ERROR: exit 1, lock released' ($run24.ExitCode -eq 1 -and $run24.Output -match 'result: ERROR' -and $lockLeft24 -eq 0) ("exit {0}" -f $run24.ExitCode)
# Recovery: the very same config works again with a healthy agent
[IO.File]::WriteAllText($task24, (ConvertTo-Json -InputObject ([pscustomobject]@{ number = 905; title = 'T2x task 905'; state = 'open'; labels = @('ready-for-opencode'); body = 'Now behave.' }) -Compress))
$cfg24b = New-Stage2Config -TaskFile $task24 -Agent 'fakeagent-noop'
$run24b = Invoke-Dispatcher -ConfigPath $cfg24b -SkipModelPing -Stage2
Test-Case 'T24b recovery: next run after failure completes normally' ($run24b.ExitCode -eq 0 -and $run24b.Output -match 'result: NO_CHANGES') ("exit {0}" -f $run24b.ExitCode)

# --- T25: timeout -> TIMEOUT, grandchild killed, lock released --------------
$gcPidFile = Join-Path $testRoot 't25-gc.pid'
$env:FAKE_GC_PIDFILE = $gcPidFile
$task25 = New-LocalTaskFile -Number 906 -Body 'This agent hangs forever.'
$cfg25 = New-Stage2Config -TaskFile $task25 -Agent 'fakeagent-hang' -TaskTimeout '4'
$run25 = Invoke-Dispatcher -ConfigPath $cfg25 -SkipModelPing -Stage2
Remove-Item Env:\FAKE_GC_PIDFILE -ErrorAction SilentlyContinue
$gcId = if (Test-Path $gcPidFile) { [int]([IO.File]::ReadAllText($gcPidFile).Trim()) } else { 0 }
$gcDead = $false
if ($gcId -gt 0) { Start-Sleep -Milliseconds 500; try { $null = Get-Process -Id $gcId -ErrorAction Stop } catch { $gcDead = $true } }
$lockDir25 = ([regex]::Match([IO.File]::ReadAllText($cfg25), "LockDir\s*=\s*'([^']+)'")).Groups[1].Value
$lockLeft25 = @(Get-ChildItem -LiteralPath $lockDir25 -Filter '*.lock' -ErrorAction SilentlyContinue).Count
Test-Case 'T25a timeout -> TIMEOUT: exit 2, lock released' ($run25.ExitCode -eq 2 -and $run25.Output -match 'result: TIMEOUT' -and $lockLeft25 -eq 0) ("exit {0}" -f $run25.ExitCode)
Test-Case 'T25b grandchild process killed after timeout' ($gcId -gt 0 -and $gcDead) ("grandchild pid {0}" -f $gcId)

# --- T26: an ACTIVE lock blocks a parallel Stage 2 run ----------------------
$task26 = New-LocalTaskFile -Number 907 -Body 'Would run, but the lock is taken.'
$cfg26 = New-Stage2Config -TaskFile $task26 -Agent 'fakeagent-ok'
$lockDir26 = ([regex]::Match([IO.File]::ReadAllText($cfg26), "LockDir\s*=\s*'([^']+)'")).Groups[1].Value
New-Item -ItemType Directory -Path $lockDir26 -Force | Out-Null
Set-Content -LiteralPath (Join-Path $lockDir26 'dispatcher.lock') -Value ("pid={0}`r`nhost={1}`r`ncreated=now" -f $PID, $env:COMPUTERNAME) -Encoding UTF8
$run26 = Invoke-Dispatcher -ConfigPath $cfg26 -SkipModelPing -Stage2
Remove-Item -LiteralPath (Join-Path $lockDir26 'dispatcher.lock') -Force -ErrorAction SilentlyContinue
Test-Case 'T26 active lock blocks parallel run: exit 4, task not executed' ($run26.ExitCode -eq 4 -and $run26.Output -match 'another dispatcher instance is active') ("exit {0}" -f $run26.ExitCode)

# --- T27: dispatcher source contains NO forbidden GitHub operations --------
# Issue #9 exception: `gh issue comment` (create/edit) is authorized ONLY
# inside the Publish-IssueReport function - the opt-in report comment.
# Everywhere else (and push / PR / label / issue-close regardless of place)
# remains forbidden.
$srcText = [IO.File]::ReadAllText($DispatcherPath)
$badOps = @()
if ($srcText -match '(?i)Invoke-Native[^\r\n]*\bpush\b') { $badOps += 'git push invocation' }
if ($srcText -match '(?i)&\s*git\s+push') { $badOps += 'direct git push' }
$pubAsts = @($fnAsts | Where-Object { $_.Name -eq 'Publish-IssueReport' })
$pubText = if ($pubAsts.Count -gt 0) { $pubAsts[0].Extent.Text } else { '' }
$srcNoPub = if ($pubText) { $srcText.Replace($pubText, '') } else { $srcText }
if ($srcNoPub -match '(?i)Invoke-Native[^\r\n]*\bgh\b[^\r\n]*(\bpr\b|\blabel\b|\bissue\b)[^\r\n]*\b(create|close|edit|comment|merge|delete)\b') { $badOps += 'gh mutation invocation outside Publish-IssueReport' }
if (-not $pubText) { $badOps += 'Publish-IssueReport function not found (authorization zone missing)' }
foreach ($pubLine in @($pubText -split "`r?`n")) {
    if ($pubLine -notmatch 'Invoke-Native') { continue }
    if ($pubLine -match '(?i)\bgh\b' -and $pubLine -match '(?i)(\bpr\b|\blabel\b)') { $badOps += "gh PR/label mutation inside Publish-IssueReport: $($pubLine.Trim())" }
    if ($pubLine -match '(?i)\bissue\b.{0,50}\b(close|delete|reopen|label)\b') { $badOps += "issue-state mutation inside Publish-IssueReport: $($pubLine.Trim())" }
}
# The ONLY authorized mutation lines must all target `issue comment`
foreach ($m in [regex]::Matches($srcText, '(?i)Invoke-Native[^\r\n]*\bgh\b[^\r\n]*')) {
    if ($m.Value -match '(?i)\bissue\b' -and $m.Value -match '(?i)\b(create|close|edit|comment|merge|delete)\b') {
        if ($m.Value -notmatch "(?i)'issue',\s*'comment'") { $badOps += "unrecognized gh mutation: $($m.Value.Trim())" }
    }
}
Test-Case 'T27 no push/PR/label/issue-mutation commands in dispatcher source (issue comment only inside Publish-IssueReport)' ($badOps.Count -eq 0) ($badOps -join '; ')

# --- T28: agent ERROR after writing a file -> data preserved ----------------
$task28 = New-LocalTaskFile -Number 908 -Body 'Write a file into the worktree, then fail.'
$cfg28 = New-Stage2Config -TaskFile $task28 -Agent 'fakeagent-fail-writes'
$run28 = Invoke-Dispatcher -ConfigPath $cfg28 -SkipModelPing -Stage2
$runRoot28 = ([regex]::Match([IO.File]::ReadAllText($cfg28), "RunRootDir\s*=\s*'([^']+)'")).Groups[1].Value
$wt28 = @(Get-WorktreeDirs -RunRoot $runRoot28)
$lockDir28 = ([regex]::Match([IO.File]::ReadAllText($cfg28), "LockDir\s*=\s*'([^']+)'")).Groups[1].Value
$lockLeft28 = @(Get-ChildItem -LiteralPath $lockDir28 -Filter '*.lock' -ErrorAction SilentlyContinue).Count
$file28 = $false
$status28 = ''
if ($wt28.Count -eq 1) {
    $file28 = Test-Path -LiteralPath (Join-Path $wt28[0].FullName 'partial.txt')
    $status28 = & git -C $wt28[0].FullName status --porcelain | Out-String
}
Test-Case 'T28a agent failure with changes -> ERROR: exit 1, result ERROR' ($run28.ExitCode -eq 1 -and $run28.Output -match 'result: ERROR') ("exit {0}" -f $run28.ExitCode)
Test-Case 'T28b file left by the failed agent exists' ($wt28.Count -eq 1 -and $file28) ("worktrees {0}, file {1}" -f $wt28.Count, $file28)
Test-Case 'T28c worktree preserved WITH its changes after ERROR' ($wt28.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace($status28)) ($status28.Trim() -replace "`r?`n", '; ')
Test-Case 'T28d lock released after ERROR' ($lockLeft28 -eq 0) ("locks left {0}" -f $lockLeft28)
Test-Case 'T28e temp test repository still clean' ([string]::IsNullOrWhiteSpace((& git -C $gitRepoT status --porcelain | Out-String))) ''

# --- T29: agent TIMEOUT after writing a file -> data preserved --------------
$task29 = New-LocalTaskFile -Number 909 -Body 'Write a file into the worktree, then hang forever.'
$cfg29 = New-Stage2Config -TaskFile $task29 -Agent 'fakeagent-hang-writes' -TaskTimeout '4'
$run29 = Invoke-Dispatcher -ConfigPath $cfg29 -SkipModelPing -Stage2
$runRoot29 = ([regex]::Match([IO.File]::ReadAllText($cfg29), "RunRootDir\s*=\s*'([^']+)'")).Groups[1].Value
$wt29 = @(Get-WorktreeDirs -RunRoot $runRoot29)
$lockDir29 = ([regex]::Match([IO.File]::ReadAllText($cfg29), "LockDir\s*=\s*'([^']+)'")).Groups[1].Value
$lockLeft29 = @(Get-ChildItem -LiteralPath $lockDir29 -Filter '*.lock' -ErrorAction SilentlyContinue).Count
$file29 = $false
$status29 = ''
if ($wt29.Count -eq 1) {
    $file29 = Test-Path -LiteralPath (Join-Path $wt29[0].FullName 'partial.txt')
    $status29 = & git -C $wt29[0].FullName status --porcelain | Out-String
}
Test-Case 'T29a agent timeout with changes -> TIMEOUT: exit 2, result TIMEOUT' ($run29.ExitCode -eq 2 -and $run29.Output -match 'result: TIMEOUT') ("exit {0}" -f $run29.ExitCode)
Test-Case 'T29b file written before the timeout exists' ($wt29.Count -eq 1 -and $file29) ("worktrees {0}, file {1}" -f $wt29.Count, $file29)
Test-Case 'T29c worktree preserved WITH its changes after TIMEOUT' ($wt29.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace($status29)) ($status29.Trim() -replace "`r?`n", '; ')
Test-Case 'T29d lock released after TIMEOUT' ($lockLeft29 -eq 0) ("locks left {0}" -f $lockLeft29)
Test-Case 'T29e temp test repository still clean' ([string]::IsNullOrWhiteSpace((& git -C $gitRepoT status --porcelain | Out-String))) ''

# --- T30: an ACTIVE lock is never stale, even when it is OLD ----------------
#     Regression: the age check must not run before the local-pid liveness
#     check - a live owner must not lose its lock just because it is old.
$lockDirT30 = Join-Path $testRoot 't30-locks'
New-Item -ItemType Directory -Path $lockDirT30 -Force | Out-Null
$liveLockPath = Join-Path $lockDirT30 't30-live.lock'
Set-Content -LiteralPath $liveLockPath -Value ("pid={0}`r`nhost={1}`r`ncreated=long-ago" -f $PID, $env:COMPUTERNAME) -Encoding UTF8
(Get-Item -LiteralPath $liveLockPath).LastWriteTime = (Get-Date).AddHours(-3)
$t30msg = ''
$t30acquired = $false
try { $null = Enter-DispatcherLock -LockDir $lockDirT30 -Name 't30-live' -StaleSec 900; $t30acquired = $true }
catch { $t30msg = $_.Exception.Message }
$archived30 = @(Get-ChildItem -LiteralPath $lockDirT30 -Filter 't30-live.lock.stale-*').Count
Test-Case 'T30a live local pid + lock 3h old -> still ACTIVE (age must not win)' ((-not $t30acquired) -and ($t30msg -match 'another dispatcher instance is active')) $t30msg
Test-Case 'T30b active lock neither archived nor replaced' ((-not $t30acquired) -and $archived30 -eq 0 -and (Test-Path -LiteralPath $liveLockPath)) ("archived {0}" -f $archived30)
# A lock file without content yet (create-then-write window) must not be
# taken over while it is young: its owner is not knowable, so it is not dead.
$emptyLockPath = Join-Path $lockDirT30 't30-empty.lock'
[IO.File]::WriteAllText($emptyLockPath, '')
$t30emsg = ''
try { $null = Enter-DispatcherLock -LockDir $lockDirT30 -Name 't30-empty' -StaleSec 900 }
catch { $t30emsg = $_.Exception.Message }
Test-Case 'T30c young incomplete lock content -> refused (no parallel takeover)' ((Test-Path -LiteralPath $emptyLockPath) -and ($t30emsg -match 'another dispatcher instance is active')) $t30emsg

# --- T31: verification counts tracked, staged AND untracked changes ---------
$wtPathT31 = Join-Path $testRoot 't31-worktree'
$wt31 = New-TaskWorktree -RepoPath $gitRepoT -WorktreePath $wtPathT31 -Branch 't31/branch' -BaseSha $baseShaT
$cv31clean = if ($wt31.Ok) { Get-WorktreeChanges -WorktreePath $wtPathT31 } else { @{ Ok = $false; Message = 'worktree was not created' } }
Test-Case 'T31a clean worktree -> Ok=true, no changes' ($wt31.Ok -and $cv31clean.Ok -and -not $cv31clean.HasChanges) $cv31clean.Message

Set-Content -LiteralPath (Join-Path $wtPathT31 'untracked.txt') -Value 'brand new file' -Encoding UTF8
$cv31u = Get-WorktreeChanges -WorktreePath $wtPathT31
$t31u = ($cv31u.Ok -and $cv31u.HasChanges -and (@($cv31u.Untracked) -contains 'untracked.txt'))
Test-Case 'T31b untracked file counted' $t31u ((@($cv31u.Untracked) -join ', '))

Add-Content -LiteralPath (Join-Path $wtPathT31 'seed.txt') -Value 'edited line' -Encoding UTF8
$cv31m = Get-WorktreeChanges -WorktreePath $wtPathT31
$t31m = ($cv31m.Ok -and (@($cv31m.Modified) -contains 'seed.txt'))
Test-Case 'T31c tracked worktree modification counted' $t31m ((@($cv31m.Modified) -join ', '))

$null = & git -C $wtPathT31 add untracked.txt 2>&1 | Out-String
$cv31s = Get-WorktreeChanges -WorktreePath $wtPathT31
$t31s = ($cv31s.Ok -and $cv31s.HasChanges -and (@($cv31s.Staged) -contains 'untracked.txt') -and (@($cv31s.Files).Count -ge 2))
Test-Case 'T31d staged change counted; all three categories reported' $t31s ("staged=[{0}] files={1}" -f ((@($cv31s.Staged)) -join ','), (@($cv31s.Files).Count))

# dispose of the fixture (temporary repo only, never the real repository)
$null = & git -C $wtPathT31 reset --quiet 2>&1 | Out-String
$null = & git -C $wtPathT31 checkout -- seed.txt 2>&1 | Out-String
Remove-Item -LiteralPath (Join-Path $wtPathT31 'untracked.txt') -Force -ErrorAction SilentlyContinue
$rm31 = Remove-TaskWorktree -RepoPath $gitRepoT -WorktreePath $wtPathT31 -Branch 't31/branch' -BaseSha $baseShaT
Test-Case 'T31e verification fixture removed (temp repo clean again)' ($rm31.Ok -and -not (Test-Path -LiteralPath $wtPathT31)) $rm31.Message

# --- T32: a failed verification command is NEVER reported as success --------
$notRepoDir = Join-Path $testRoot 't32-not-a-repo'
New-Item -ItemType Directory -Path $notRepoDir -Force | Out-Null
$cv32a = Get-WorktreeChanges -WorktreePath $notRepoDir
Test-Case 'T32a non-repository path -> Ok=false (git status exit code checked)' (-not $cv32a.Ok) $cv32a.Message

# git status succeeds and sees the untracked file, but `git diff --check
# HEAD` / `git diff --stat HEAD` exit 128 (no HEAD commit): the verification
# commands did not complete, so Ok MUST be false - no success is declared.
$unbornDir = Join-Path $testRoot 't32-unborn'
New-Item -ItemType Directory -Path $unbornDir -Force | Out-Null
$null = & git -C $unbornDir init 2>&1 | Out-String
Set-Content -LiteralPath (Join-Path $unbornDir 'new.txt') -Value 'x' -Encoding UTF8
$cv32b = Get-WorktreeChanges -WorktreePath $unbornDir
Test-Case 'T32b failed diff verification -> Ok=false (no success declared)' (-not $cv32b.Ok) $cv32b.Message
Test-Case 'T32c failure message names the failing verification command' ($cv32b.Message -match 'git diff') $cv32b.Message

# --- T33: worktree state becomes UNKNOWN -> kept, lock released, ERROR ------
$task33 = New-LocalTaskFile -Number 910 -Body 'Write a file, then break the worktree metadata.'
$cfg33 = New-Stage2Config -TaskFile $task33 -Agent 'fakeagent-break-verification'
$run33 = Invoke-Dispatcher -ConfigPath $cfg33 -SkipModelPing -Stage2
$runRoot33 = ([regex]::Match([IO.File]::ReadAllText($cfg33), "RunRootDir\s*=\s*'([^']+)'")).Groups[1].Value
$wt33 = @(Get-WorktreeDirs -RunRoot $runRoot33)
$lockDir33 = ([regex]::Match([IO.File]::ReadAllText($cfg33), "LockDir\s*=\s*'([^']+)'")).Groups[1].Value
$lockLeft33 = @(Get-ChildItem -LiteralPath $lockDir33 -Filter '*.lock' -ErrorAction SilentlyContinue).Count
$file33 = $false
if ($wt33.Count -eq 1) { $file33 = Test-Path -LiteralPath (Join-Path $wt33[0].FullName 'partial.txt') }
Test-Case 'T33a unverifiable worktree -> ERROR: exit 1, no success declared' ($run33.ExitCode -eq 1 -and $run33.Output -match 'result: ERROR') ("exit {0}" -f $run33.ExitCode)
Test-Case 'T33b unknown state: worktree and file preserved' ($wt33.Count -eq 1 -and $file33) ("worktrees {0}, file {1}" -f $wt33.Count, $file33)
Test-Case 'T33c lock released although cleanup could not verify the worktree' ($lockLeft33 -eq 0) ("locks left {0}" -f $lockLeft33)
Test-Case 'T33d output reports an unknown state (not a success)' ($run33.Output -match 'state UNKNOWN|state unknown') ''

# =============================================================================
# T35-T38: Issue #9 - Stage 2 report publishing (fake gh, NO real GitHub).
# A fake `gh.ps1` shadows the real gh on PATH for this block ONLY (the PATH
# is restored before T34). FAKE_GH_MODE selects the behavior, every gh call
# (and its --body payload) is appended to FAKE_GH_LOG. The real GitHub
# project is never contacted or mutated by these tests.
# =============================================================================
$fakeGhDir = Join-Path $testRoot 'fakegh'
New-Item -ItemType Directory -Path $fakeGhDir -Force | Out-Null
$fakeGhScript = @'
# Fake GitHub CLI for dispatcher tests: NEVER contacts GitHub.
$mode = $env:FAKE_GH_MODE
if ([string]::IsNullOrEmpty($mode)) { $mode = 'ok' }
$logPath = $env:FAKE_GH_LOG
$a = @($args)
if ($logPath) {
    [System.IO.File]::AppendAllText($logPath, ('ARGS: ' + ($a -join ' | ') + "`r`n"))
    for ($i = 0; $i -lt $a.Count; $i++) {
        if ($a[$i] -eq '--body' -and ($i + 1) -lt $a.Count) {
            [System.IO.File]::AppendAllText($logPath, ('---BODY---' + "`r`n" + $a[$i + 1] + "`r`n---END-BODY---" + "`r`n"))
        }
    }
}
if ($mode -eq 'fail') {
    [Console]::Error.WriteLine('fake gh: simulated GitHub API failure')
    exit 1
}
if ($a.Count -ge 2 -and $a[0] -eq 'issue' -and $a[1] -eq 'view') {
    if ($mode -eq 'view-fail') { [Console]::Error.WriteLine('fake gh: simulated gh issue view failure'); exit 1 }
    $joined = $a -join ' '
    if ($joined -match '--json comments') {
        if ($mode -eq 'comments-bad-json') { Write-Output '{ this is not valid json'; exit 0 }
        if ($mode -eq 'exists') { Write-Output '{"comments":[{"id":"424242","body":"<!-- dispatcher-report issue=901 --> previous report"}]}'; exit 0 }
        Write-Output '{"comments":[]}'
        exit 0
    }
    $num = if ($a.Count -ge 3) { [string]$a[2] } else { '0' }
    $state = 'open'
    $labels = '[{"name":"ready-for-opencode"}]'
    if ($mode -eq 'view-closed') { $state = 'closed' }
    if ($mode -eq 'view-nolabel') { $labels = '[]' }
    if ($mode -eq 'view-wrongnumber') { $num = '999999' }
    Write-Output ('{"number":' + $num + ',"state":"' + $state + '","labels":' + $labels + '}')
    exit 0
}
if ($a.Count -ge 2 -and $a[0] -eq 'issue' -and $a[1] -eq 'comment') {
    if ($mode -eq 'comment-fail') { [Console]::Error.WriteLine('fake gh: simulated gh issue comment failure'); exit 1 }
    if ($mode -eq 'silent-success') { exit 0 }
    $num = if ($a.Count -ge 3) { [string]$a[2] } else { '?' }
    Write-Output ('https://github.com/shatVM/LyServer/issues/' + $num + '#issuecomment-1')
    exit 0
}
exit 0
'@
Set-Content -LiteralPath (Join-Path $fakeGhDir 'gh.ps1') -Value $fakeGhScript -Encoding UTF8
$pathBeforeFakeGh = $env:Path
$env:Path = "$fakeGhDir;$env:Path"
$ghResolved = Resolve-Command -Name 'gh'
Test-Case 'T35a fake gh shadows the real gh on PATH (test isolation)' ($null -ne $ghResolved -and $ghResolved.FilePath -eq 'powershell.exe' -and (($ghResolved.PrefixArgs -join ' ') -match 'fakegh')) $(if ($ghResolved) { $ghResolved.FilePath } else { 'NOT FOUND' })

$fakeGhLog = Join-Path $testRoot 'fakegh.log'
$unitLog = Join-Path $testRoot 'publish-unit.log'
function Get-FakeGhLog {
    if (Test-Path -LiteralPath $fakeGhLog) { return [IO.File]::ReadAllText($fakeGhLog) }
    return ''
}
function Reset-FakeGh {
    param([string]$Mode = 'ok')
    $env:FAKE_GH_MODE = $Mode
    $env:FAKE_GH_LOG = $fakeGhLog
    if (Test-Path -LiteralPath $fakeGhLog) { Remove-Item -LiteralPath $fakeGhLog -Force }
}
function New-UnitReportParams {
    # Standard unit-test payload for Publish-IssueReport.
    param([int]$IssueNumber = 905, [string]$Status = 'SUCCESS', [string]$Claims = '(no agent output)')
    return @{
        IssueNumber          = $IssueNumber
        Status               = $Status
        BaseSha              = '0123456789abcdef0123456789abcdef01234567'
        AgentExitCode        = '0'
        ChangedFiles         = 'agent-output.txt'
        DiffStat             = ' agent-output.txt | 1 +'
        VerificationCommands = 'git status --porcelain; git diff --check HEAD; git diff --stat HEAD (run in the task worktree against HEAD)'
        VerificationResults  = 'git status --porcelain -> exit 0; classified: 0 staged, 1 modified in worktree, 0 untracked'
        AgentClaims          = $Claims
        ErrorMessage         = '(none - stage completed successfully)'
        LogPath              = $unitLog
        WorktreePath         = (Join-Path $testRoot 'unit-worktree')
        NoChangesReason      = ''
    }
}
$readyLabel = 'ready-for-opencode'
$repoName = 'shatVM/LyServer'

# --- T35: successful publication + content of the report --------------------
Reset-FakeGh -Mode 'ok'
$u35 = New-UnitReportParams -IssueNumber 905 -Status 'SUCCESS'
$r35 = Publish-IssueReport @u35 -VerifyIssue -GitHubRepo $repoName -LabelReady $readyLabel
$log35 = Get-FakeGhLog
$body35 = ''
$m35 = [regex]::Match($log35, '(?s)---BODY---\r?\n(.*?)\r?\n---END-BODY---')
if ($m35.Success) { $body35 = $m35.Groups[1].Value }
Test-Case 'T35b successful publication confirmed (Ok + Confirmed)' ($r35.Ok -and $r35.Confirmed -and $r35.Message -match 'URL') $r35.Message
Test-Case 'T35c gh was called with the DISPATCHER issue number (verify + comment)' (($log35 -match 'ARGS: issue \| view \| 905') -and ($log35 -match 'ARGS: issue \| comment \| 905')) ($log35 -replace "`r?`n", ' // ')
$t35content = ($body35 -match 'issue=905') -and ($body35 -match '\*\*Issue:\*\* #905') -and
    ($body35 -match '\*\*Dispatcher Status:\*\* SUCCESS') -and ($body35 -match '\*\*Base SHA:\*\* 0123456789abcdef') -and
    ($body35 -match '\*\*Agent Exit Code:\*\* 0') -and ($body35 -match '\*\*Execution Time:\*\* \d{4}') -and
    ($body35 -match '### Verified Facts \(Dispatcher\)') -and ($body35 -match '### Agent Claims \(NOT Verified by Dispatcher\)') -and
    ($body35 -match 'git status --porcelain; git diff --check HEAD') -and
    ($body35 -match 'classified') -and ($body35 -match 'agent-output.txt') -and
    ($body35 -match '### Log Locations') -and ($body35 -match 'publish-unit\.log') -and
    ($body35 -match 'unit-worktree')
Test-Case 'T35d report contains all required fields (issue/time/base/status/exit code/checks/files/logs)' $t35content ($(if ($body35) { 'content checked: ' + $body35.Length + ' chars' } else { 'NO BODY CAPTURED' }))

# The agent may CLAIM any issue number - the comment must still target the
# number the dispatcher executed (requirement: never the agent's number).
Reset-FakeGh -Mode 'ok'
$u35e = New-UnitReportParams -IssueNumber 905 -Status 'SUCCESS' -Claims 'Done, see issue #1234 for details.'
$r35e = Publish-IssueReport @u35e
$log35e = Get-FakeGhLog
Test-Case 'T35e agent-claimed issue number is never used as the comment target' (($r35e.Ok) -and ($log35e -match 'issue \| comment \| 905') -and ($log35e -notmatch 'issue \| comment \| 1234') -and ($log35e -match 'see issue #1234')) 'claim kept as text; target = dispatcher number'

# --- T36: failure scenarios (unit on the real Publish-IssueReport) ---------
# T36a/b: gh API error while creating the comment -> Ok=false + local report
Reset-FakeGh -Mode 'comment-fail'
$u36a = New-UnitReportParams -IssueNumber 906 -Status 'ERROR'
$r36a = Publish-IssueReport @u36a
$local36a = if ($r36a.LocalReportPath) { [IO.File]::ReadAllText($r36a.LocalReportPath) } else { '' }
Test-Case 'T36a gh comment failure -> not confirmed, error + report saved locally' ((-not $r36a.Ok) -and (-not $r36a.Confirmed) -and ($r36a.Message -match 'gh issue comment failed') -and ($r36a.LocalReportPath -and (Test-Path -LiteralPath $r36a.LocalReportPath))) $r36a.Message
Test-Case 'T36b local report file contains the report AND the publication error' (($local36a -match 'Stage 2 Execution Report') -and ($local36a -match 'Published to GitHub: NO') -and ($local36a -match 'simulated gh issue comment failure')) $(if ($r36a.LocalReportPath) { $r36a.LocalReportPath } else { 'no local file' })

# T36c: gh exits 0 but returns NO comment URL -> publication cannot be
# confirmed; success must not be claimed.
Reset-FakeGh -Mode 'silent-success'
$u36c = New-UnitReportParams -IssueNumber 907 -Status 'SUCCESS'
$r36c = Publish-IssueReport @u36c
Test-Case 'T36c exit 0 without confirmation URL -> treated as NOT published' ((-not $r36c.Ok) -and (-not $r36c.Confirmed) -and ($r36c.Message -match 'CANNOT be confirmed') -and ($r36c.LocalReportPath -and (Test-Path -LiteralPath $r36c.LocalReportPath))) $r36c.Message

# T36d: retry with an existing report comment -> UPDATE (--edit), no duplicate
Reset-FakeGh -Mode 'exists'
$u36d = New-UnitReportParams -IssueNumber 908 -Status 'TIMEOUT'
$r36d = Publish-IssueReport @u36d
$log36d = Get-FakeGhLog
Test-Case 'T36d existing report comment is edited, not duplicated (safe retry)' ($r36d.Ok -and ($log36d -match 'issue \| comment \| 908 \| --edit \| 424242') -and (@([regex]::Matches($log36d, 'ARGS: issue \| comment')).Count -eq 1)) ($log36d -replace "`r?`n", ' // ')

# T36e: the idempotency check itself fails -> ABORT (posting blindly could
# duplicate a report from a previous unconfirmed attempt).
Reset-FakeGh -Mode 'view-fail'
$u36e = New-UnitReportParams -IssueNumber 909 -Status 'SUCCESS'
$r36e = Publish-IssueReport @u36e
$log36e = Get-FakeGhLog
Test-Case 'T36e idempotency check failure -> publication aborted, no comment posted' ((-not $r36e.Ok) -and ($r36e.Message -match 'ABORTED') -and ($log36e -notmatch 'ARGS: issue \| comment') -and ($r36e.LocalReportPath -and (Test-Path -LiteralPath $r36e.LocalReportPath))) $r36e.Message

# T36f: invalid JSON from gh -> aborted instead of guessing
Reset-FakeGh -Mode 'comments-bad-json'
$u36f = New-UnitReportParams -IssueNumber 910 -Status 'SUCCESS'
$r36f = Publish-IssueReport @u36f
$log36f = Get-FakeGhLog
Test-Case 'T36f unparsable comments JSON -> aborted, nothing posted' ((-not $r36f.Ok) -and ($r36f.Message -match 'parse comments JSON') -and ($log36f -notmatch 'ARGS: issue \| comment')) $r36f.Message

# T36g: gh completely unavailable (mode fail) -> local report kept
Reset-FakeGh -Mode 'fail'
$u36g = New-UnitReportParams -IssueNumber 911 -Status 'ERROR'
$r36g = Publish-IssueReport @u36g
Test-Case 'T36g total gh failure -> Ok=false, local report + error saved' ((-not $r36g.Ok) -and ($r36g.Message -match 'idempotency check failed') -and ($r36g.LocalReportPath -and (Test-Path -LiteralPath $r36g.LocalReportPath))) $r36g.Message

# --- T37: Verify-IssueForPublish (existence / open / label / identity) ------
Reset-FakeGh -Mode 'ok'
$v37a = Verify-IssueForPublish -IssueNumber 905 -GitHubRepo $repoName -LabelReady $readyLabel
Test-Case 'T37a open issue with ready label -> verification passes' ($v37a.Ok) $v37a.Message
Reset-FakeGh -Mode 'view-closed'
$v37b = Verify-IssueForPublish -IssueNumber 905 -GitHubRepo $repoName -LabelReady $readyLabel
Test-Case 'T37b closed issue -> verification refuses publication' ((-not $v37b.Ok) -and ($v37b.Message -match 'not open')) $v37b.Message
Reset-FakeGh -Mode 'view-nolabel'
$v37c = Verify-IssueForPublish -IssueNumber 905 -GitHubRepo $repoName -LabelReady $readyLabel
Test-Case 'T37c missing ready label -> verification refuses publication' ((-not $v37c.Ok) -and ($v37c.Message -match 'ready-for-opencode')) $v37c.Message
Reset-FakeGh -Mode 'view-wrongnumber'
$v37d = Verify-IssueForPublish -IssueNumber 905 -GitHubRepo $repoName -LabelReady $readyLabel
Test-Case 'T37d GitHub returns a DIFFERENT issue number -> refused (identity guard)' ((-not $v37d.Ok) -and ($v37d.Message -match 'different issue')) $v37d.Message
Reset-FakeGh -Mode 'view-fail'
$v37e = Verify-IssueForPublish -IssueNumber 905 -GitHubRepo $repoName -LabelReady $readyLabel
Test-Case 'T37e gh issue view failure -> verification refuses publication' ((-not $v37e.Ok) -and ($v37e.Message -match 'gh issue view failed')) $v37e.Message

# --- T38: FULL Stage 2 runs with publishing (fake gh, Local task source) ----
# A fake agent that makes a REAL change and CLAIMS a different issue number
# in its output: the report must still target the dispatcher's issue.
$agentOkMentions = Join-Path $fakeBin 'fakeagent-ok-mentions.ps1'
Set-Content -LiteralPath $agentOkMentions -Encoding UTF8 -Value @'
param()
Set-Content -LiteralPath 'agent-output.txt' -Value ('fake change ' + (Get-Date -Format o)) -Encoding UTF8
Write-Output 'Finished issue #1234 - please review.'
exit 0
'@
$env:Path = "$fakeBin;$env:Path"

# T38a: SUCCESS + publication (report goes to the executed issue)
Reset-FakeGh -Mode 'ok'
$task38a = New-LocalTaskFile -Number 920 -Body 'Add a hello file.'
$cfg38a = New-Stage2Config -TaskFile $task38a -Agent 'fakeagent-ok-mentions' -TaskTimeout '60' -RunRoot (Join-Path $testRoot 'runs-t38a')
$cfg38aText = [IO.File]::ReadAllText($cfg38a).TrimEnd().TrimEnd('}') + "    PublishReport = 'True'`r`n    VerifyIssueBeforePublish = 'True'`r`n}"
[IO.File]::WriteAllText($cfg38a, $cfg38aText)
$run38a = Invoke-Dispatcher -ConfigPath $cfg38a -SkipModelPing -Stage2
$log38a = Get-FakeGhLog
$logDir38a = ([regex]::Match([IO.File]::ReadAllText($cfg38a), "LogDir\s*=\s*'([^']+)'")).Groups[1].Value
$local38a = @(Get-ChildItem -LiteralPath $logDir38a -Filter '*-issue-920-report.md' -ErrorAction SilentlyContinue)
Test-Case 'T38a full run SUCCESS -> report published AND confirmed on issue #920' (($run38a.ExitCode -eq 0) -and ($run38a.Output -match 'Report published AND confirmed for Issue #920') -and ($log38a -match 'issue \| view \| 920') -and ($log38a -match 'issue \| comment \| 920') -and ($run38a.Output -match 'result: SUCCESS')) ("exit {0}" -f $run38a.ExitCode)
$t38aBody = ''
$m38a = [regex]::Match($log38a, '(?s)---BODY---\r?\n(.*?)\r?\n---END-BODY---')
if ($m38a.Success) { $t38aBody = $m38a.Groups[1].Value }
Test-Case 'T38b report carries verification facts; agent claim stays UNVERIFIED text; wrong number never targeted' (($t38aBody -match 'Dispatcher Status:\*\* SUCCESS') -and ($t38aBody -match 'Agent Exit Code:\*\* 0') -and ($t38aBody -match 'Finished issue #1234') -and ($t38aBody -match 'NOT Verified') -and ($t38aBody -match 'git diff --stat HEAD') -and ($log38a -notmatch 'issue \| comment \| 1234') -and ($local38a.Count -eq 0)) $(if ($t38aBody) { 'body captured; no local file expected' } else { 'NO BODY CAPTURED' })

# T38c: NO_CHANGES + publication (cause of "no changes" must be in the report)
Reset-FakeGh -Mode 'ok'
$task38c = New-LocalTaskFile -Number 921 -Body 'Do nothing.'
$cfg38c = New-Stage2Config -TaskFile $task38c -Agent 'fakeagent-noop' -TaskTimeout '60' -RunRoot (Join-Path $testRoot 'runs-t38c')
$cfg38cText = [IO.File]::ReadAllText($cfg38c).TrimEnd().TrimEnd('}') + "    PublishReport = 'True'`r`n}"
[IO.File]::WriteAllText($cfg38c, $cfg38cText)
$run38c = Invoke-Dispatcher -ConfigPath $cfg38c -SkipModelPing -Stage2
$log38c = Get-FakeGhLog
$t38cOk = ($run38c.ExitCode -eq 0) -and ($run38c.Output -match 'result: NO_CHANGES') -and ($run38c.Output -match 'Report published AND confirmed for Issue #921') -and ($log38c -match 'Dispatcher Status:\*\* NO_CHANGES') -and ($log38c -match 'No Changes Reason') -and ($log38c -match 'zero changed paths')
Test-Case 'T38c NO_CHANGES -> report published with the no-changes cause' $t38cOk ("exit {0}" -f $run38c.ExitCode)

# T38d: TIMEOUT + publication (timeout cause must be in the report)
Reset-FakeGh -Mode 'ok'
$task38d = New-LocalTaskFile -Number 922 -Body 'Hang forever.'
$cfg38d = New-Stage2Config -TaskFile $task38d -Agent 'fakeagent-hang' -TaskTimeout '4' -RunRoot (Join-Path $testRoot 'runs-t38d')
$cfg38dText = [IO.File]::ReadAllText($cfg38d).TrimEnd().TrimEnd('}') + "    PublishReport = 'True'`r`n}"
[IO.File]::WriteAllText($cfg38d, $cfg38dText)
$run38d = Invoke-Dispatcher -ConfigPath $cfg38d -SkipModelPing -Stage2
$log38d = Get-FakeGhLog
$t38dOk = ($run38d.ExitCode -eq 2) -and ($run38d.Output -match 'result: TIMEOUT') -and ($run38d.Output -match 'Report published AND confirmed for Issue #922') -and ($log38d -match 'Dispatcher Status:\*\* TIMEOUT') -and ($log38d -match 'TaskTimeoutSec=4s') -and ($log38d -match 'killed on timeout')
Test-Case 'T38d TIMEOUT -> report published with timeout cause and killed-agent exit code' $t38dOk ("exit {0}" -f $run38d.ExitCode)

# T38e: publishing DISABLED (default) -> the fake gh must see NO call at all
$fakeGhLogDisabled = Join-Path $testRoot 'fakegh-disabled.log'
$env:FAKE_GH_MODE = 'ok'
$env:FAKE_GH_LOG = $fakeGhLogDisabled
$task38e = New-LocalTaskFile -Number 923 -Body 'No publish expected.'
$cfg38e = New-Stage2Config -TaskFile $task38e -Agent 'fakeagent-noop' -TaskTimeout '60' -RunRoot (Join-Path $testRoot 'runs-t38e')
$run38e = Invoke-Dispatcher -ConfigPath $cfg38e -SkipModelPing -Stage2
$t38eOk = ($run38e.ExitCode -eq 0) -and ($run38e.Output -match 'result: NO_CHANGES') -and
    ($run38e.Output -match 'Report publishing is disabled') -and (-not (Test-Path -LiteralPath $fakeGhLogDisabled))
Test-Case 'T38e PublishReport default OFF -> no gh call, no comment, explicit skip message' $t38eOk ("exit {0}; gh log created: {1}" -f $run38e.ExitCode, (Test-Path -LiteralPath $fakeGhLogDisabled))

# T38f: publication fails mid-run -> stage result preserved, local report kept
Reset-FakeGh -Mode 'comment-fail'
$task38f = New-LocalTaskFile -Number 924 -Body 'Change, but publish will fail.'
$cfg38f = New-Stage2Config -TaskFile $task38f -Agent 'fakeagent-ok' -TaskTimeout '60' -RunRoot (Join-Path $testRoot 'runs-t38f')
$cfg38fText = [IO.File]::ReadAllText($cfg38f).TrimEnd().TrimEnd('}') + "    PublishReport = 'True'`r`n    VerifyIssueBeforePublish = 'True'`r`n}"
[IO.File]::WriteAllText($cfg38f, $cfg38fText)
$run38f = Invoke-Dispatcher -ConfigPath $cfg38f -SkipModelPing -Stage2
$logDir38f = ([regex]::Match([IO.File]::ReadAllText($cfg38f), "LogDir\s*=\s*'([^']+)'")).Groups[1].Value
$local38f = @(Get-ChildItem -LiteralPath $logDir38f -Filter '*-issue-924-report.md' -ErrorAction SilentlyContinue)
$local38fText = if ($local38f.Count -eq 1) { [IO.File]::ReadAllText($local38f[0].FullName) } else { '' }
Test-Case 'T38f publish failure during a full run -> stage exit kept, ERROR logged, local report saved' (($run38f.ExitCode -eq 0) -and ($run38f.Output -match 'Report publication FAILED for Issue #924') -and ($run38f.Output -notmatch 'published AND confirmed') -and ($local38f.Count -eq 1) -and ($local38fText -match 'Published to GitHub: NO') -and ($local38fText -match 'Stage 2 Execution Report')) ("exit {0}; local reports: {1}" -f $run38f.ExitCode, $local38f.Count)

# T38g: issue verification refuses (closed issue) -> nothing posted, local copy
Reset-FakeGh -Mode 'view-closed'
$task38g = New-LocalTaskFile -Number 925 -Body 'Would run, but publish verify refuses.'
$cfg38g = New-Stage2Config -TaskFile $task38g -Agent 'fakeagent-noop' -TaskTimeout '60' -RunRoot (Join-Path $testRoot 'runs-t38g')
$cfg38gText = [IO.File]::ReadAllText($cfg38g).TrimEnd().TrimEnd('}') + "    PublishReport = 'True'`r`n    VerifyIssueBeforePublish = 'True'`r`n}"
[IO.File]::WriteAllText($cfg38g, $cfg38gText)
$run38g = Invoke-Dispatcher -ConfigPath $cfg38g -SkipModelPing -Stage2
$log38g = Get-FakeGhLog
$logDir38g = ([regex]::Match([IO.File]::ReadAllText($cfg38g), "LogDir\s*=\s*'([^']+)'")).Groups[1].Value
$local38g = @(Get-ChildItem -LiteralPath $logDir38g -Filter '*-issue-925-report.md' -ErrorAction SilentlyContinue)
Test-Case 'T38g verify refuses (issue closed) -> NO comment posted, local report saved, no success claimed' (($run38g.Output -match 'issue verification refused publication') -and ($log38g -notmatch 'ARGS: issue \| comment') -and ($local38g.Count -eq 1) -and ($run38g.Output -notmatch 'published AND confirmed')) ("exit {0}" -f $run38g.ExitCode)

# --- restore PATH + env: the REAL gh must serve the T34 snapshots again -----
$env:Path = $pathBeforeFakeGh
Remove-Item Env:\FAKE_GH_MODE -ErrorAction SilentlyContinue
Remove-Item Env:\FAKE_GH_LOG -ErrorAction SilentlyContinue

# --- T34: final GitHub + repository invariants ------------------------------
$issuesFinal = Get-GhJsonSnapshot -Kind Issues
$prsFinal = Get-GhJsonSnapshot -Kind PullRequests
Test-Case 'T34a real Issues unchanged across the whole suite (incl. stage 2)' ($issuesBefore -ceq $issuesFinal) 'snapshot before vs after'
Test-Case 'T34b real PRs unchanged across the whole suite (incl. stage 2)' ($prsBefore -ceq $prsFinal) 'snapshot before vs after'
$realStatusFinal = & git -C $realRepoPath status --porcelain | Out-String
$realWorktreesFinal = @((& git -C $realRepoPath worktree list --porcelain | Out-String) -split "`r?`n" | Where-Object { $_ -match '^worktree ' }).Count
$realHiddenFinal = @(& git -C $realRepoPath ls-files -v | Where-Object { $_ -cmatch '^S\s' -or $_ -cmatch '^[a-z]' })
$realIdentical = ($realStatusFinal -ceq $realStatusBefore)
Test-Case 'T34c real repository identical to the T0 baseline, no index flags' ($realIdentical -and $realHiddenFinal.Count -eq 0) ("status identical: {0}; hidden index entries: {1}" -f $realIdentical, $realHiddenFinal.Count)
Test-Case 'T34d real repository worktrees unchanged (none added by tests)' ($realWorktreesFinal -eq $realWorktreesBefore) ("worktrees {0} (baseline {1})" -f $realWorktreesFinal, $realWorktreesBefore)
$stage1StatusFinal = & git -C $repoPath status --porcelain | Out-String
$gitRepoTStatusFinal = & git -C $gitRepoT status --porcelain | Out-String
Test-Case 'T34e temporary repositories clean after the suite' ([string]::IsNullOrWhiteSpace($stage1StatusFinal) -and [string]::IsNullOrWhiteSpace($gitRepoTStatusFinal)) ("stage1 clean: {0}; t2x clean: {1}" -f [string]::IsNullOrWhiteSpace($stage1StatusFinal), [string]::IsNullOrWhiteSpace($gitRepoTStatusFinal))

# --- summary --------------------------------------------------------------
$failed = @($script:Results | Where-Object { -not $_.Passed })
Write-Host ''
Write-Host ('Total: {0}, passed: {1}, failed: {2}' -f $script:Results.Count, ($script:Results.Count - $failed.Count), $failed.Count) -ForegroundColor $(if ($failed.Count -eq 0) { 'Green' } else { 'Red' })
Write-Host ('Temp workspace kept for inspection: {0}' -f $testRoot) -ForegroundColor Cyan
if ($failed.Count -gt 0) { exit 1 }
exit 0

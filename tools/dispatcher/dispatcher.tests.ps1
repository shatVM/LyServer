#requires -Version 5.1
<#
.SYNOPSIS
    Stage 1 test harness for dispatcher.ps1 (PowerShell 5.1).
.DESCRIPTION
    Runs intentional negative and positive scenarios against the REAL
    dispatcher functions (extracted via AST from dispatcher.ps1) and the
    real script as a child process. All temp state lives outside the
    repository; the harness verifies GitHub state is unchanged at the end.
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
foreach ($fnName in @('ConvertTo-WinArg', 'Resolve-Command', 'Invoke-Native', 'Test-PongResponse', 'Test-PathInside')) {
    $match = @($fnAsts | Where-Object { $_.Name -eq $fnName })
    if ($match.Count -eq 0) { Write-Host ("FAIL: function {0} not found in dispatcher.ps1" -f $fnName); exit 1 }
    Invoke-Expression $match[0].Extent.Text
}

# --- temp workspace (outside the repository) ------------------------------
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('lyserver-dispatcher-tests-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

$repoPath = "$HOME\Documents\LyServer"

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
    param([string]$ConfigPath, [switch]$SkipModelPing)
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $DispatcherPath)
    if ($ConfigPath) { $argList += @('-ConfigPath', $ConfigPath) }
    if ($SkipModelPing) { $argList += '-SkipModelPing' }
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
$expectedArgs = @('plain', 'with space', 'quo"te', 'trail\', 'back\slash', 'mix \"quoted\" tail', 'Кирилиця перевірка', 'tab	value')
$outFile = Join-Path $testRoot 'args-out.txt'
$run = Invoke-Native -Tool 'powershell.exe' -ArgumentList (@('-NoProfile', '-File', $echoScript, $outFile) + $expectedArgs)
$actualArgs = if (Test-Path $outFile) { @([IO.File]::ReadAllLines($outFile)) } else { @() }
$t1ok = ($run.ExitCode -eq 0) -and ($actualArgs.Count -eq $expectedArgs.Count)
if ($t1ok) {
    for ($i = 0; $i -lt $expectedArgs.Count; $i++) { if ($actualArgs[$i] -cne $expectedArgs[$i]) { $t1ok = $false; break } }
}
Test-Case 'T1 quoting round-trip (space/quotes/backslash/Cyrillic/tab)' $t1ok ("received {0}/{1} args" -f $actualArgs.Count, $expectedArgs.Count)

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

# === T10: GitHub state unchanged by the whole suite
$issuesNow = @(((& gh issue list -R shatVM/LyServer --state open --json number,labels) | Out-String) | ConvertFrom-Json | ForEach-Object { $_ })
$prsNow = (& gh pr list -R shatVM/LyServer --state all --json number | Out-String)
function Get-LabelNames($issue) { return @($issue.labels | ForEach-Object { $_.name }) }
$issue3 = @($issuesNow | Where-Object { $_.number -eq 3 })
$issue2 = @($issuesNow | Where-Object { $_.number -eq 2 })
$labelsOk = ($issue3.Count -eq 1 -and (Get-LabelNames $issue3[0]) -contains 'in-progress' -and
             $issue2.Count -eq 1 -and (Get-LabelNames $issue2[0]) -contains 'ready-for-opencode')
$prsOk = ($prsNow -match '"number":4' -and $prsNow -notmatch '"number":5')
Test-Case 'T10a GitHub issue labels unchanged' $labelsOk '#3 in-progress, #2 ready'
Test-Case 'T10b no new PRs created (only pre-existing #4)' $prsOk ''
$gitStatus = & git -C $repoPath status --porcelain | Out-String
Test-Case 'T10c repository working tree clean' ([string]::IsNullOrWhiteSpace($gitStatus)) 'no probe/temp files left'

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

# --- summary --------------------------------------------------------------
$failed = @($script:Results | Where-Object { -not $_.Passed })
Write-Host ''
Write-Host ('Total: {0}, passed: {1}, failed: {2}' -f $script:Results.Count, ($script:Results.Count - $failed.Count), $failed.Count) -ForegroundColor $(if ($failed.Count -eq 0) { 'Green' } else { 'Red' })
Write-Host ('Temp workspace kept for inspection: {0}' -f $testRoot) -ForegroundColor Cyan
if ($failed.Count -gt 0) { exit 1 }
exit 0

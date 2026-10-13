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

# === T1: argument quoting round-trip (spaces, quotes, backslash, Cyrillic)
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
    @{ In = "`e[32mPONG`e[0m`n";        Expect = $true;  Label = 'ANSI-wrapped accepted' }
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
$labelsNow = & gh issue list -R shatVM/LyServer --state open --json number,labels | Out-String
$prsNow = & gh pr list -R shatVM/LyServer --state all --json number | Out-String
$expectedLabels = @'
{"labels":["in-progress"],"number":3}
{"labels":["ready-for-opencode"],"number":2}
{"labels":[],"number":1}
'@
$labelsOk = ($labelsNow -match '"number":3' -and $labelsNow -match '"labels":\["in-progress"\]' -and $labelsNow -match '"number":2' -and $labelsNow -match '"labels":\["ready-for-opencode"\]')
$prsOk = ($prsNow -match '"number":4' -and $prsNow -notmatch '"number":5')
Test-Case 'T10a GitHub issue labels unchanged' $labelsOk '#3 in-progress, #2 ready'
Test-Case 'T10b no new PRs created (only pre-existing #4)' $prsOk ''
$gitStatus = & git -C $repoPath status --porcelain | Out-String
Test-Case 'T10c repository working tree clean' ([string]::IsNullOrWhiteSpace($gitStatus)) 'no probe/temp files left'

# --- summary --------------------------------------------------------------
$failed = @($script:Results | Where-Object { -not $_.Passed })
Write-Host ''
Write-Host ('Total: {0}, passed: {1}, failed: {2}' -f $script:Results.Count, ($script:Results.Count - $failed.Count), $failed.Count) -ForegroundColor $(if ($failed.Count -eq 0) { 'Green' } else { 'Red' })
Write-Host ('Temp workspace kept for inspection: {0}' -f $testRoot) -ForegroundColor Cyan
if ($failed.Count -gt 0) { exit 1 }
exit 0

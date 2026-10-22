# Fake install script for the P4-02 tests (not the real one). ASCII only on purpose.
# It never touches ~/.claude. Next to it the test puts: <op>.out (stdout bytes), <op>.exit (exit code), <op>.sleep (seconds).
# <op> is one of: plan, install, backups, restore-plan, restore.
$ErrorActionPreference = 'Stop'
$line = "$args"
if ($line -match '-Backups') { $op = 'backups' }
elseif ($line -match '-Restore') { if ($line -match '-Plan') { $op = 'restore-plan' } else { $op = 'restore' } }
elseif ($line -match '-Plan') { $op = 'plan' }
else { $op = 'install' }

$log = Join-Path $PSScriptRoot 'calls.log'
$entry = "$op|$line|CFG=$env:CLAUDE_CONFIG_DIR|HOME=$env:CLAUDE_HARNESS_HOME`n"
[IO.File]::AppendAllText($log, $entry)

$sleepFile = Join-Path $PSScriptRoot "$op.sleep"
if (Test-Path $sleepFile) { Start-Sleep -Seconds ([int](Get-Content $sleepFile -TotalCount 1)) }

$outFile = Join-Path $PSScriptRoot "$op.out"
if (Test-Path $outFile) {
    $bytes = [IO.File]::ReadAllBytes($outFile)
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

$exitFile = Join-Path $PSScriptRoot "$op.exit"
if (Test-Path $exitFile) { exit ([int](Get-Content $exitFile -TotalCount 1)) }
exit 0

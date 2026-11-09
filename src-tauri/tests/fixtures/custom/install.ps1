# Fake install script for the P9-01 tests (not the real one). ASCII only on purpose. It never touches ~/.claude.
# Like tests/fixtures/harness/install.ps1, and it also records which files it saw under <harness home>/custom/agents and /skills
# (so a test can tell what the install saw). calls.log line: "<op>|<sorted relative file list>".
# Next to it the test puts: <op>.out (stdout bytes), <op>.exit (exit code).
$ErrorActionPreference = 'Stop'
$line = "$args"
if ($line -match '-Backups') { $op = 'backups' }
elseif ($line -match '-Restore') { if ($line -match '-Plan') { $op = 'restore-plan' } else { $op = 'restore' } }
elseif ($line -match '-Plan') { $op = 'plan' }
else { $op = 'install' }

$custom = Join-Path $env:CLAUDE_HARNESS_HOME 'custom'
$seen = @()
foreach ($sub in 'agents', 'skills') {
    $dir = Join-Path $custom $sub
    if (Test-Path -LiteralPath $dir) {
        foreach ($f in (Get-ChildItem -LiteralPath $dir -Recurse -File -Force)) {
            $seen += $f.FullName.Substring($custom.Length + 1).Replace('\', '/')
        }
    }
}
$seen = @($seen | Sort-Object { $_ } )
$log = Join-Path $PSScriptRoot 'calls.log'
[IO.File]::AppendAllText($log, "$op|" + ($seen -join ',') + "`n")

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

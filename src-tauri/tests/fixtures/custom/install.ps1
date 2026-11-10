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

# --- P9-06 extra modes (off unless the test drops the marker file next to this script; files, not env vars, so parallel tests do not leak) ---
# `<op>.sleep`: seconds to wait (after calls.log was written) before answering - a slow install.
$sleepFile = Join-Path $PSScriptRoot "$op.sleep"
if (Test-Path $sleepFile) { Start-Sleep -Milliseconds ([int]([double](Get-Content $sleepFile -TotalCount 1) * 1000)) }
# `strict`: an install sees a `.values.yml` / `.append.md` in custom/agents whose agent exists neither in custom nor in the source -> exit 3 (like the real script).
$forced = $null
if (($op -eq 'install') -and (Test-Path (Join-Path $PSScriptRoot 'strict'))) {
    $agentsDir = Join-Path $custom 'agents'
    if (Test-Path -LiteralPath $agentsDir) {
        foreach ($f in (Get-ChildItem -LiteralPath $agentsDir -File -Force)) {
            $n = $null
            if ($f.Name.EndsWith('.values.yml')) { $n = $f.Name.Substring(0, $f.Name.Length - 11) }
            elseif ($f.Name.EndsWith('.append.md')) { $n = $f.Name.Substring(0, $f.Name.Length - 10) }
            if ($n -and -not (Test-Path -LiteralPath (Join-Path $agentsDir "$n.md")) -and -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "agents/$n.md"))) { $forced = 3 }
        }
    }
}
# `mirror`: a successful install rebuilds $CLAUDE_CONFIG_DIR/agents = source agents/*.md overlaid by custom/agents/*.md (not *.append.md).
if (($op -eq 'install') -and ($null -eq $forced) -and (Test-Path (Join-Path $PSScriptRoot 'mirror'))) {
    $dest = Join-Path $env:CLAUDE_CONFIG_DIR 'agents'
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    foreach ($dir in @((Join-Path $PSScriptRoot 'agents'), (Join-Path $custom 'agents'))) {
        if (Test-Path -LiteralPath $dir) {
            foreach ($f in (Get-ChildItem -LiteralPath $dir -File -Force)) {
                if ($f.Name.EndsWith('.md') -and -not $f.Name.EndsWith('.append.md')) { Copy-Item -LiteralPath $f.FullName -Destination $dest -Force }
            }
        }
    }
}

$outFile = Join-Path $PSScriptRoot "$op.out"
if (Test-Path $outFile) {
    $bytes = [IO.File]::ReadAllBytes($outFile)
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

if ($null -ne $forced) { exit $forced }
$exitFile = Join-Path $PSScriptRoot "$op.exit"
if (Test-Path $exitFile) { exit ([int](Get-Content $exitFile -TotalCount 1)) }
exit 0

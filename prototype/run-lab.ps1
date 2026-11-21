[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [ValidateSet('all', 'healthy', 'crash', 'stall', 'invalid', 'crash_loop', 'replay', 'wrong_generation')]
    [string]$Scenario = 'all',
    [ValidateRange(4, 20)][int]$FaultAt = 8,
    [ValidateRange(300, 2000)][int]$WatchdogMs = 700,
    [ValidateRange(0, 3)][int]$RestartLimit = 2,
    [ValidateRange(20, 180)][int]$TimeoutSeconds = 90,
    [string]$SdkRoot = (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'qnx800'),
    [string]$QemuRoot = '',
    [string]$WorkRoot = ''
)

$ErrorActionPreference = 'Stop'
$Scenario = $Scenario.ToLowerInvariant()
$project = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($QemuRoot)) { $QemuRoot = Join-Path $project 'work\qemu-download\qemu' }
if ([string]::IsNullOrWhiteSpace($WorkRoot)) { $WorkRoot = Join-Path $project 'work\qnx-recovery-vm' }
$imageRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($WorkRoot)
$qemuDirectory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($QemuRoot)
$sdk = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SdkRoot)
$qemu = Join-Path $qemuDirectory 'qemu-system-x86_64.exe'
$firmwareSource = Join-Path $qemuDirectory 'share'
$envScript = Join-Path $sdk 'qnxsdp-env.bat'
$source = Join-Path $PSScriptRoot 'src\recovery_lab.c'
$artifacts = Join-Path $PSScriptRoot 'artifacts'

foreach ($required in $qemu, $envScript, $source) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required file is missing: $required"
    }
}
if (!(Test-Path -LiteralPath $firmwareSource -PathType Container)) {
    throw "QEMU firmware directory is missing: $firmwareSource"
}

function ConvertTo-QemuArgument([string]$Value) {
    # Windows argv rules double backslashes before a quote or the closing quote.
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

[void][IO.Directory]::CreateDirectory($imageRoot)
[void][IO.Directory]::CreateDirectory($artifacts)
$runLockPath = Join-Path $imageRoot '.run.lock'
try {
    $runLock = [IO.File]::Open($runLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch {
    throw 'Another Recovery Lab run is using this VM directory. Wait for it to finish.'
}
try {
$runId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$attemptStarted = (Get-Date).ToUniversalTime().ToString('o')
function Write-RunAttempt([string]$Status, [string]$Detail = '') {
    $attempt = [ordered]@{
        schema_version = 1
        run_id = $runId
        status = $Status
        started_at = $attemptStarted
        updated_at = (Get-Date).ToUniversalTime().ToString('o')
        scenario = $Scenario
        detail = $Detail
    }
    $attemptPending = Join-Path $artifacts "attempt-$runId.pending"
    $attempt | ConvertTo-Json | Set-Content -LiteralPath $attemptPending -Encoding utf8NoBOM
    [IO.File]::Move($attemptPending, (Join-Path $artifacts 'latest-attempt.json'), $true)
}
Write-RunAttempt 'running'
$output = Join-Path $imageRoot 'output'
$binary = Join-Path $imageRoot 'recovery-lab'
$buildMetadata = Join-Path $imageRoot 'build-metadata.json'
$boot = Join-Path $output 'ifs.bin'
$disk = Join-Path $output 'disk-qemu'
$requestedConfig = [ordered]@{
    scenario = $Scenario
    fault_at = $FaultAt
    watchdog_ms = $WatchdogMs
    restart_limit = $RestartLimit
}
$guestArguments = "--scenario=$Scenario --fault-at=$FaultAt --watchdog-ms=$WatchdogMs --restart-limit=$RestartLimit"

if (!$SkipBuild) {
    $snippets = Join-Path $imageRoot 'local\snippets'
    [void][IO.Directory]::CreateDirectory($snippets)
    $ifsSnippet = "[uid=0 gid=0 perms=0555] recovery-lab=./recovery-lab`n"
    [IO.File]::WriteAllText((Join-Path $snippets 'ifs_files.recovery'), $ifsSnippet, [Text.Encoding]::ASCII)
    $startup = @'
{
    /proc/boot/recovery-lab __LAB_ARGUMENTS__
    result=$?
    echo "RECOVERY_RUN_EXIT=$result"
} > /dev/ser1 2>&1
'@
    $startup = $startup.Replace('__LAB_ARGUMENTS__', $guestArguments)
    [IO.File]::WriteAllText((Join-Path $snippets 'post_start.recovery'), $startup.Replace("`r", '') + "`n", [Text.Encoding]::ASCII)
    Copy-Item -LiteralPath $source -Destination (Join-Path $imageRoot 'recovery_lab.c')
    Push-Location -LiteralPath $imageRoot
    try {
        $compile = 'call "{0}" && qcc -Vgcc_ntox86_64 -std=c11 -D_QNX_SOURCE -Wall -Wextra -Werror -O2 -o recovery-lab recovery_lab.c' -f $envScript
        & $env:ComSpec /d /q /s /c $compile
        if ($LASTEXITCODE -ne 0) { throw 'QNX compilation failed.' }
        $compilerCommand = 'call "{0}" && qcc --version' -f $envScript
        $compilerVersion = @(& $env:ComSpec /d /q /s /c $compilerCommand 2>&1)
        if ($LASTEXITCODE -ne 0) { throw 'QNX compiler version check failed.' }
        # Remove generated targets so a builder error cannot silently reuse a previous image.
        foreach ($generated in $boot, $disk) {
            if (Test-Path -LiteralPath $generated -PathType Leaf) { Remove-Item -LiteralPath $generated }
        }
        $build = 'call "{0}" && mkqnximage --type=qemu --arch=x86_64 --boot-mode=qemu --graphics=no --hostname=recovery-lab --cpu=1 --ram=512M --data-size=32 --sys-size=128 --ssh-ident=none --build' -f $envScript
        & $env:ComSpec /d /q /s /c $build 2>&1 | Tee-Object -FilePath (Join-Path $imageRoot 'build.log')
        if ($LASTEXITCODE -ne 0) { throw 'QNX image generation failed.' }
        if (!(Test-Path -LiteralPath $boot -PathType Leaf) -or !(Test-Path -LiteralPath $disk -PathType Leaf)) {
            throw 'QNX image builder did not create the expected boot and disk files.'
        }
        [ordered]@{
            compiler = ($compilerVersion | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ }) -join ' '
            flags = '-Vgcc_ntox86_64 -std=c11 -D_QNX_SOURCE -Wall -Wextra -Werror -O2'
            config = $requestedConfig
            source_sha256 = (Get-FileHash -LiteralPath (Join-Path $imageRoot 'recovery_lab.c') -Algorithm SHA256).Hash.ToLowerInvariant()
            binary_sha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
            boot_sha256 = (Get-FileHash -LiteralPath $boot -Algorithm SHA256).Hash.ToLowerInvariant()
            disk_sha256 = (Get-FileHash -LiteralPath $disk -Algorithm SHA256).Hash.ToLowerInvariant()
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $buildMetadata -Encoding utf8NoBOM
    } finally {
        Pop-Location
    }
}

foreach ($required in $binary, $boot, $disk, $buildMetadata) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Image file is missing: $required" }
}
$buildInfo = Get-Content -LiteralPath $buildMetadata -Raw | ConvertFrom-Json
foreach ($setting in $requestedConfig.Keys) {
    if ($buildInfo.config.$setting -ne $requestedConfig[$setting]) {
        throw 'The saved image has different scenario settings. Run again without -SkipBuild.'
    }
}
foreach ($component in @(
    @{ Path = $binary; Hash = $buildInfo.binary_sha256 },
    @{ Path = $boot; Hash = $buildInfo.boot_sha256 },
    @{ Path = $disk; Hash = $buildInfo.disk_sha256 },
    @{ Path = (Join-Path $imageRoot 'recovery_lab.c'); Hash = $buildInfo.source_sha256 }
)) {
    if ((Get-FileHash -LiteralPath $component.Path -Algorithm SHA256).Hash -ne $component.Hash) {
        throw 'A saved build file changed. Run again without -SkipBuild to rebuild consistent evidence.'
    }
}

$consoleLog = Join-Path $artifacts "guest-$runId.log"
$guestConsole = Join-Path $imageRoot "guest-$runId.log"
$qemuLog = Join-Path $artifacts "qemu-$runId.log"
$overlayName = "recovery-disk-$runId.raw"
$overlay = Join-Path $output $overlayName
$relativeFirmware = [IO.Path]::GetRelativePath($imageRoot, $firmwareSource).Replace('\', '/')
$firmwareStage = $null
# Keep QEMU file arguments ASCII, including when the work directory is on another drive.
$arguments = @(
    '-accel', 'tcg', '-machine', 'pc', '-cpu', 'max', '-smp', '1', '-m', '512',
    '-L', $relativeFirmware, '-kernel', 'output/ifs.bin',
    '-drive', "file=output/$overlayName,if=ide,format=raw",
    '-nic', 'none', '-display', 'none', '-monitor', 'none',
    '-object', 'rng-builtin,id=rng0', '-device', 'virtio-rng-pci,rng=rng0',
    '-serial', "file:guest-$runId.log", '-no-reboot'
)

$vm = $null
try {
    if ($relativeFirmware -match '[^\x20-\x7e]') {
        $firmwareStage = Join-Path $imageRoot "qemu-firmware-$runId"
        Copy-Item -LiteralPath $firmwareSource -Destination $firmwareStage -Recurse
        $relativeFirmware = "qemu-firmware-$runId"
        $arguments[$arguments.IndexOf('-L') + 1] = $relativeFirmware
    }
    Copy-Item -LiteralPath $disk -Destination $overlay
    $quotedArguments = ($arguments | ForEach-Object { ConvertTo-QemuArgument $_ }) -join ' '
    $vm = Start-Process -FilePath $qemu -ArgumentList $quotedArguments -WorkingDirectory $imageRoot `
        -RedirectStandardError $qemuLog -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $completed = $false
    do {
        if (Test-Path -LiteralPath $guestConsole) {
            $lines = @(Get-Content -LiteralPath $guestConsole)
            if ($lines -match '^RECOVERY_RUN_EXIT=-?\d+') { $completed = $true; break }
        }
        if ($vm.HasExited) { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    if (!$completed) {
        if (Test-Path -LiteralPath $guestConsole) { Get-Content -LiteralPath $guestConsole -Tail 15 }
        if (Test-Path -LiteralPath $qemuLog) { Get-Content -LiteralPath $qemuLog -Tail 10 }
        throw "Guest did not complete. See $consoleLog"
    }

    # Close QEMU's serial-file handle and freeze the complete evidence before hashing it.
    if (!$vm.HasExited) { $vm.Kill(); $vm.WaitForExit() }
    Copy-Item -LiteralPath $guestConsole -Destination $consoleLog
    $lines = @(Get-Content -LiteralPath $consoleLog)

    $events = @($lines | Where-Object { $_.StartsWith('RECOVERY_EVENT ') } | ForEach-Object { $_.Substring(15) | ConvertFrom-Json })
    $summaries = @($events | Where-Object event -eq 'summary')
    $environmentLine = @($lines | Where-Object { $_.StartsWith('RECOVERY_ENV ') })
    if ($environmentLine.Count -ne 1) { throw 'The guest did not report its operating system.' }
    $environment = $environmentLine[0].Substring(13) | ConvertFrom-Json
    $configLine = @($lines | Where-Object { $_.StartsWith('RECOVERY_CONFIG ') })
    if ($configLine.Count -ne 1) { throw 'The guest did not report its scenario configuration.' }
    $guestConfig = $configLine[0].Substring(16) | ConvertFrom-Json
    foreach ($setting in $requestedConfig.Keys) {
        if ($guestConfig.$setting -ne $requestedConfig[$setting]) { throw "The guest configuration differs for $setting." }
    }
    $environment | Add-Member -NotePropertyName emulator -NotePropertyValue 'QEMU TCG on Windows'
    $environment | Add-Member -NotePropertyName toolchain -NotePropertyValue $buildInfo.compiler
    $environment | Add-Member -NotePropertyName measurement -NotePropertyValue 'Guest monotonic clock under software emulation'
    $report = [ordered]@{
        schema_version = 1
        suite_version = 2
        recorded_at = (Get-Date).ToUniversalTime().ToString('o')
        environment = $environment
        config = $guestConfig
        events = $events
        scenarios = $summaries
        evidence = [ordered]@{
            console = "guest-$runId.log"
            console_sha256 = (Get-FileHash -LiteralPath $consoleLog -Algorithm SHA256).Hash.ToLowerInvariant()
            source_snapshot = "source-$runId.c"
            source_sha256 = $buildInfo.source_sha256
            binary_sha256 = $buildInfo.binary_sha256
            boot_sha256 = $buildInfo.boot_sha256
            disk_sha256 = $buildInfo.disk_sha256
            build_flags = $buildInfo.flags
        }
    }
    Copy-Item -LiteralPath (Join-Path $imageRoot 'recovery_lab.c') -Destination (Join-Path $artifacts "source-$runId.c")
    $json = $report | ConvertTo-Json -Depth 10
    $runReport = Join-Path $artifacts "run-$runId.json"
    $json | Set-Content -LiteralPath $runReport -Encoding utf8NoBOM
    $pendingReport = Join-Path $artifacts "pending-$runId.json"
    $json | Set-Content -LiteralPath $pendingReport -Encoding utf8NoBOM
    $summaries | Select-Object scenario,outcome,passed,restarts,accepted,rejected,recovery_delay_ms | Format-Table -AutoSize
    $scenarioNames = (@($summaries | ForEach-Object scenario | Sort-Object) -join ',')
    $expectedScenarios = if ($Scenario -eq 'all') { 'crash,crash_loop,healthy,invalid,replay,stall,wrong_generation' } else { $Scenario }
    if ($scenarioNames -ne $expectedScenarios -or $environment.os -ne 'QNX' `
        -or @($summaries | Where-Object { !$_.passed }).Count -gt 0 `
        -or !($lines -contains 'RECOVERY_LAB_EXIT=0') -or !($lines -contains 'RECOVERY_RUN_EXIT=0')) {
        throw "A QNX scenario failed. Its trace is archived at $runReport. The latest verified recording was retained."
    }
    & python (Join-Path $PSScriptRoot 'check_trace.py') $runReport
    if ($LASTEXITCODE -ne 0) { throw 'Independent trace verification failed.' }
    & python (Join-Path $PSScriptRoot 'export_report.py') $runReport
    if ($LASTEXITCODE -ne 0) { throw 'Raw guest evidence verification or report export failed.' }
    foreach ($extension in '.md', '.junit.xml', '.manifest.json') {
        $exported = Join-Path $artifacts "run-$runId$extension"
        $pendingExport = Join-Path $artifacts "pending-$runId$extension"
        Copy-Item -LiteralPath $exported -Destination $pendingExport
        [IO.File]::Move($pendingExport, (Join-Path $artifacts "latest$extension"), $true)
    }
    # Publish the trace last, after the full run and all derived reports pass verification.
    [IO.File]::Move($pendingReport, (Join-Path $artifacts 'latest.json'), $true)
    Write-RunAttempt 'passed' "run-$runId.json"
    "QNX guest completed the selected scenarios. Evidence: $runReport"
} finally {
    if ($vm) {
        if (!$vm.HasExited) { $vm.Kill(); $vm.WaitForExit() }
        $vm.Dispose()
    }
    if (Test-Path -LiteralPath $guestConsole -PathType Leaf) {
        Copy-Item -LiteralPath $guestConsole -Destination $consoleLog -Force
        Remove-Item -LiteralPath $guestConsole
    }
    if (Test-Path -LiteralPath $overlay -PathType Leaf) { Remove-Item -LiteralPath $overlay }
    if ($firmwareStage -and (Test-Path -LiteralPath $firmwareStage -PathType Container)) {
        $stageRelative = [IO.Path]::GetRelativePath($imageRoot, [IO.Path]::GetFullPath($firmwareStage))
        if ($stageRelative -ne "qemu-firmware-$runId") { throw 'Unexpected firmware staging path.' }
        Remove-Item -LiteralPath $firmwareStage -Recurse -Force
    }
}
} catch {
    $failure = $_
    try { Write-RunAttempt 'failed' $failure.Exception.Message } catch { Write-Warning 'Could not record the latest attempt status.' }
    throw $failure
} finally {
    try {
        foreach ($pending in @($pendingReport, $pendingExport)) {
            if ($pending -and (Test-Path -LiteralPath $pending -PathType Leaf)) {
                Remove-Item -LiteralPath $pending
            }
        }
    } finally {
        $runLock.Dispose()
    }
}

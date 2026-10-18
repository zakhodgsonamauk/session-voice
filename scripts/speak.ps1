# Speaks a Claude Code notification: short chime, then Windows' built-in voice.
# Silent when the session's terminal is the focused, non-minimised window (you are already
# looking at it). A named mutex makes concurrent sessions take turns instead of talking over
# each other. Foreground logic adapted from the cc-sounds plugin's play-if-background.ps1,
# but it walks up from -HostPid (the Claude process) because the caller is a detached worker.
#
# Usage: speak.ps1 -Text "<sentence>" [-Chime Alarm09.wav] [-HostPid <claude pid>]
param(
    [Parameter(Mandatory)][string]$Text,
    [string]$Chime = 'Alarm04.wav',
    [int]$HostPid = 0,
    [int]$ChimeMs = 900,
    [string]$Voice = 'Microsoft Hazel Desktop'
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SpeakForegroundNative
{
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
}
"@

$parentByProcessId = @{}
foreach ($process in Get-CimInstance Win32_Process) {
    $parentByProcessId[[int]$process.ProcessId] = [int]$process.ParentProcessId
}

$terminalWindowHandle = [IntPtr]::Zero
$walkProcessId = if ($HostPid -gt 0) { $HostPid } else { $PID }
for ($hop = 0; $hop -lt 8; $hop++) {
    $candidate = Get-Process -Id $walkProcessId -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.MainWindowHandle -ne [IntPtr]::Zero) {
        $terminalWindowHandle = $candidate.MainWindowHandle
        break
    }
    if (-not $parentByProcessId.ContainsKey($walkProcessId)) { break }
    $walkProcessId = $parentByProcessId[$walkProcessId]
    if ($walkProcessId -le 0) { break }
}

if ($terminalWindowHandle -ne [IntPtr]::Zero) {
    $isForeground = [SpeakForegroundNative]::GetForegroundWindow() -eq $terminalWindowHandle
    if ($isForeground -and -not [SpeakForegroundNative]::IsIconic($terminalWindowHandle)) { return }
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\ClaudeCodeSpeak')
$owned = $false
try { $owned = $mutex.WaitOne(120000) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
try {
    $wav = Join-Path $env:WINDIR "Media\$Chime"
    if (Test-Path $wav) {
        $player = New-Object Media.SoundPlayer $wav
        $player.Play()
        Start-Sleep -Milliseconds $ChimeMs
        $player.Stop()
    }
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try { $synth.SelectVoice($Voice) } catch {}
    $synth.Speak($Text)
    $synth.Dispose()
} finally {
    if ($owned) { $mutex.ReleaseMutex() }
}

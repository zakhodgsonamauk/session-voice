#!/usr/bin/env node
// Project check: syntax of both scripts, then the unit tests. No dependencies to install.
// Usage: node check.mjs   (exit code 0 = all good)
import { spawnSync } from 'node:child_process';

const steps = [
  ['speak-notify.mjs syntax', process.execPath, ['--check', 'scripts/speak-notify.mjs']],
  ['speak.ps1 syntax', 'powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'scripts/speak.ps1'), [ref]$null, [ref]$e); " +
    "$e | ForEach-Object { Write-Output $_.ToString() }; exit [int]($e.Count -gt 0)"]],
  ['unit tests', process.execPath, ['--test', 'scripts/speak-notify.test.mjs']],
];

let failed = 0;
for (const [label, cmd, args] of steps) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  const ok = r.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failed++; console.log(String(r.stdout || '') + String(r.stderr || '') + (r.error ? String(r.error) : '')); }
}
process.exitCode = failed ? 1 : 0;

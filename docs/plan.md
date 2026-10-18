# Spoken Session Notifications Implementation Plan

> **Historical record.** This plan built the first version inside `~/.claude/hooks/`, with
> hooks registered in the user's `settings.json`. It now lives in this repo as a plugin:
> `hooks/` below means `scripts/`, the settings entries are in `hooks/hooks.json`, and token
> files go to `$CLAUDE_PLUGIN_DATA`. Code snippets show the first version. The current code
> differs as described in "Follow-ups done" at the end and in `docs/design.md`. Task 8 is
> still open.

> **For Claude:** REQUIRED SUB-SKILL: Use orchestrator-supaconductor:executing-plans to implement this plan task-by-task.

**Goal:** Replace the cc-sounds jingle with a short chime plus Windows text-to-speech saying the session's name and a few words about what happened or what is needed.

**Architecture:** One Node hook (`speak-notify.mjs`) registered for five events works out the session name and what to say, then hands off to a detached copy of itself (`--worker`) so Claude is never held up. The worker gets a Haiku summary via `claude -p` (Stop only), waits until the session is genuinely idle, then calls `speak.ps1`, which does the foreground check, takes a cross-session speaking lock, plays a trimmed chime and speaks.

**Tech Stack:** Node 25 (ESM, `node:test`), Windows PowerShell 5.1, `System.Speech`, Claude Code CLI (`claude.exe`).

**Design:** `conductor/designs/2026-10-18-spoken-session-notify-design.md`
**Git:** `~/.claude` is not a git repository — no commit steps. Back up `settings.json` before editing it.

All paths below are under `C:\Users\zak_h\.claude\`.

## DAG

```
T1 helpers ─┬─ T2 summarise ─┬─ T4 hook+worker ── T6 status check ── T7 settings ── T8 end-to-end
            └─ T3 idle/token ┘                   ┘
T5 speak.ps1 (independent) ───────────────────┘
```

Run sequentially; it is small.

---

### Task 1: Pure helpers (name, words, session lookup, event plan)

- [x] Task 1 done <!-- no-git -->
  - Created hooks/speak-notify.mjs and hooks/speak-notify.test.mjs exactly as planned
  - RED: module not found (0/1). GREEN: 4/4 pass

**Files:**
- Create: `hooks/speak-notify.mjs`
- Test: `hooks/speak-notify.test.mjs`

**Step 1: Write the failing tests**

```js
// hooks/speak-notify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { speakableName, firstWords, findSession, eventPlan } from './speak-notify.mjs';

test('speakableName turns hyphens and underscores into spaces', () => {
  assert.equal(speakableName('zak-h-9d'), 'zak h 9d');
  assert.equal(speakableName('Combining Indomitus and LV 40k mods'), 'Combining Indomitus and LV 40k mods');
  assert.equal(speakableName(''), 'Claude');
});

test('firstWords strips code, links and markdown, keeps n words', () => {
  const md = '**Done.** Tests pass in `foo.mjs`.\n```js\nconst x=1\n```\nSee https://x.y now please';
  assert.equal(firstWords(md, 7), 'Done. Tests pass in foo.mjs . See');
  assert.equal(firstWords('', 5), '');
  assert.equal(firstWords(undefined, 5), '');
});

test('findSession matches sessionId and skips broken records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'speak-'));
  writeFileSync(join(dir, '1.json'), '{not json');
  writeFileSync(join(dir, '2.json'), JSON.stringify({ pid: 2, sessionId: 'abc', name: 'zak-h-9d', status: 'busy' }));
  writeFileSync(join(dir, '2.key'), 'ignored');
  assert.equal(findSession('abc', dir).name, 'zak-h-9d');
  assert.equal(findSession('nope', dir), null);
  assert.equal(findSession('abc', join(dir, 'missing')), null);
});

test('eventPlan picks chime and phrase per event', () => {
  assert.deepEqual(eventPlan({ hook_event_name: 'Stop' }), { chime: 'Alarm09.wav', phrase: null, waitIdle: true });
  assert.equal(eventPlan({ hook_event_name: 'StopFailure' }).phrase, 'hit an error.');
  assert.equal(eventPlan({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }).phrase, 'needs permission to run Bash.');
  assert.equal(eventPlan({ hook_event_name: 'Elicitation', message: 'Pick a database for the new service please now' }).phrase,
    'has a question. Pick a database for the new service please');
  assert.equal(eventPlan({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which voice?' }] } }).phrase, 'has a question. Which voice?');
  assert.equal(eventPlan({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), null);
  assert.equal(eventPlan({ hook_event_name: 'SessionStart' }), null);
});
```

**Step 2: Run, expect FAIL** — `node --test hooks/speak-notify.test.mjs` → `Cannot find module` / missing export.

**Step 3: Implement** — create `hooks/speak-notify.mjs`:

```js
#!/usr/bin/env node
// Spoken notifications: says "<session name>. <what happened>" with Windows' built-in voice,
// so with several Claude Code sessions open you can tell which one wants you.
//
// Registered for Stop, StopFailure, PermissionRequest, Elicitation and
// PreToolUse(AskUserQuestion). The hook only works out the session and what to say, then hands
// off to a detached copy of this file (--worker) so Claude is never held up. Always exits 0.
//
// WHY WAIT FOR IDLE. Other Stop hooks (stop-gate, plain-words-gate) can block the turn and send
// Claude back to work. Announcing then would be wrong, so on Stop the worker waits until the
// session record in ~/.claude/sessions stops saying "busy", and speaks only if no newer Stop for
// the same session has superseded it (per-session token file, last writer wins).
//
// WHY NOT --bare. The summary comes from a hidden `claude -p --model haiku` run so it uses the
// user's normal Claude Code login. --bare would skip hooks, but it only accepts an API key, so
// hooks are switched off with --settings instead, and CC_SPEAK_CHILD guards against recursion.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { basename, join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');
const STATE_DIR = join(HERE, 'state');
const SPEAKER = join(HERE, 'speak.ps1');

export function speakableName(name) {
  return String(name || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Claude';
}

// Markdown is for eyes; strip code blocks, links and formatting marks before speaking.
export function firstWords(text, n) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`*_#>|[\]()]/g, ' ')
    .split(/\s+/).filter(Boolean)
    .slice(0, n).join(' ');
}

export function findSession(sessionId, sessionsDir = SESSIONS_DIR) {
  let files;
  try { files = readdirSync(sessionsDir).filter(f => f.endsWith('.json')); } catch { return null; }
  for (const f of files) {
    try {
      const rec = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8'));
      if (rec.sessionId === sessionId) return rec;
    } catch { /* half-written record; skip */ }
  }
  return null;
}

// Chime and words for each event. Stop's phrase stays null until summarise() fills it in.
export function eventPlan(input) {
  const question = text => `has a question. ${firstWords(text, 8)}`.trim();
  switch (input.hook_event_name) {
    case 'Stop': return { chime: 'Alarm09.wav', phrase: null, waitIdle: true };
    case 'StopFailure': return { chime: 'Ring02.wav', phrase: 'hit an error.', waitIdle: false };
    case 'PermissionRequest':
      return { chime: 'Alarm04.wav', phrase: `needs permission to run ${input.tool_name || 'a tool'}.`, waitIdle: false };
    case 'Elicitation': return { chime: 'Alarm04.wav', phrase: question(input.message), waitIdle: false };
    case 'PreToolUse':
      if (input.tool_name !== 'AskUserQuestion') return null;
      return { chime: 'Alarm04.wav', phrase: question(input.tool_input?.questions?.[0]?.question), waitIdle: false };
    default: return null;
  }
}
```

**Step 4: Run, expect PASS** — `node --test hooks/speak-notify.test.mjs`.

---

### Task 2: Haiku summary with fallback

- [x] Task 2 done <!-- no-git -->
  - RED: missing export 'summarise'. GREEN: 6/6 pass
  - Real check: "All tests pass; approve merging to main?" in 3069 ms (real Haiku, not fallback; all flags accepted)

**Files:** Modify `hooks/speak-notify.mjs`, `hooks/speak-notify.test.mjs`.

**Step 1: Failing tests** (append):

```js
import { summarise } from './speak-notify.mjs';

test('summarise uses claude output when it succeeds', () => {
  let seen;
  const run = (cmd, args, opts) => { seen = { cmd, args, opts }; return { status: 0, stdout: 'Tests pass, wants OK to merge.\n' }; };
  assert.equal(summarise('long reply text', run), 'Tests pass, wants OK to merge.');
  assert.equal(seen.cmd, 'claude');
  assert.ok(seen.args.includes('haiku'));
  assert.ok(seen.args.includes('{"disableAllHooks":true}'));
  assert.equal(seen.opts.env.CC_SPEAK_CHILD, '1');
  assert.match(seen.opts.input, /long reply text/);
});

test('summarise falls back to first words on failure or timeout', () => {
  const fail = () => ({ status: null, stdout: '', error: new Error('ETIMEDOUT') });
  assert.equal(summarise('one two three four five six seven eight nine ten eleven', fail),
    'one two three four five six seven eight nine ten');
  assert.equal(summarise('', fail), 'finished.');
});
```

**Step 2: Run, expect FAIL** (no `summarise` export).

**Step 3: Implement** (append to `speak-notify.mjs`):

```js
const SUMMARY_PROMPT =
  'Below is the last message an AI coding assistant showed its user. In at most 8 plain spoken ' +
  'words, say what it reports or what it needs from the user. Output only those words.\n\n---\n';

export function summarise(lastMessage, run = spawnSync, timeoutMs = 20000) {
  if (!lastMessage) return 'finished.';
  const r = run('claude', [
    '-p', '--model', 'haiku', '--no-session-persistence', '--strict-mcp-config',
    '--tools', '', '--settings', '{"disableAllHooks":true}',
  ], {
    input: SUMMARY_PROMPT + String(lastMessage).slice(0, 6000),
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
    env: { ...process.env, CC_SPEAK_CHILD: '1' },
  });
  const out = String(r?.stdout || '').trim();
  return r?.status === 0 && out ? firstWords(out, 12) : firstWords(lastMessage, 10);
}
```

**Step 4: Run, expect PASS.**

**Step 5: Real check (manual)** — confirm the flags are accepted and the login works without an API key:

```bash
cd ~/.claude/hooks && node -e "import('./speak-notify.mjs').then(m=>{const t=Date.now();console.log(m.summarise('All 14 tests pass. I need you to approve merging the PR into main.'), Date.now()-t,'ms')})"
```

Expected: a short phrase (not the fallback "All 14 tests pass. I need you to approve merging the"), under ~10 s. If the output is the fallback, run the `claude -p ...` command by hand with the same flags and read the error; likely culprits are `--tools ''` (drop it) or `--strict-mcp-config` (drop it).

---

### Task 3: Idle wait and supersede token

- [x] Task 3 done <!-- no-git -->
  - RED: missing export 'isCurrentToken'. GREEN: 9/9 pass

**Files:** Modify `hooks/speak-notify.mjs`, `hooks/speak-notify.test.mjs`.

**Step 1: Failing tests** (append):

```js
import { waitUntilIdle, writeToken, isCurrentToken } from './speak-notify.mjs';

test('waitUntilIdle returns true once status leaves busy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'speak-'));
  const f = join(dir, '9.json');
  writeFileSync(f, JSON.stringify({ sessionId: 's', status: 'busy' }));
  setTimeout(() => writeFileSync(f, JSON.stringify({ sessionId: 's', status: 'idle' })), 150);
  assert.equal(await waitUntilIdle('s', dir, 2000, 50), true);
});

test('waitUntilIdle gives up while still busy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'speak-'));
  writeFileSync(join(dir, '9.json'), JSON.stringify({ sessionId: 's', status: 'busy' }));
  assert.equal(await waitUntilIdle('s', dir, 200, 50), false);
});

test('token: last writer wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'speak-'));
  writeToken('s', 'a', dir);
  assert.equal(isCurrentToken('s', 'a', dir), true);
  writeToken('s', 'b', dir);
  assert.equal(isCurrentToken('s', 'a', dir), false);
});
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement** (append):

```js
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A missing record (session closed) counts as idle: the turn is certainly over.
export async function waitUntilIdle(sessionId, sessionsDir = SESSIONS_DIR, maxMs = 300000, stepMs = 1000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (findSession(sessionId, sessionsDir)?.status !== 'busy') return true;
    await sleep(stepMs);
  }
  return false;
}

const tokenFile = (sessionId, dir) => join(dir, `speak-${sessionId}.token`);

export function writeToken(sessionId, token, dir = STATE_DIR) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(tokenFile(sessionId, dir), token);
}

export function isCurrentToken(sessionId, token, dir = STATE_DIR) {
  try { return readFileSync(tokenFile(sessionId, dir), 'utf8') === token; } catch { return false; }
}
```

**Step 4: Run, expect PASS.**

---

### Task 4: Hook entry and detached worker

- [x] Task 4 done <!-- no-git -->
  - 9/9 still pass (import does not run hook())
  - Hook returns in ~0.10 s, exit 0. After Task 5: worker ran speak.ps1 with -Text "demo proj. needs permission to run Bash."; job file removed
  - Extra check: simulated Stop (no session record) -> hook 123 ms; worker reached speak.ps1 at ~3.4 s with -Text "demo proj. Login bug fixed; tests pass. Open PR?"
  - Added a comment on the ppid fallback (evaluator rec 4); no behaviour change

**Files:** Modify `hooks/speak-notify.mjs`.

**Step 1: Implement** (append):

```js
function speak(job, phrase) {
  spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SPEAKER,
    '-Text', `${speakableName(job.name)}. ${phrase}`.replace(/["\r\n]+/g, ' '), '-Chime', job.chime, '-HostPid', String(job.pid || 0),
  ], { windowsHide: true, timeout: 180000 });
}

async function worker(jobFile) {
  const job = JSON.parse(readFileSync(jobFile, 'utf8'));
  try { unlinkSync(jobFile); } catch {}
  const phrase = job.phrase ?? summarise(job.lastMessage);
  if (job.waitIdle) {
    if (!(await waitUntilIdle(job.sessionId))) return;
    if (!isCurrentToken(job.sessionId, job.token)) return;
  }
  speak(job, phrase);
}

function hook() {
  if (process.env.CC_SPEAK_CHILD) return;
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  const plan = eventPlan(input);
  if (!plan) return;
  const rec = findSession(input.session_id);
  const job = {
    ...plan,
    sessionId: input.session_id,
    name: rec?.name || basename(input.cwd || ''),
    pid: rec?.pid || process.ppid,
    lastMessage: input.last_assistant_message || '',
    token: randomUUID(),
  };
  if (plan.waitIdle) writeToken(input.session_id, job.token);
  const jobFile = join(tmpdir(), `cc-speak-${job.token}.json`);
  writeFileSync(jobFile, JSON.stringify(job));
  spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', jobFile],
    { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

if (import.meta.main) {
  try {
    const i = process.argv.indexOf('--worker');
    if (i > 0) await worker(process.argv[i + 1]);
    else hook();
  } catch { /* never disturb Claude */ }
  process.exitCode = 0;
}
```

**Step 2: Run unit tests** — `node --test hooks/speak-notify.test.mjs` → all PASS (importing must not run `hook()`; `import.meta.main` is false under the test runner).

**Step 3: Hook returns instantly (manual)**

```bash
cd ~/.claude/hooks && time (echo '{"hook_event_name":"PermissionRequest","session_id":"none","cwd":"C:\\\\x\\\\demo-proj","tool_name":"Bash"}' | node speak-notify.mjs)
```

Expected: returns in well under 1 s; a moment later (after Task 5 exists) chime + "demo proj. needs permission to run Bash." — keep the terminal unfocused/minimised or the foreground check will silence it. Before Task 5 exists, nothing is heard; that is fine.

---

### Task 5: Speaker script

- [x] Task 5 done <!-- no-git -->
  - Created hooks/speak.ps1 as planned. Hazel and Zira installed; Alarm04/Alarm09/Ring02.wav present
  - Single run with -HostPid 4: exit 0, no output, 7.6 s total (PowerShell start + process scan + 0.9 s chime + speech)
  - Two concurrent runs: exit 0 both, no output; finished at 7.0 s and 13.2 s -> serialised by the mutex (overlap would finish both near 7 s)
  - Audio itself not heard (agent cannot listen)

**Files:** Create `hooks/speak.ps1`.

**Step 1: Implement**

```powershell
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
```

**Step 2: Manual check** — from this terminal (pass a PID with no window so the foreground check cannot silence it):

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File ~/.claude/hooks/speak.ps1 -Text "zak h 9d. Tests pass, wants OK to merge." -Chime Alarm09.wav -HostPid 4
```

Expected: ~1 s chime then Hazel speaks. Then run two at once (two background `&` copies with different text): they speak one after the other, not overlapping.

---

### Task 6: Confirm session status timing (manual, decides whether idle wait works)

- [x] Task 6 partly done; blocked-turn test deferred to user's end-to-end check <!-- no-git -->
  - This session's record (sessions/35500.json, name zak-h-9d, pid 35500) read from inside a Bash call: status "busy" while the tool ran
  - Statuses seen across records: busy, idle, shell
  - NOT verified: whether status stays busy through a Stop hook that blocks the turn (needs a second interactive session). Deferred to Task 8

**Step 1:** Temporarily log, from inside the worker, what the session record says while Stop hooks are still running. Quick check without code changes: in a second terminal run

```bash
cd ~/.claude/sessions && while true; do node -e "for(const f of require('fs').readdirSync('.').filter(f=>f.endsWith('.json'))){const r=require('./'+f);if(r.name==='<name of a test session>')console.log(new Date().toISOString(),r.status)}"; sleep 0.5; done
```

then in the test session ask something that triggers the plain-words gate to block once (e.g. ask for a reply containing the word "worktree").

**Expected:** status stays `busy` through the blocked Stop and the rewrite, then flips to `idle`. If instead it flips to `idle` during Stop hooks, the token check still prevents a stale announcement only when a newer Stop arrives first; record the finding in the design doc and accept (worst case: one early announcement on blocked turns).

---

### Task 7: Register hooks, disable cc-sounds

- [x] Task 7 done <!-- no-git -->
  - Backup: settings.json.bak-20261018 (byte-identical copy checked)
  - Added speak-notify to Stop (3rd group), StopFailure, PermissionRequest, Elicitation, PreToolUse(matcher AskUserQuestion); cc-sounds@cc-sounds = false
  - All existing hooks kept; diff shows only additions plus the cc-sounds flag. JSON valid ("ok"). Command path checked to exist
  - First write lost backslashes through shell quoting; fixed at once with a script (5 commands), re-validated
  - Takes effect in new sessions only

**Files:** Modify `settings.json` (back up first: `cp ~/.claude/settings.json ~/.claude/settings.json.bak-20261018`).

**Step 1:** Add, using one shared command string
`node "C:\\Users\\zak_h\\.claude\\hooks\\speak-notify.mjs"` with `"timeout": 10`:

- `hooks.Stop`: append a new group `{ "hooks": [ { "type": "command", "command": "<above>", "timeout": 10 } ] }` (separate group so it runs alongside stop-gate and plain-words-gate).
- `hooks.StopFailure`, `hooks.PermissionRequest`, `hooks.Elicitation`: new keys, same single group.
- `hooks.PreToolUse`: append `{ "matcher": "AskUserQuestion", "hooks": [ ...same... ] }`.
- `enabledPlugins["cc-sounds@cc-sounds"]`: `false`.

**Step 2:** Validate JSON: `node -e "JSON.parse(require('fs').readFileSync(process.env.USERPROFILE+'/.claude/settings.json','utf8'));console.log('ok')"` → `ok`.

---

### Task 8: End-to-end

- [ ] Task 8 needs a human (fresh sessions, listening) - left for the user
  - Step 5 run by executor: node --test hooks/speak-notify.test.mjs -> 9 tests, 9 pass, 0 fail

Hooks load at session start, so use **fresh** sessions.

1. Open two new Claude Code sessions in different folders. Give each a small task, then switch to another app. Expected: each finishes with chime + "<its name>. <summary>"; if both finish together they take turns.
2. In one, ask Claude to ask you a multiple-choice question. Expected: "<name>. has a question. ..." while unfocused.
3. Keep a session focused when it finishes. Expected: silence.
4. Expected never: a second announcement from the hidden Haiku run; a delay before Claude's prompt returns.
5. Run `node --test hooks/speak-notify.test.mjs` one last time → all PASS.

Update `conductor/tracks/spoken-notify_20261018/metadata.json` status to `complete` and `conductor/tracks.md` row to `complete`.

---

## Plan Evaluation Report

**Track**: spoken-notify_20261018
**Evaluator**: loop-plan-evaluator
**Date**: 2026-10-18
**Execution Mode**: SEQUENTIAL

### Results
| Pass | Status |
|------|--------|
| Scope Alignment | PASS (all 9 acceptance criteria covered; no scope creep) |
| Overlap Detection | PASS (only overlap is cc-sounds, which this track replaces and disables) |
| Dependencies | PASS (Node 25.5, claude.exe 2.1.302 on PATH, System.Speech built in) |
| Task Quality | FAIL (Task 1 test expectation is wrong) |
| DAG Validation | FAIL (minor: DAG labels do not match task numbers) |
| Board Review | SKIPPED (small personal tooling track, per dispatcher) |

### Checked by running it (evaluator, 2026-10-18)
- `import.meta.main` on Node 25.5: true for the script run directly or as `--worker`, false when imported by `node --test`. Plan's guard is correct.
- Hidden summary run: `spawnSync('claude', ['-p','--model','haiku','--no-session-persistence','--strict-mcp-config','--tools','','--settings','{"disableAllHooks":true}'])` from inside a Claude Code session (CLAUDECODE=1 set) returns status 0 with a good phrase in about 4 s. Flags are all accepted; no need to unset CLAUDECODE.
- Detached worker (`detached:true, stdio:'ignore', windowsHide:true` + `unref()`): parent returns in about 70 ms and the worker keeps running after the parent exits.
- Stop hook input contains `last_assistant_message` (string), seen in `hooks/plain-words-gate.last-input.json`.
- Walking up from the Claude PID (session record `pid`) reaches `WindowsTerminal` with a real window handle in 2 hops, so the foreground check works from a detached worker.
- Session records have `status` values `busy`, `idle` and also `shell`; `shell` counts as not busy, which is fine. Some stale `busy` records exist; the 5-minute cap in `waitUntilIdle` covers them.
- Recursion guard: double guard (`disableAllHooks` via `--settings` plus `CC_SPEAK_CHILD`) is sound.
- Blocking/slowing Claude: hook reads stdin, scans ~10 small JSON files, writes two files and spawns; no pipes are shared with the worker. Safe; always exit 0.

### Verdict: FAIL -> return to planner with fixes

Required fixes:
1. **Task 1, `firstWords` test is wrong.** Real output of `firstWords(md, 6)` is `'Done. Tests pass in foo.mjs .'` (6 tokens; the lone `.` is a token). The expected `'Done. Tests pass in foo.mjs . See'` is 7 tokens. Change the call to `firstWords(md, 7)` (keeps the expected string) and delete the "Note on the firstWords test" paragraph, which wrongly says only spacing can differ.
2. **DAG labels.** The diagram says T6 settings / T7 end-to-end, but Task 6 is the status-timing check, Task 7 is settings, Task 8 is end-to-end. Redraw: T1 -> T2, T3 -> T4; T5 independent; T4 + T5 -> T6 (timing check) -> T7 settings -> T8 end-to-end.

Recommended (not blocking):
3. In `speak()`, strip `"` and newlines from the text before passing it to `powershell -File` (Haiku output may contain quotes; argument quoting into PowerShell 5.1 is fragile).
4. The `pid: rec?.pid || process.ppid` fallback points at the short-lived shell Claude uses to run the hook, which is gone by the time the worker speaks, so with no record the foreground check never silences. Harmless (it just speaks); say so in a comment or pass 0.
5. Known limit, same as cc-sounds: the check is per Windows Terminal window, not per tab. A session in a background tab of the focused WT window stays silent. Note it in the design.
6. Any other `claude -p` / SDK run started without `CC_SPEAK_CHILD` (e.g. scripts, plugins) will announce under its folder name. Accept, or skip Stop when no session record exists (this conflicts with AC2's folder fallback, so decide explicitly).
7. Design "Error handling" mentions a transcript fallback that the plan does not implement; it is not needed (field confirmed present). Update the design line.


### Plan revision v2 (2026-10-18)

Applied required fixes 1-2; also strip double quotes and newlines from spoken text before passing to PowerShell. Other recommendations accepted as known limitations (per-window not per-tab foreground check; non-interactive claude runs announce under folder name).

## Execution Summary

**Track**: spoken-notify_20261018
**Tasks Completed**: 7/7 executor tasks (Task 8 left for the user)
**Tasks Blocked**: 0
**Commits**: none (~/.claude is not a git repo)
**Discovered Work**: 0
**Business Doc Sync Required**: No
**Unverified**: audio actually heard; idle wait across a blocked Stop turn; foreground silence when focused (all in Task 8)

**Ready for**: Step 4 (Evaluate Execution)

## Execution Evaluation Report

**Track**: spoken-notify_20261018
**Evaluator**: loop-execution-evaluator (dispatcher) -> eval-code-quality
**Date**: 2026-10-18

### Evaluators Dispatched
| Evaluator | Reason | Verdict |
|-----------|--------|---------|
| eval-code-quality | Infrastructure track (hook scripts + settings) | PASS |
| eval-ui-ux / eval-integration / eval-business-logic | Not applicable (no UI, no paid service) | N/A |

### Structural Checks
- plan.md updated: YES (Tasks 1-7 [x]; Task 8 [ ] documented as left for the human)
- Scope alignment: YES (no unplanned work)
- Build passes: N/A (no npm build; not a git repo). `import.meta.main` true on Node 25.5.0
- Business doc sync needed: NO

### Evidence (run, not read)
- `node --test hooks/speak-notify.test.mjs`: 9 tests, 9 pass, 0 fail (510 ms)
- Hook robustness: empty stdin, `{not json`, `{}`, `[]`, `42`, `null`, non-AskUserQuestion PreToolUse, AskUserQuestion with null tool_input, Stop with no session_id/cwd -> all exit 0 in 46-63 ms (bare `node -e 0` = 41 ms)
- Recursion guard: CC_SPEAK_CHILD=1 + PermissionRequest -> exit 0, no job file, nothing spawned; child run also gets `--settings {"disableAllHooks":true}`
- `claude` resolves to claude.exe; spawnSync without shell works; real summarise() = 3.5 s, status 0
- Detached worker outlives the hook and runs speak.ps1 (worker exit 0, job file deleted)
- Quoting through hook -> worker -> speak.ps1 (-HostPid 4): `$env:USERNAME`, backticks, `$(Get-Date)`, `; exit 1`, `%PATH%`, `& | < >`, trailing backslashes and an embedded `-HostPid 99 -Chime evil.wav` all arrive literally; `"` and newlines are stripped; a name like `-Chime` becomes "Chime." so parameter injection is not possible
- Speaking lock: two concurrent speak.ps1 runs finished at 5.1 s and 7.4 s (took turns); ReleaseMutex is in `finally`, same thread; abandoned mutex treated as owned
- settings.json: 5 registrations (Stop, StopFailure, PermissionRequest, Elicitation, PreToolUse matcher AskUserQuestion), timeout 10; `cc-sounds@cc-sounds: false`

### Acceptance criteria
| # | Result |
|---|--------|
| 1 | PASS (caveats: foreground check is per Terminal window, not per tab; a session whose record is stuck on `busy` never announces - see F2) |
| 2 | PASS |
| 3 | PASS |
| 4 | PASS |
| 5 | PASS (if the 120 s lock wait times out it speaks without the lock) |
| 6 | PASS by code reading + token test; live blocked-turn timing UNVERIFIED (Task 6 / Task 8) |
| 7 | PASS |
| 8 | PASS |
| 9 | PASS |

Unverified (left for the human, Task 8): audio actually heard in live multi-session use; silence when the session's terminal is focused; idle wait across a Stop turn blocked by stop-gate/plain-words-gate; whether a console window flashes when the hidden worker starts.

### Final Verdict: PASS

No criterion fails. Recommended follow-ups (not blocking):
- F1 (should-fix) speak-notify.mjs:122 - summarise() runs before the idle wait, so every Stop that another hook blocks starts its own `claude -p` (~3.5 s) whose result is thrown away. Wait for idle + check the token first, then summarise, then check the token again.
- F2 (should-fix) speak-notify.mjs:92/124 - a record stuck on `busy` (seen live: session 16296, busy ~82 h, has `parkedJobId`) or a turn longer than 5 min is dropped silently. Treat a stale `statusUpdatedAt` or a set `parkedJobId` as idle.
- F3 (should-fix) speak-notify.mjs:136-147 - a Stop with no session_id writes `state/speak-undefined.token`. Return early when `session_id` is missing on waitIdle events.
- F4 (should-fix) speak-notify.mjs:120-121 - a bad job file is never deleted from %TEMP%. Unlink in a `finally`.
- F5 (nit) speak.ps1:51 - decide whether a timed-out lock wait should skip instead of talking over another session.
- F6 (nit) speak.ps1:61-64 - put `$synth.Dispose()` in `finally`; dispose `$player`.
- F7 (nit) hooks/state - token files are kept forever (one per session). Delete after speaking.
- F8 (nit) speak-notify.mjs:150 - no `'error'` listener on the detached spawn.
- Note: if a session is closed before speaking, the missing record counts as idle and the dead pid finds no window, so it speaks anyway. Acceptable under the spec.

## Follow-ups done (2026-10-18)

| # | Status | What changed |
|---|---|---|
| F1 | Done | The worker waits for idle and checks its token before asking Haiku, then checks the token again before speaking (`announce()` in `scripts/speak-notify.mjs`). Tested. |
| F2 | Done | A record with `parkedJobId`, or whose `pid` is no longer running, counts as idle. A live, unparked session busy for over 5 minutes is still dropped on purpose: its next Stop announces. Tested. |
| F3 | Done | Events with no `session_id` are ignored. |
| F4 | Done | The job file is deleted in a `finally`, even if unreadable. |
| F5 | Decided | Speak anyway after a 2-minute lock wait (a hung holder; a killed one abandons the lock). Comment in `speak.ps1`. |
| F6 | Done | The voice and the chime player are disposed in `finally`. |
| F7 | Done | The token file is removed after use, but only if it is still this worker's. Tested. |
| F8 | Done | Error listener on the detached spawn. |

Found while doing these: the entry check used `import.meta.main`, which is undefined before
Node 22.18. On this PC the first `node` on the PATH is 20.9 (a Conda environment), and with
that the hook did nothing at all, as shown by running the previous version. Replaced with a
file-name check against `process.argv[1]`. 15 of 15 tests pass on Node 20.9 and 25.5. A real
Stop run under Node 20.9 wrote its token and started the worker, which picked up the job.
That run was cancelled before it spoke, by replacing the token.

Still unverified (Task 8, needs a person listening): audio in live multi-session use, silence
when focused, idle wait across a blocked Stop turn, and whether a console window flashes.

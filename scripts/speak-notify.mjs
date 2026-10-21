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
//
// MUTING. A session stays silent if MM_VOICE=off or SESSION_VOICE=off is in its environment
// (Multi-Manager sets MM_VOICE=off in the sessions it launches), or if /voice off left a file in
// ~/.claude/session-voice/muted. A file in .../unmuted (from /voice on) beats both.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { basename, join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');
// Outside the plugin folder: the plugin cache is replaced on every update.
const STATE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'session-voice');
const SPEAKER = join(HERE, 'speak.ps1');
// Always this fixed path, never CLAUDE_PLUGIN_DATA: Multi-Manager writes these files too.
export const VOICE_DIR = join(homedir(), '.claude', 'session-voice');

// Session ids are UUIDs. Anything else is refused so a mute file can never land outside its folder.
export const validSessionId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);

const isOff = v => String(v || '').trim().toLowerCase() === 'off';

// { muted, reason } for one session. An unmuted file wins, then the environment, then a muted file.
export function voiceState(sessionId, env = process.env, dir = VOICE_DIR) {
  const has = sub => validSessionId(sessionId) && existsSync(join(dir, sub, sessionId));
  if (has('unmuted')) return { muted: false, reason: 'turned on with /voice on' };
  if (isOff(env.MM_VOICE)) return { muted: true, reason: 'MM_VOICE=off (started by Multi-Manager)' };
  if (isOff(env.SESSION_VOICE)) return { muted: true, reason: 'SESSION_VOICE=off' };
  if (has('muted')) return { muted: true, reason: 'turned off with /voice off' };
  return { muted: false, reason: 'default' };
}

export const isMuted = (sessionId, env, dir) => voiceState(sessionId, env, dir).muted;

// on: remove the muted file and write an unmuted one, so /voice on beats MM_VOICE=off.
// off: the reverse.
export function setVoice(sessionId, on, dir = VOICE_DIR) {
  if (!validSessionId(sessionId)) throw new Error(`not a session id: ${sessionId}`);
  const [add, drop] = on ? ['unmuted', 'muted'] : ['muted', 'unmuted'];
  try { unlinkSync(join(dir, drop, sessionId)); } catch {}
  mkdirSync(join(dir, add), { recursive: true });
  writeFileSync(join(dir, add, sessionId), new Date().toISOString() + '\n');
}

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Records left saying "busy" by a parked or dead session would otherwise hold the announcement
// for the full five minutes and then drop it.
function isBusy(rec) {
  if (rec?.status !== 'busy' || rec.parkedJobId) return false;
  return typeof rec.pid !== 'number' || isAlive(rec.pid);
}

// A missing record (session closed) counts as idle: the turn is certainly over. Giving up after
// maxMs loses nothing: a session busy that long was sent back to work and will Stop again.
export async function waitUntilIdle(sessionId, sessionsDir = SESSIONS_DIR, maxMs = 300000, stepMs = 1000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (!isBusy(findSession(sessionId, sessionsDir))) return true;
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

// Remove the token only if it is still ours; a newer Stop's token must survive.
export function clearToken(sessionId, token, dir = STATE_DIR) {
  if (isCurrentToken(sessionId, token, dir)) { try { unlinkSync(tokenFile(sessionId, dir)); } catch {} }
}

function speak(job, phrase) {
  spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SPEAKER,
    '-Text', `${speakableName(job.name)}. ${phrase}`.replace(/["\r\n]+/g, ' '), '-Chime', job.chime, '-HostPid', String(job.pid || 0),
  ], { windowsHide: true, timeout: 180000 });
}

// On Stop, wait for real idle before asking Haiku, so a turn another Stop hook blocks costs no
// summary run. The token is checked again afterwards because the summary takes a few seconds.
// Muting is checked again just before speaking: /voice off may run while the worker waits.
export async function announce(job, { say = speak, summary = summarise, sessionsDir = SESSIONS_DIR, stateDir = STATE_DIR, muted = () => isMuted(job.sessionId) } = {}) {
  if (!job.waitIdle) return muted() ? undefined : say(job, job.phrase ?? summary(job.lastMessage));
  const current = () => isCurrentToken(job.sessionId, job.token, stateDir);
  try {
    if (!(await waitUntilIdle(job.sessionId, sessionsDir)) || !current() || muted()) return;
    const phrase = job.phrase ?? summary(job.lastMessage);
    if (current() && !muted()) say(job, phrase);
  } finally {
    clearToken(job.sessionId, job.token, stateDir);
  }
}

async function worker(jobFile) {
  let job;
  try { job = JSON.parse(readFileSync(jobFile, 'utf8')); } finally { try { unlinkSync(jobFile); } catch {} }
  await announce(job);
}

function hook() {
  if (process.env.CC_SPEAK_CHILD) return;
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  const plan = eventPlan(input);
  if (!plan || !input.session_id || isMuted(input.session_id)) return;
  const rec = findSession(input.session_id);
  const job = {
    ...plan,
    sessionId: input.session_id,
    name: rec?.name || basename(input.cwd || ''),
    // With no session record, ppid is the short-lived shell that ran this hook; it is gone by the
    // time the worker speaks, so the foreground check finds no window and it just speaks. Harmless.
    pid: rec?.pid || process.ppid,
    lastMessage: input.last_assistant_message || '',
    token: randomUUID(),
  };
  if (plan.waitIdle) writeToken(input.session_id, job.token);
  const jobFile = join(tmpdir(), `cc-speak-${job.token}.json`);
  writeFileSync(jobFile, JSON.stringify(job));
  spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', jobFile],
    { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

// Not import.meta.main: Node before 22.18 leaves it undefined, so the hook silently did nothing.
// The test runner loads this file from speak-notify.test.mjs, so the name check keeps it inert.
if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) {
  try {
    const i = process.argv.indexOf('--worker');
    if (i > 0) await worker(process.argv[i + 1]);
    else hook();
  } catch { /* never disturb Claude */ }
  process.exitCode = 0;
}

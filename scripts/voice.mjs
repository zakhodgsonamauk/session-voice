#!/usr/bin/env node
// Backs the /voice command: turns spoken notifications on or off for the session that runs it.
// Usage: node voice.mjs [on|off|status] [--session=<id>]
//
// The session id comes from --session (the command file fills it with ${CLAUDE_SESSION_ID}) or,
// failing that, CLAUDE_CODE_SESSION_ID, which Claude Code sets for commands it runs. Both hold the
// same id the hooks get as session_id.
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { voiceState, setVoice, validSessionId, VOICE_DIR } from './speak-notify.mjs';

export function parseArgs(argv, env = process.env) {
  let action = 'status', session = '';
  for (const a of argv) {
    if (a.startsWith('--session=')) session = a.slice('--session='.length);
    else if (a.trim()) action = a.trim().toLowerCase();
  }
  // An unfilled placeholder arrives as "" or as the literal text; fall back to the environment.
  if (!validSessionId(session)) session = env.CLAUDE_CODE_SESSION_ID || '';
  return { action, session };
}

export function run(argv, env = process.env, dir = VOICE_DIR) {
  const { action, session } = parseArgs(argv, env);
  if (!['on', 'off', 'status'].includes(action)) return { code: 1, text: `Unknown option "${action}". Use on, off or status.` };
  if (!validSessionId(session)) return { code: 1, text: 'Could not tell which session this is (no session id).' };
  if (action !== 'status') setVoice(session, action === 'on', dir);
  const { muted, reason } = voiceState(session, env, dir);
  return { code: 0, text: `Voice is ${muted ? 'off' : 'on'} for this session (${reason}).` };
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) {
  let r;
  try { r = run(process.argv.slice(2)); } catch (e) { r = { code: 1, text: String(e?.message || e) }; }
  console.log(r.text);
  process.exitCode = r.code;
}

// scripts/speak-notify.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratchDirs = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'speak-')); scratchDirs.push(d); return d; };
after(() => { for (const d of scratchDirs) rmSync(d, { recursive: true, force: true }); });
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
  const dir = scratch();
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

import { waitUntilIdle, writeToken, isCurrentToken, clearToken } from './speak-notify.mjs';

test('waitUntilIdle returns true once status leaves busy', async () => {
  const dir = scratch();
  const f = join(dir, '9.json');
  writeFileSync(f, JSON.stringify({ sessionId: 's', status: 'busy' }));
  setTimeout(() => writeFileSync(f, JSON.stringify({ sessionId: 's', status: 'idle' })), 150);
  assert.equal(await waitUntilIdle('s', dir, 2000, 50), true);
});

test('waitUntilIdle gives up while still busy', async () => {
  const dir = scratch();
  writeFileSync(join(dir, '9.json'), JSON.stringify({ sessionId: 's', status: 'busy' }));
  assert.equal(await waitUntilIdle('s', dir, 200, 50), false);
});

test('token: last writer wins', () => {
  const dir = scratch();
  writeToken('s', 'a', dir);
  assert.equal(isCurrentToken('s', 'a', dir), true);
  writeToken('s', 'b', dir);
  assert.equal(isCurrentToken('s', 'a', dir), false);
});

test('clearToken removes only its own token', () => {
  const dir = scratch();
  writeToken('s', 'new', dir);
  clearToken('s', 'old', dir);
  assert.equal(isCurrentToken('s', 'new', dir), true);
  clearToken('s', 'new', dir);
  assert.equal(existsSync(join(dir, 'speak-s.token')), false);
});

test('waitUntilIdle treats parked and dead sessions as idle', async () => {
  const dir = scratch();
  writeFileSync(join(dir, '9.json'), JSON.stringify({ sessionId: 'parked', status: 'busy', parkedJobId: 'j1' }));
  writeFileSync(join(dir, '8.json'), JSON.stringify({ sessionId: 'dead', status: 'busy', pid: 2147483646 }));
  writeFileSync(join(dir, '7.json'), JSON.stringify({ sessionId: 'live', status: 'busy', pid: process.pid }));
  assert.equal(await waitUntilIdle('parked', dir, 200, 50), true);
  assert.equal(await waitUntilIdle('dead', dir, 200, 50), true);
  assert.equal(await waitUntilIdle('live', dir, 200, 50), false);
});

import { announce } from './speak-notify.mjs';

test('announce: superseded Stop never asks for a summary', async () => {
  const dir = scratch();
  writeToken('s', 'newer', dir);
  let summarised = 0, spoken = 0;
  await announce({ waitIdle: true, phrase: null, sessionId: 's', token: 'older', lastMessage: 'x' },
    { summary: () => { summarised++; return 'x'; }, say: () => { spoken++; }, sessionsDir: dir, stateDir: dir });
  assert.equal(summarised, 0);
  assert.equal(spoken, 0);
  assert.equal(isCurrentToken('s', 'newer', dir), true);
});

test('announce: Stop superseded during the summary stays silent', async () => {
  const dir = scratch();
  writeToken('s', 'mine', dir);
  let spoken = 0;
  await announce({ waitIdle: true, phrase: null, sessionId: 's', token: 'mine', lastMessage: 'x' },
    { summary: () => { writeToken('s', 'newer', dir); return 'x'; }, say: () => { spoken++; }, sessionsDir: dir, stateDir: dir });
  assert.equal(spoken, 0);
});

test('announce: current Stop speaks its summary and clears its token', async () => {
  const dir = scratch();
  writeToken('s', 'mine', dir);
  let said;
  await announce({ waitIdle: true, phrase: null, sessionId: 's', token: 'mine', lastMessage: 'x' },
    { summary: () => 'Tests pass.', say: (job, phrase) => { said = phrase; }, sessionsDir: dir, stateDir: dir });
  assert.equal(said, 'Tests pass.');
  assert.equal(existsSync(join(dir, 'speak-s.token')), false);
});

test('announce: fixed-phrase events speak at once without a summary', async () => {
  let said;
  await announce({ waitIdle: false, phrase: 'hit an error.' },
    { summary: () => assert.fail('no summary'), say: (job, phrase) => { said = phrase; } });
  assert.equal(said, 'hit an error.');
});

import { voiceState, isMuted, setVoice, validSessionId } from './speak-notify.mjs';
import { run as voiceCommand, parseArgs } from './voice.mjs';

test('voiceState: speaks by default, MM_VOICE or SESSION_VOICE=off mutes', () => {
  const dir = scratch();
  assert.equal(isMuted('s1', {}, dir), false);
  assert.equal(isMuted('s1', { MM_VOICE: 'off' }, dir), true);
  assert.equal(isMuted('s1', { SESSION_VOICE: 'OFF' }, dir), true);
  assert.equal(isMuted('s1', { MM_VOICE: 'on' }, dir), false);
});

test('setVoice: off writes a muted file, on beats the environment', () => {
  const dir = scratch();
  setVoice('s1', false, dir);
  assert.equal(existsSync(join(dir, 'muted', 's1')), true);
  assert.equal(isMuted('s1', {}, dir), true);
  assert.equal(isMuted('s2', {}, dir), false);
  setVoice('s1', true, dir);
  assert.equal(existsSync(join(dir, 'muted', 's1')), false);
  assert.equal(isMuted('s1', { MM_VOICE: 'off' }, dir), false);
  setVoice('s1', false, dir);
  assert.equal(existsSync(join(dir, 'unmuted', 's1')), false);
  assert.equal(voiceState('s1', {}, dir).reason, 'turned off with /voice off');
});

test('session ids that could escape the folder are refused', () => {
  assert.equal(validSessionId('8d234bb8-58f7-4414-a349-d1004754f603'), true);
  assert.equal(validSessionId('../x'), false);
  assert.equal(validSessionId(''), false);
  assert.throws(() => setVoice('../x', false, scratch()));
});

test('announce: a muted session stays silent', async () => {
  let spoken = 0;
  await announce({ waitIdle: false, phrase: 'hit an error.' }, { say: () => { spoken++; }, muted: () => true });
  const dir = scratch();
  writeToken('s', 'mine', dir);
  await announce({ waitIdle: true, phrase: null, sessionId: 's', token: 'mine', lastMessage: 'x' },
    { summary: () => assert.fail('no summary'), say: () => { spoken++; }, sessionsDir: dir, stateDir: dir, muted: () => true });
  assert.equal(spoken, 0);
  assert.equal(existsSync(join(dir, 'speak-s.token')), false);
});

test('/voice takes the session id from --session, else CLAUDE_CODE_SESSION_ID', () => {
  assert.deepEqual(parseArgs(['off', '--session=abc'], {}), { action: 'off', session: 'abc' });
  assert.deepEqual(parseArgs(['--session='], { CLAUDE_CODE_SESSION_ID: 'env1' }), { action: 'status', session: 'env1' });
  assert.equal(parseArgs(['on', '--session=${CLAUDE_SESSION_ID}'], { CLAUDE_CODE_SESSION_ID: 'env1' }).session, 'env1');
});

test('/voice on, off and status act on the current session', () => {
  const dir = scratch();
  const env = { CLAUDE_CODE_SESSION_ID: 's1', MM_VOICE: 'off' };
  assert.match(voiceCommand(['status'], env, dir).text, /off .*MM_VOICE/);
  assert.match(voiceCommand(['on'], env, dir).text, /^Voice is on/);
  assert.equal(existsSync(join(dir, 'unmuted', 's1')), true);
  assert.match(voiceCommand(['off'], env, dir).text, /^Voice is off/);
  assert.equal(existsSync(join(dir, 'muted', 's1')), true);
  assert.equal(voiceCommand(['loud'], env, dir).code, 1);
  assert.equal(voiceCommand(['on'], {}, dir).code, 1);
});

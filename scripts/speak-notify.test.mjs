// hooks/speak-notify.test.mjs
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

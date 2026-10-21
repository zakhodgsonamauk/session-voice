# session-voice

Spoken notifications for Claude Code on Windows. When a session finishes, needs permission, or asks you a question, and its terminal is not the window you are looking at, you hear a short chime followed by the built-in Windows voice saying which session it is and what happened:

> "digital survey platform 5e. Tests pass, wants OK to merge."

Built for running several Claude Code sessions at once, where a plain jingle does not tell you which one wants you.

## What it says

| Event | Spoken |
|---|---|
| Turn finished | `<session name>. <about 8-word summary>` |
| Claude asks a multiple-choice question | `<session name>. has a question. <first words>` |
| Permission prompt | `<session name>. needs permission to run <tool>.` |
| MCP server asks for input | `<session name>. has a question. <first words>` |
| Turn failed with an error | `<session name>. hit an error.` |

The session name is the one Claude Code already uses for messaging between sessions, as stored in `~/.claude/sessions/*.json`. If there is no record, the folder name is used.

## Muting a session

`/voice off` silences the session you type it in, `/voice on` turns it back on, and `/voice` (or `/voice status`) says which it is.

A session is also silent if `SESSION_VOICE=off` is in its environment. Multi-Manager starts its architect and developer sessions with `MM_VOICE=off`, which works the same way, so only its front desk speaks. `/voice on` overrides either.

The switches are small files named after the Claude Code session id, in `~/.claude/session-voice/muted` and `~/.claude/session-voice/unmuted`. Other tools may write them too; Multi-Manager's `set_voice` does. The `/voice` command finds its session id from `${CLAUDE_SESSION_ID}`, or from the `CLAUDE_CODE_SESSION_ID` environment variable.

## How it works

- `scripts/speak-notify.mjs` is the hook. It reads the event, finds the session name, and hands off to a detached copy of itself, so Claude is never held up. The hook always exits 0.
- Other Stop hooks can block a turn and send Claude back to work. So for a finished turn the worker first waits until the session record stops saying `busy`, and it carries on only if no newer Stop for the same session has replaced it. A record that is parked, or whose Claude process has gone, counts as finished.
- Only then does it ask Haiku for a summary through a hidden `claude -p --model haiku` run, so a blocked turn costs no summary. That run uses your normal Claude Code login, so there are no direct API calls and no API key. Hooks are disabled in that run, and the `CC_SPEAK_CHILD` environment variable guards against it announcing itself. If the run fails or takes more than 20 seconds, the first ten words of the reply are spoken instead. The worker checks again afterwards that no newer Stop arrived while the summary was being made.
- `scripts/speak.ps1` does the rest. It stays silent if the session's terminal is the focused, non-minimised window. A named mutex makes concurrent sessions take turns. It then plays a 0.9-second chime from `C:\Windows\Media` and speaks with "Microsoft Hazel Desktop". If that voice is missing, the system default is used.
- Small state files go in `$CLAUDE_PLUGIN_DATA`, or `~/.claude/session-voice` if that variable isn't set. The mute files always go in `~/.claude/session-voice`, so other tools can find them.
- The hook checks for muting before it does anything, and the worker checks again just before speaking, so `/voice off` also stops an announcement that is already waiting.

## Install

```bash
claude plugin marketplace add zakhodgsonamauk/session-voice
claude plugin install session-voice@session-voice
```

Start a new session for the hooks to load. If you use `cc-sounds`, disable it to avoid hearing both.

## Requirements

Windows 10 or 11, Node 20 or later, Windows PowerShell 5.1, and Claude Code logged in. Tested on Node 20.9 and 25.5. The hook runs whichever `node` comes first on the PATH Claude Code was started with, which may be an older copy from a Conda or nvm environment rather than your main install.

## Known limits

- The "already looking" check works per terminal window, not per tab.
- Non-interactive `claude -p` runs on the same PC have no session record, so they announce under their folder name.
- If a live, unparked session's record still says `busy` 5 minutes after it stopped, that announcement is dropped. In practice, that means another Stop hook sent Claude back to work, and the next Stop announces instead.
- If two announcements are queued and the earlier one hangs for more than 2 minutes, the later one speaks anyway, even though they may overlap.
- Not yet checked by ear across several live sessions. The remaining hands-on checks are listed under Task 8 in `docs/plan.md`.

## Tests

```bash
node check.mjs
```

This checks the scripts for syntax errors and runs the unit tests (`node --test scripts/speak-notify.test.mjs`). It needs nothing installed.

Design, spec and plan are in `docs/`.

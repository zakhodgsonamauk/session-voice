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

## How it works

- `scripts/speak-notify.mjs` is the hook. It reads the event, finds the session name, and hands off to a detached copy of itself, so Claude is never held up. The hook always exits 0.
- For a finished turn, the detached worker asks Haiku for a summary through a hidden `claude -p --model haiku` run. That run uses your normal Claude Code login, so there are no direct API calls and no API key. Hooks are disabled in that run, and the `CC_SPEAK_CHILD` environment variable guards against it announcing itself. If the run fails or takes more than 20 seconds, the first ten words of the reply are spoken instead.
- Other Stop hooks can block a turn and send Claude back to work. So the worker waits until the session record stops saying `busy`, and it speaks only if no newer Stop for the same session has replaced it.
- `scripts/speak.ps1` does the rest. It stays silent if the session's terminal is the focused, non-minimised window. A named mutex makes concurrent sessions take turns. It then plays a 0.9-second chime from `C:\Windows\Media` and speaks with "Microsoft Hazel Desktop". If that voice is missing, the system default is used.
- Small state files go in `$CLAUDE_PLUGIN_DATA`, or `~/.claude/session-voice` if that variable isn't set.

## Install

```bash
claude plugin marketplace add zakhodgsonamauk/session-voice
claude plugin install session-voice@session-voice
```

Start a new session for the hooks to load. If you use `cc-sounds`, disable it to avoid hearing both.

## Requirements

Windows 10 or 11, Node 22.18 or later (for `import.meta.main`), Windows PowerShell 5.1, and Claude Code logged in.

## Known limits

- The "already looking" check works per terminal window, not per tab.
- Non-interactive `claude -p` runs on the same PC have no session record, so they announce under their folder name.
- A session whose record is stuck on `busy` is not announced. The worker gives up after 5 minutes.

## Tests

```bash
node --test scripts/speak-notify.test.mjs
```

Design, spec and plan are in `docs/`.

# Spec: Spoken Session Notifications

Full approved design: `conductor/designs/2026-10-18-spoken-session-notify-design.md`.

## Acceptance criteria

1. When a session's turn truly ends and its terminal is not the focused window, a short chime
   plays and Windows' Hazel voice says "<session name>. <~8-word summary>".
2. The session name is the cross-session messaging name from `~/.claude/sessions/*.json`
   (hyphens spoken as spaces); folder name if no record.
3. The summary is made by `claude -p --model haiku` using the existing Claude Code login; no
   direct API calls. Falls back to the first ~10 words of the last reply on failure.
4. PermissionRequest, Elicitation, AskUserQuestion and StopFailure each speak a fixed phrase.
5. Two sessions notifying at once take turns.
6. A turn blocked by another Stop hook does not announce until the session is really idle.
7. Hidden Haiku run never triggers a notification of its own.
8. The hook never blocks or slows Claude (exits immediately, always exit 0).
9. `cc-sounds` plugin disabled.

---
description: Turn spoken notifications on or off for this session, or show whether they are on.
argument-hint: "[on|off|status]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/voice.mjs" $ARGUMENTS --session=${CLAUDE_SESSION_ID}`

Tell the user the line above in one short sentence. If it is an error, show it as it is. Do nothing else.

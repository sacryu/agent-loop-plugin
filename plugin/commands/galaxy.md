---
description: Show the address of my galaxy in Agent Loop
allowed-tools: Bash(node:*)
---
My galaxy's address:

!`node "${CLAUDE_PLUGIN_ROOT}/hooks/report.mjs" --galaxy "${CLAUDE_PLUGIN_DATA}"`

Reply with only the address above as a clickable link, and one short sentence saying that opening it flies straight to this user's galaxy. If the output says it was opened in the browser with the group key, say that too, and that the invite link (with the key) is under the Invite button on that page. If the output has a line starting with "Problem:", also tell the user that problem and how to fix it, in their language. Do not run any other command.

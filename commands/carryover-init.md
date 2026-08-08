---
description: Register the current project with carryover
allowed-tools: Bash(carryover init:*)
---

!`carryover init $ARGUMENTS`

Report the result in one or two lines. Rules:

- If the allowlist line says `already registered`, say so and stop. Nothing needs doing.
- If transcripts are reported as predating registration, give the user the backfill
  command and let them decide. Do not run it.
- If the hook is reported as NOT installed, say that sweeps must be run by hand.

Then, if and only if this project works in a technology with no matching entry in
carryover's `domains` vocabulary, say which word you would add and how
(`/carryover-init --domain=<word>`). Do not add it yourself.

Never suggest registering a client or contract repository. The vault holds notes
distilled from session content, so registering client work would put client detail
into it.

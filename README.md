# carryover

A memory layer for agent work.

Agent sessions end and everything learned in them evaporates. The transcript
survives on disk, but nobody reads a 20 MB JSONL file, and the next session
starts from nothing. `carryover` reads those transcripts, works out what was
actually learned, and files it as short linked notes in an Obsidian vault —
where the next session can read them back over MCP.

Notes written by agents, read by agents, approved by a human.

## What it reads

| Source | Path | Format |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<uuid>.jsonl` | JSONL |
| Antigravity CLI | `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` | JSONL |

The Antigravity **IDE** store (`~/.gemini/antigravity/conversations/*.pb`) is
encrypted at rest and is permanently out of scope.

Adapters normalize both into one shape, so nothing downstream knows which tool a
session came from:

```js
{ id, harness, project, startedAt, endedAt, turns: [{ role, text, tools }] }
```

## The 99% that gets dropped

Measured across 36 real sessions:

| Harness | Sessions | Raw | Kept | |
| --- | ---: | ---: | ---: | ---: |
| Claude Code | 23 | 266 MB | 1.5 MB | 0.6% |
| Antigravity | 13 | 2.1 MB | 283 KB | 13.4% |

Tool results, file contents, images, thinking blocks and system reminders are
all discarded — they are either already on disk somewhere better, or worthless a
day later. What survives is what a person said, what the model said back, and
the names of the tools it reached for.

That ratio is the premise the whole design rests on: an extraction pass reads
about 16k tokens, not 5 MB. `carryover stats` re-checks it against your own
transcripts.

## Design

**A sweep, not a hook.** One command scans both trees for transcripts newer than
a stored watermark. It cannot miss a session that ended in a crash or a killed
terminal, Antigravity has no hook system to attach to anyway, and backfill is
the same code path with an older watermark rather than a second implementation.

**Extraction is an agent, not a script.** It searches the vault before writing,
so it can propose an edit to an existing note — or nothing at all — instead of
producing an eleventh near-duplicate. Most sessions should produce nothing.

**Nothing lands unreviewed.** Candidates are written to `inbox/` with
`status: pending` and reviewed inside Obsidian through a Bases view. Approved
notes move to `notes/`; anything untouched for 30 days is archived, on the
theory that a note you didn't want in a month is a note you don't want.

**Folders by kind, topic by property.** Five fixed folders. Topic lives in a
`domain` field drawn from a controlled list in `config.json`, because free-text
tagging becomes `mcp` / `MCP` / `model-context-protocol` within two weeks and
breaks every query silently.

```
inbox/     candidates awaiting review   ← written by the extractor
sources/   one stub per session         ← written by the extractor
notes/     approved atomic notes, flat
maps/      index notes, written by hand
archive/   rejected and expired
```

`maps/` is deliberately not automated. The agent writes atoms; the connections
are yours.

## Not ingesting itself

The extractor is `claude -p`, so it writes a transcript like any other session.
Left alone it would ingest its own runs, and then ingest the ingestion. Three
things stop that, because one was not enough: the extractor runs from a scratch
directory whose project name is not in the allowlist, its child process carries
`CARRYOVER_CHILD=1` so the SessionStart hook exits instead of starting another
sweep, and the prompt itself carries a marker that the sweep skips on sight —
which holds however the process was launched.

## Commands

```bash
carryover init               # register the project you are standing in
carryover init --domain=rust # ...and add a word to the domain vocabulary
carryover stats              # ingestion ratio on your own transcripts
carryover sweep --dry        # what is eligible, and what it would cost
carryover extract            # extract new sessions into inbox/
carryover extract --dry      # same, but print proposals instead of writing
carryover extract --all --limit=5   # ignore the watermark — backfill, a slice at a time
carryover apply              # act on everything you marked approved or rejected
carryover skip               # declare the current backlog uninteresting
carryover expire             # archive proposals left pending past the cutoff
```

`commands/carryover-init.md` is the same thing as a Claude Code slash command —
copy it into `~/.claude/commands/` and `/carryover-init` works in any project,
with the same flags. Like the hook, it is shipped rather than installed.

`init` takes the project name from the enclosing git repository — the same thing
the adapter derives from a session's `cwd` — and adds it to the allowlist in
`config.json`. Run it when you start a project, not when you remember it exists:
sessions that ran before registration are marked skipped, and a skipped session
older than an extracted one stays behind the watermark for good. `init` says so
when it finds transcripts in that position, and `extract --all` is what reaches
them.

`skip` moves the watermark to now without extracting anything. Use it after a
gap, or on first install: a queue of forty proposals from an untuned prompt is
the graveyard this system exists to avoid. The transcripts stay on disk either
way, so `extract --all` still reaches them once the prompt earns your trust.

Review happens in Obsidian. Copy `vault/Review queue.base` into the vault; it
gives four views over `inbox/` — contradictions first, then anything low
confidence or missing a domain, then ordinary pending, then approved-but-not-yet
applied. Approving is setting `status: approved` in a note's frontmatter;
`carryover apply` does the rest.

## Status

Working end to end: ingest → sweep → extract → review → apply. Verified against
36 real sessions across both harnesses.

The `SessionStart` hook in `hooks/session-start.js` is written and its recursion
guard is tested, but it is **not installed** — wiring it into user settings
makes it run on every session in every project, which is a decision for whoever
owns the machine. The comment at the top of that file has the snippet.

Known gaps: no tests; `apply` overwrites a target's body wholesale rather than
merging; two Antigravity sessions resolve to no project at all because nothing
in their transcript names a path under `dev/`.

Paths, the project allowlist and the domain vocabulary all live in
`config.json`. It assumes one particular vault today — the seams are in the
right place to generalize, but that isn't done and isn't pretended.

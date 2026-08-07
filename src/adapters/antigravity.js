/**
 * Antigravity CLI transcripts:
 *   ~/.gemini/antigravity-cli/brain/<session-id>/.system_generated/logs/transcript.jsonl
 *
 * One typed record per line. Note this is the CLI only — the Antigravity *IDE*
 * stores conversations in ~/.gemini/antigravity/conversations/*.pb, which are
 * encrypted at rest (entropy 7.999 bits/byte, no compression header). Those are
 * out of scope permanently; do not add an adapter for them.
 */

import fs from "node:fs";
import path from "node:path";
import { keepTurn } from "../filter.js";

export const harness = "antigravity";

/** Records that carry something a person or the model actually said. */
const PROSE = new Set(["USER_INPUT", "PLANNER_RESPONSE", "CHECKPOINT", "ERROR_MESSAGE"]);

const ROLE = {
  USER_INPUT: "user",
  PLANNER_RESPONSE: "assistant",
  CHECKPOINT: "assistant",
  ERROR_MESSAGE: "assistant",
};

export function discover(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const dir of fs.readdirSync(root)) {
    const p = path.join(root, dir, ".system_generated", "logs", "transcript.jsonl");
    if (!fs.existsSync(p)) continue;
    out.push({ path: p, id: dir, mtime: fs.statSync(p).mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function parse(file, limits) {
  const turns = [];
  const paths = [];
  let startedAt = null;
  let endedAt = null;

  for (const line of fs.readFileSync(file.path, "utf8").split("\n")) {
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.created_at) {
      startedAt ??= record.created_at;
      endedAt = record.created_at;
    }

    // Every record type can name a file path; collect before filtering by type,
    // because the tool-result records are the ones that mention paths most.
    collectPaths(line, paths);

    if (!PROSE.has(record.type)) continue;

    const turn = keepTurn(
      {
        role: ROLE[record.type],
        text: record.type === "ERROR_MESSAGE" ? `Error: ${record.error ?? ""}` : record.content,
        tools: (record.tool_calls ?? []).map((c) => c.name ?? "tool"),
      },
      limits,
    );
    if (turn) turns.push(turn);
  }

  return {
    id: file.id,
    harness,
    project: mostCommon(paths),
    path: file.path,
    startedAt,
    endedAt,
    turns,
  };
}

/**
 * There is no `cwd` anywhere in an Antigravity transcript, so the project is
 * inferred from whichever repo under `dev/` the session touched most.
 */
const DEV_PATH = /[/\\]dev[/\\]([A-Za-z0-9._-]+)/g;

function collectPaths(line, into) {
  for (const match of line.matchAll(DEV_PATH)) into.push(match[1]);
}

function mostCommon(values) {
  if (!values.length) return null;
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

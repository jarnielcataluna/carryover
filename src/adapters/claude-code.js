/**
 * Claude Code transcripts: ~/.claude/projects/<path-slug>/<session-uuid>.jsonl
 *
 * One JSON object per line. Records carry `message` in Anthropic wire shape,
 * plus `cwd` and `timestamp`. Sidechain records (subagent turns) are skipped —
 * the parent session already records what came back from them.
 */

import fs from "node:fs";
import path from "node:path";
import { keepTurn } from "../filter.js";

export const harness = "claude-code";

/** Every transcript under the root, newest first. */
export function discover(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith(".jsonl")) continue;
      const p = path.join(full, file);
      out.push({ path: p, id: file.replace(/\.jsonl$/, ""), mtime: fs.statSync(p).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function parse(file, limits) {
  const turns = [];
  let cwd = null;
  let startedAt = null;
  let endedAt = null;

  for (const line of fs.readFileSync(file.path, "utf8").split("\n")) {
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a partial final line while a session is still being written
    }

    if (record.isSidechain) continue;
    if (record.cwd && !cwd) cwd = record.cwd;
    if (record.timestamp) {
      startedAt ??= record.timestamp;
      endedAt = record.timestamp;
    }

    const message = record.message;
    if (!message || (record.type !== "user" && record.type !== "assistant")) continue;

    const turn = keepTurn(
      { role: record.type, ...collect(message.content) },
      limits,
    );
    if (turn) turns.push(turn);
  }

  return {
    id: file.id,
    harness,
    project: projectFrom(cwd, file.path),
    path: file.path,
    startedAt,
    endedAt,
    turns,
  };
}

/** Prose and tool names only. tool_result, thinking and images are dropped. */
function collect(content) {
  if (typeof content === "string") return { text: content, tools: [] };
  if (!Array.isArray(content)) return { text: "", tools: [] };

  const text = [];
  const tools = [];
  for (const block of content) {
    if (block.type === "text") text.push(block.text ?? "");
    else if (block.type === "tool_use") tools.push(block.name ?? "tool");
  }
  return { text: text.join("\n"), tools };
}

/**
 * `cwd` is authoritative when present. The directory slug is a lossy encoding
 * of the same path — separators and literal hyphens both become `-` — so it is
 * only a fallback.
 */
function projectFrom(cwd, filePath) {
  if (cwd) return path.basename(cwd);
  const slug = path.basename(path.dirname(filePath));
  const marker = "Documents-dev-";
  const at = slug.indexOf(marker);
  return at === -1 ? slug : slug.slice(at + marker.length);
}

/**
 * Registering a project with carryover.
 *
 * Setup is two entries in config.json — the allowlist and, sometimes, a domain.
 * That is little enough to do by hand, and the reason it exists as a command
 * anyway is that doing it by hand is easy to *postpone*: sessions that ran
 * before a project was allowed get marked skipped, and a skipped session older
 * than one that was extracted sits behind the watermark permanently. The cost of
 * forgetting is paid later and silently, so the command exists to make the
 * moment of starting a project the moment it gets registered.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Edit an array in config.json as text rather than through JSON.parse and
 * JSON.stringify. The file is hand-formatted with blank lines between blocks and
 * a round trip through the parser would flatten that on every init — the
 * config is meant to stay readable to the person who has to edit it.
 *
 * Returns the new source, or null if the value was already there.
 */
export function addToArray(source, key, value) {
  const at = source.indexOf(`"${key}"`);
  if (at === -1) throw new Error(`config.json has no "${key}"`);

  const open = source.indexOf("[", at);
  const close = source.indexOf("]", open);
  if (open === -1 || close === -1) throw new Error(`"${key}" is not an array`);

  const inner = source.slice(open + 1, close);
  if (JSON.parse(`[${inner}]`).includes(value)) return null;

  const lines = inner.split("\n");
  const multiline = lines.length > 1;
  let replacement;

  if (multiline) {
    const lastItem = [...lines].reverse().find((l) => l.trim());
    const indent = lastItem ? /^\s*/.exec(lastItem)[0] : "    ";
    const closeIndent = /^\s*/.exec(lines[lines.length - 1])[0];
    replacement = `${inner.replace(/\s*$/, "")},\n${indent}${JSON.stringify(value)}\n${closeIndent}`;
  } else {
    replacement = `${inner.trimEnd()}, ${JSON.stringify(value)}`;
  }

  return source.slice(0, open + 1) + replacement + source.slice(close);
}

/**
 * The name a harness will record for this directory.
 *
 * Claude Code stores the session's `cwd`, and the adapter takes its basename —
 * so running init from `dev/thing/src` would register `src` and the allowlist
 * would never match. The repository root is what "the project" means here.
 */
export function projectName(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return path.basename(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return path.basename(path.resolve(cwd));
    dir = parent;
  }
}

/**
 * How many transcripts this project already has.
 *
 * Counted from directory names, not by parsing: Claude Code encodes the cwd in
 * the directory it stores a project's sessions under, so this stays instant
 * where `collect` would read a couple of hundred megabytes. Antigravity has no
 * such encoding and is not counted — the number is a prompt to consider a
 * backfill, not an inventory.
 */
export function existingSessions(config, name) {
  const source = config.sources.find((s) => s.harness === "claude-code");
  if (!source || !fs.existsSync(source.root)) return 0;

  let found = 0;
  for (const entry of fs.readdirSync(source.root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(`-${name}`)) continue;
    found += fs.readdirSync(path.join(source.root, entry.name)).filter((f) => f.endsWith(".jsonl")).length;
  }
  return found;
}

/** Whether sessions will be swept automatically, or only when run by hand. */
export function hookInstalled() {
  try {
    const settings = fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8");
    return settings.includes("carryover/hooks/session-start");
  } catch {
    return false;
  }
}

/**
 * Register `name`, plus any new domains, writing config.json once.
 *
 * Returns what changed rather than printing it, so the caller owns the output
 * and this stays testable.
 */
export function init(configFile, { name, domains = [] }) {
  let source = fs.readFileSync(configFile, "utf8");
  const changed = { project: null, domains: [] };

  const withProject = addToArray(source, "allow", name);
  if (withProject) {
    source = withProject;
    changed.project = name;
  }

  for (const domain of domains) {
    const next = addToArray(source, "domains", domain);
    if (next) {
      source = next;
      changed.domains.push(domain);
    }
  }

  if (changed.project || changed.domains.length) fs.writeFileSync(configFile, source);
  return changed;
}

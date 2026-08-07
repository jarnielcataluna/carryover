#!/usr/bin/env node
/**
 * SessionStart hook: kick off a sweep and return immediately.
 *
 * Two things this must never do. It must not block — a hook that waits ~25s per
 * session would make every `claude` launch feel broken. And it must not run
 * inside the extractor's own session: the extractor is `claude -p`, which fires
 * SessionStart itself, so an unguarded hook spawns an extractor that spawns a
 * hook that spawns an extractor.
 *
 * Wire it up (user settings.json):
 *
 *   { "hooks": { "SessionStart": [ { "hooks": [ {
 *       "type": "command",
 *       "command": "node \"C:/Users/New PC/Documents/dev/carryover/hooks/session-start.js\"",
 *       "timeout": 5
 *   } ] } ] } }
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CARRYOVER_CHILD === "1") process.exit(0);

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const log = path.join(repo, ".state", "sweep.log");
fs.mkdirSync(path.dirname(log), { recursive: true });

// A lock, because several editors opening at once would otherwise start
// several sweeps over the same transcripts.
const lock = path.join(repo, ".state", "sweep.lock");
try {
  const age = Date.now() - fs.statSync(lock).mtimeMs;
  if (age < 30 * 60 * 1000) process.exit(0);
} catch {
  // no lock yet — carry on
}
fs.writeFileSync(lock, String(process.pid));

const out = fs.openSync(log, "a");
const child = spawn(process.execPath, [path.join(repo, "bin", "carryover.js"), "extract"], {
  cwd: repo,
  detached: true,
  stdio: ["ignore", out, out],
  env: { ...process.env, CARRYOVER_CHILD: "1" },
});
child.unref();
process.exit(0);

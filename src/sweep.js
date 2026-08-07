/**
 * Find every session newer than the watermark, across every harness.
 *
 * A sweep rather than a per-session hook, for three reasons: it cannot miss a
 * session that ended in a crash or a killed terminal, Antigravity has no hook
 * system to attach to at all, and backfill is the same code path with an older
 * watermark instead of a second implementation.
 */

import fs from "node:fs";
import path from "node:path";
import * as claudeCode from "./adapters/claude-code.js";
import * as antigravity from "./adapters/antigravity.js";

const ADAPTERS = {
  "claude-code": claudeCode,
  antigravity,
};

/**
 * The extractor is itself `claude -p`, so it writes transcripts like any other
 * session — and ingesting those would mean summarising the act of summarising.
 * It runs from a scratch directory outside the allowlist, but that only holds
 * while the process is launched the expected way. This marker is carried in the
 * prompt itself and survives however it was invoked.
 */
const MARKERS = [
  "carryover:extractor-prompt",
  // Extractor runs from before the marker existed, still on disk.
  "deciding what, if\nanything, the person running it now knows",
];

function isExtractorRun(session) {
  return session.turns.some((t) => MARKERS.some((m) => t.text.includes(m)));
}

export function loadWatermark(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { lastRun: 0, seen: {} };
  }
}

export function saveWatermark(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

/**
 * Sessions to extract, oldest first, so notes accumulate in the order the work
 * actually happened and a later session can supersede an earlier one's claim.
 */
export function collect(config, state, { since = null } = {}) {
  const cutoff = since ?? state.lastRun ?? 0;
  const allow = config.projects?.allow ?? null;
  const found = [];

  for (const source of config.sources) {
    const adapter = ADAPTERS[source.harness];
    if (!adapter) continue;

    for (const file of adapter.discover(source.root)) {
      if (file.mtime <= cutoff) continue;
      if (state.seen?.[file.id] === file.mtime) continue;

      const session = adapter.parse(file, config.limits);
      session.mtime = file.mtime;

      if (!session.turns.length) continue;
      if (isExtractorRun(session)) continue;
      if (allow && !allow.includes(session.project)) {
        session.skipped = "project not in allowlist";
      }
      found.push(session);
    }
  }

  return found.sort((a, b) => a.mtime - b.mtime);
}

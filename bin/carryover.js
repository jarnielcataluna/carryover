#!/usr/bin/env node
/**
 * carryover — distil agent sessions into an Obsidian vault.
 *
 *   carryover sweep --dry     what would be extracted, and what it costs
 *   carryover stats           ingestion ratio across every session on disk
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../src/filter.js";
import { collect, loadWatermark, saveWatermark } from "../src/sweep.js";
import { extract, validate } from "../src/extract.js";
import { index } from "../src/vault.js";
import { writeProposals, writeSource, apply, expire, setStatus } from "../src/write.js";
import { init, projectName, existingSessions, hookInstalled } from "../src/init.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
const stateFile = path.join(root, ".state", "watermark.json");

const [command, ...flags] = process.argv.slice(2);
const dry = flags.includes("--dry");
const all = flags.includes("--all");

const USAGE = `carryover — distil agent sessions into an Obsidian vault

  init [--name=X] [--domain=Y]
                           register the project you are standing in
  stats                    ingestion ratio across every session on disk
  sweep [--all]            list what is eligible; never writes, never advances
  extract [--all] [--limit=N] [--dry]
                           run sessions through the extractor into inbox/
  approve [filter]         mark pending proposals approved
  reject  [filter]         mark pending proposals rejected
  apply                    act on everything marked approved or rejected
  skip                     move the watermark past the current backlog
  expire                   archive proposals left pending past the cutoff
`;

if (!command) {
  // Deliberately not defaulting to a command. The default used to be `sweep`,
  // which advanced the watermark — so a bare invocation silently marked
  // sessions processed that had never been extracted.
  console.log(USAGE);
  process.exit(0);
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const tokens = (chars) => `${Math.round(chars / 4 / 1000)}k`;

const limitFlag = flags.find((f) => f.startsWith("--limit="));
const limit = limitFlag ? Number(limitFlag.split("=")[1]) : Infinity;

switch (command) {
  case "init":
    setup();
    break;
  case "sweep":
    sweep();
    break;
  case "stats":
    stats();
    break;
  case "extract":
    await runExtract();
    break;
  case "apply": {
    const { applied, failed } = apply(config);
    for (const a of applied) console.log(`  ${a.action.padEnd(10)} ${a.title}`);
    for (const f of failed) console.log(`  FAILED     ${f.title} — ${f.why}`);
    console.log(`\n${applied.length} applied, ${failed.length} failed.`);
    break;
  }
  case "approve":
  case "reject": {
    const filter = flags.find((f) => !f.startsWith("--")) ?? null;
    const changed = setStatus(config, `${command}d`, filter);
    for (const title of changed) console.log(`  ${command}d   ${title}`);
    console.log(`\n${changed.length} marked — run \`carryover apply\` to act on them.`);
    break;
  }
  case "skip": {
    // Declare the existing backlog uninteresting without extracting it. The
    // transcripts stay on disk, so `extract --all` can still reach them later;
    // this only moves the line for what counts as new.
    const state = loadWatermark(stateFile);
    const before = collect(config, state).filter((s) => !s.skipped).length;
    state.lastRun = Date.now();
    saveWatermark(stateFile, state);
    console.log(`skipped ${before} pending session(s); watermark set to ${new Date(state.lastRun).toISOString()}`);
    console.log("they are still on disk — `carryover extract --all` reaches them whenever you want.");
    break;
  }
  case "expire": {
    const moved = expire(config);
    for (const title of moved) console.log(`  archived   ${title}`);
    console.log(`\n${moved.length} expired after ${config.expiryDays} days.`);
    break;
  }
  default:
    console.error(`unknown command: ${command}`);
    process.exit(1);
}

/**
 * Register the project the user is standing in.
 *
 * Deliberately reports the state it did *not* change — the hook, and any
 * transcripts that predate registration — because both are things that decide
 * whether this project's sessions actually get read, and neither is visible
 * from the config file it just edited.
 */
function setup() {
  const nameFlag = flags.find((f) => f.startsWith("--name="));
  const name = nameFlag ? nameFlag.slice("--name=".length) : projectName(process.cwd());
  const domains = flags.filter((f) => f.startsWith("--domain=")).map((f) => f.slice("--domain=".length).toLowerCase());

  const changed = init(path.join(root, "config.json"), { name, domains });

  console.log(`\n  project     ${name}`);
  console.log(`  allowlist   ${changed.project ? "added" : "already registered"}`);
  for (const d of domains) {
    console.log(`  domain      ${d} ${changed.domains.includes(d) ? "added" : "already in the vocabulary"}`);
  }
  console.log(`  hook        ${hookInstalled() ? "installed — sessions sweep on launch" : "NOT installed — run `carryover extract` by hand"}`);

  // Sessions that ran before this moment were skipped as out-of-allowlist, and
  // a skipped session older than an extracted one stays behind the watermark
  // for good. `--all` is the only thing that reaches them.
  const already = changed.project ? existingSessions(config, name) : 0;
  if (already) {
    console.log(`\n  ${already} transcript(s) already on disk predate this — they are behind the watermark.`);
    console.log("  carryover extract --all --limit=5    to reach them, a slice at a time");
  }

  console.log(
    changed.project
      ? "\nregistered. nothing else to do — sessions in this project are swept from now on.\n"
      : "\nnothing to do.\n",
  );
}

function sweep() {
  const state = loadWatermark(stateFile);
  const sessions = collect(config, state, { since: all ? 0 : null });

  if (!sessions.length) {
    console.log("nothing new since last sweep.");
    return;
  }

  let chars = 0;
  let extractable = 0;

  for (const session of sessions) {
    const body = render(session, config.limits);
    const skip = session.skipped;
    if (!skip) {
      chars += body.length;
      extractable++;
    }
    console.log(
      [
        skip ? "skip" : "  ok",
        session.harness.padEnd(12),
        (session.project ?? "?").padEnd(18),
        `${String(session.turns.length).padStart(4)} turns`,
        kb(body.length).padStart(8),
        skip ? `— ${skip}` : "",
      ].join("  "),
    );
  }

  console.log(
    `\n${extractable} to extract, ${sessions.length - extractable} skipped` +
      `  |  ${kb(chars)} total, ~${tokens(chars)} tokens`,
  );

  // sweep only ever reads. Advancing the watermark here would mark sessions
  // processed that were never extracted, and they would never be seen again —
  // the same silent-stranding failure `extract` was already fixed for.
  console.log("\n(nothing written — `carryover extract` is what processes these)");
}

/**
 * Run sessions through the extractor and print what it proposes.
 *
 * Nothing is written yet — this exists to iterate on prompts/extract.md, which
 * is the only part of the system where quality is decided.
 */
async function runExtract() {
  const state = loadWatermark(stateFile);
  const sessions = collect(config, state, { since: all ? 0 : null })
    .filter((s) => !s.skipped)
    .slice(0, limit);

  if (!sessions.length) {
    console.log("no sessions to extract.");
    return;
  }

  const existingTitles = new Set(index(config).map((n) => n.title));
  let total = 0;

  for (const session of sessions) {
    const label = `${session.harness}/${session.project}/${session.id.slice(0, 8)}`;
    process.stdout.write(`\n${"─".repeat(72)}\n${label}  (${session.turns.length} turns)\n`);

    let result;
    const started = Date.now();
    try {
      result = await extract(session, config);
    } catch (error) {
      console.log(`  FAILED: ${error.message}`);
      continue;
    }
    const secs = ((Date.now() - started) / 1000).toFixed(0);

    if (!result.ok) {
      console.log(`  unparseable output (${secs}s): ${result.error}`);
      console.log(`  ${result.raw.trim().slice(0, 300)}`);
      continue;
    }

    console.log(`  prompt ${kb(result.promptChars)}, ${secs}s → ${result.proposals.length} proposal(s)`);
    total += result.proposals.length;

    for (const p of result.proposals) {
      const problems = validate(p, config, existingTitles);
      const head = p.action === "create" ? p.title : `${p.action} → ${p.target}`;
      console.log(`\n  [${p.action}] ${head}`);
      if (p.type || p.domain) console.log(`    ${p.type ?? "?"} · ${[].concat(p.domain ?? []).join(", ")} · ${p.confidence ?? "?"}`);
      if (p.reason) console.log(`    reason: ${p.reason}`);
      console.log(`    ${String(p.body ?? "").replace(/\s+/g, " ").slice(0, 260)}`);
      if (problems.length) console.log(`    ⚠ ${problems.join("; ")}`);
      if (p.action === "create" && p.title) existingTitles.add(p.title);
    }

    if (!dry) {
      // Written per session, not batched at the end, so the next session in
      // this same run sees these in the index and proposes against them.
      const files = writeProposals(session, result.proposals, config);
      writeSource(session, config, result.proposals.length);
      if (files.length) console.log(`\n  → ${files.length} written to inbox/`);
      // The watermark tracks the newest session actually processed, never the
      // clock. Advancing it to `now` would strand every session that a --limit
      // or a crash stopped us reaching, since all of them predate "now".
      state.lastRun = Math.max(state.lastRun ?? 0, session.mtime);
      state.seen = { ...state.seen, [session.id]: session.mtime };
      saveWatermark(stateFile, state);
    }
  }

  const tail = dry ? "nothing written (dry run)" : "written to inbox/ — review in Obsidian, then `carryover apply`";
  console.log(`\n${"─".repeat(72)}\n${sessions.length} session(s), ${total} proposal(s) — ${tail}.`);
}

/**
 * The SessionStart hook takes this before spawning; releasing it is ours.
 *
 * Only the process the hook launched may release it. This used to run for every
 * command, so `carryover init` — or `apply`, or `stats` — would clear the lock
 * out from under a sweep that was still running, and the next session to start
 * would launch a second sweep over the same transcripts.
 */
process.on("exit", () => {
  if (process.env.CARRYOVER_CHILD !== "1") return;
  try {
    fs.unlinkSync(path.join(root, ".state", "sweep.lock"));
  } catch {
    // never held, or already released
  }
});

/** Confirms the ingestion ratio holds — the premise the whole design rests on. */
function stats() {
  const state = { lastRun: 0, seen: {} };
  const sessions = collect(config, state, { since: 0 });
  const byHarness = new Map();

  for (const session of sessions) {
    const raw = fs.statSync(session.path).size;
    const kept = render(session, config.limits).length;
    const acc = byHarness.get(session.harness) ?? { n: 0, raw: 0, kept: 0 };
    acc.n++;
    acc.raw += raw;
    acc.kept += kept;
    byHarness.set(session.harness, acc);
  }

  for (const [harness, a] of byHarness) {
    console.log(
      `${harness.padEnd(14)} ${String(a.n).padStart(3)} sessions  ` +
        `raw ${kb(a.raw).padStart(9)}  kept ${kb(a.kept).padStart(8)}  ` +
        `(${((100 * a.kept) / a.raw).toFixed(1)}%)  ` +
        `avg ~${tokens(a.kept / a.n)} tokens/session`,
    );
  }
}

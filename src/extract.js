/**
 * Run one session through the extractor.
 *
 * The extractor is headless Claude Code (`claude -p`), not an API call: it bills
 * against a subscription that already exists rather than per token, and this
 * repo stays runnable by anyone with the CLI installed and no key to configure.
 *
 * It is a single shot with no tools. The vault index is small enough to hand
 * over whole, and a complete index beats a search tool that can miss the one
 * note that mattered.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { render } from "./filter.js";
import { index, renderIndex } from "./vault.js";

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEMPLATE = fs.readFileSync(path.join(here, "prompts", "extract.md"), "utf8");

export function buildPrompt(session, config) {
  return [
    TEMPLATE,
    "",
    "## Controlled vocabulary for `domain`",
    "",
    config.domains.map((d) => `- ${d}`).join("\n"),
    "",
    "## Notes that already exist",
    "",
    renderIndex(index(config)),
    "",
    "## The session",
    "",
    render(session, config.limits),
  ].join("\n");
}

/**
 * The extractor writes its own transcript, so it must not become an input to
 * itself. It is run from a dedicated scratch directory whose project name is
 * deliberately absent from the allowlist, which keeps every extractor session
 * out of every future sweep without needing to recognise them by content.
 */
const SCRATCH = path.join(here, ".state", "extractor");

export async function extract(session, config) {
  const prompt = buildPrompt(session, config);
  const { command, args, timeoutMs } = config.extractor;
  fs.mkdirSync(SCRATCH, { recursive: true });
  const raw = await run(command, args, prompt, timeoutMs);
  return { ...parse(raw), promptChars: prompt.length, raw };
}

function run(command, args, stdin, timeoutMs) {
  return new Promise((resolve, reject) => {
    // No shell: `claude` is a real executable on every platform, and a shell
    // here would concatenate rather than escape the arguments.
    const child = spawn(command, args, {
      cwd: SCRATCH,
      // Seen by the SessionStart hook, which exits rather than starting a
      // sweep that would spawn another extractor, and so on without end.
      env: { ...process.env, CARRYOVER_CHILD: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`extractor timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`extractor exited ${code}: ${err.trim().slice(0, 400)}`));
      else resolve(out);
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * The prompt asks for bare JSON, and usually gets it. Models still fence it
 * sometimes, so find the object rather than trusting the whole string.
 */
function parse(raw) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = fenced ? fenced[1] : sliceObject(raw);

  try {
    const parsed = JSON.parse(candidate);
    const proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
    return { proposals, ok: true };
  } catch (error) {
    return { proposals: [], ok: false, error: error.message };
  }
}

function sliceObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end <= start ? text : text.slice(start, end + 1);
}

/** Anything the human should be told before they read a proposal on its merits. */
export function validate(proposal, config, existingTitles) {
  const problems = [];
  const { action } = proposal;

  if (!["create", "update", "contradict"].includes(action)) {
    problems.push(`unknown action "${action}"`);
    return problems;
  }

  if (action === "create") {
    if (!proposal.title) problems.push("no title");
    if (existingTitles.has(proposal.title)) problems.push("title already exists");
  } else if (!existingTitles.has(proposal.target)) {
    problems.push(`target not found: "${proposal.target}"`);
  }

  const domains = [].concat(proposal.domain ?? []);
  for (const d of domains) {
    if (d !== "unknown" && !config.domains.includes(d)) problems.push(`domain outside vocabulary: "${d}"`);
  }
  if (domains.includes("unknown")) problems.push("needs a domain");

  const words = String(proposal.body ?? "").split(/\s+/).filter(Boolean).length;
  if (!words) problems.push("empty body");
  else if (words > 260) problems.push(`body is ${words} words`);

  return problems;
}

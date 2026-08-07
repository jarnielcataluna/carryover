/**
 * Shared policy for what survives ingestion.
 *
 * Adapters know their own wire format and pull out prose plus tool names; this
 * module owns the rules that must be identical across harnesses, so a session
 * reads the same to the extractor whichever tool produced it.
 *
 * Measured on 8 Claude Code sessions: raw 138.5 MB, kept 1.2 MB (0.9%). The
 * discarded 99% is tool output, file contents, images and system reminders —
 * all of it either already on disk or worthless a day later.
 */

/** Wrapper tags harnesses inject around user text, stripped with their contents. */
const WRAPPED = [
  "system-reminder",
  "ADDITIONAL_METADATA",
  "USER_SETTINGS_CHANGE",
  "local-command-stdout",
  "command-message",
  "command-args",
  "command-name",
];

/** Text that is a harness artefact rather than something a person or model said. */
const NOISE = [
  /^\s*$/,
  /^<[a-z-]+>[\s\S]*<\/[a-z-]+>\s*$/i, // a bare wrapper with nothing else in it
  /^Caveat: The messages below were generated/,
  /^\[Request interrupted/,
];

export function clean(text) {
  if (typeof text !== "string") return "";
  let out = text;
  for (const tag of WRAPPED) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "gi"), "");
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/>`, "gi"), "");
  }
  // USER_REQUEST wraps the real prompt in Antigravity — keep the contents.
  out = out.replace(/<\/?USER_REQUEST>/gi, "");
  return out.trim();
}

export function isNoise(text) {
  return NOISE.some((re) => re.test(text));
}

/** One turn in, one turn out — or null when nothing of substance is left. */
export function keepTurn(turn, limits) {
  const text = clean(turn.text);
  const tools = turn.tools ?? [];
  if ((isNoise(text) || !text) && tools.length === 0) return null;

  return {
    role: turn.role,
    text: truncate(text, limits.maxTurnChars),
    tools,
  };
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n…[${text.length - max} chars omitted]…\n\n${text.slice(-tail)}`;
}

/**
 * Merge runs of wordless tool calls into one turn.
 *
 * A long agentic stretch is dozens of consecutive assistant turns carrying a
 * tool name and nothing else. The sequence of tools is worth keeping; the turn
 * boundaries between them are not, and they cost a heading each.
 */
function coalesce(turns) {
  const out = [];
  for (const turn of turns) {
    const previous = out.at(-1);
    const mergeable =
      previous && !turn.text && !previous.text && previous.role === turn.role;

    if (mergeable) previous.tools.push(...turn.tools);
    else out.push({ ...turn, tools: [...turn.tools] });
  }
  return out;
}

/**
 * Render a normalized session as the markdown the extractor reads.
 *
 * Tool calls appear as bare names. The extractor needs to know that a search
 * happened; it does not need what the search returned, and the return value is
 * where all the tokens are.
 */
export function render(session, limits) {
  const lines = [
    `# Session ${session.id}`,
    `harness: ${session.harness}`,
    `project: ${session.project ?? "unknown"}`,
    `started: ${session.startedAt ?? "unknown"}`,
    "",
  ];

  for (const turn of coalesce(session.turns)) {
    lines.push(`## ${turn.role}`);
    if (turn.text) lines.push(turn.text);
    if (turn.tools.length) lines.push(`_tools: ${turn.tools.join(", ")}_`);
    lines.push("");
  }

  const body = lines.join("\n");
  return body.length <= limits.maxTranscriptChars
    ? body
    : truncate(body, limits.maxTranscriptChars);
}

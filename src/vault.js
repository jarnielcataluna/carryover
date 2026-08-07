/**
 * Reading and writing the vault as plain files.
 *
 * Everything here uses `fs` rather than the Obsidian REST API on purpose: the
 * API only answers while Obsidian is running, and a sweep that fires from a
 * SessionStart hook has no business caring whether an app is open. Obsidian
 * picks up files from disk either way.
 */

import fs from "node:fs";
import path from "node:path";

/** Frontmatter fields carryover owns. Anything else in a note is left alone. */
const FIELDS = [
  "title",
  "type",
  "status",
  "domain",
  "harness",
  "session",
  "confidence",
  "created",
  "action", // create | update | contradict — only while a proposal is pending
  "target", // the note an update or contradiction applies to
  "reason",
  "supersedes",
];

export function parseNote(raw) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    frontmatter[key] = value.startsWith("[")
      ? value.slice(1, -1).split(",").map((v) => v.trim()).filter(Boolean)
      : value.replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body: match[2].trim() };
}

export function renderNote(frontmatter, body) {
  const lines = ["---"];
  for (const key of FIELDS) {
    const value = frontmatter[key];
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${key}: ${Array.isArray(value) ? `[${value.join(", ")}]` : value}`);
  }
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

/**
 * Every note the extractor must decide against — approved notes plus anything
 * still pending, so two sessions in one sweep cannot each propose the same note.
 */
export function index(config) {
  const out = [];
  for (const folder of [config.folders.notes, config.folders.inbox]) {
    const dir = path.join(config.vault, folder);
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      const full = path.join(dir, file);
      const { frontmatter, body } = parseNote(fs.readFileSync(full, "utf8"));
      out.push({
        title: frontmatter.title ?? file.replace(/\.md$/, ""),
        type: frontmatter.type ?? "fact",
        domain: [].concat(frontmatter.domain ?? []),
        status: frontmatter.status ?? "approved",
        path: full,
        summary: firstSentence(body),
      });
    }
  }
  return out;
}

/** The index is a decision aid, not the notes themselves — one line each. */
export function renderIndex(notes) {
  if (!notes.length) return "(the vault is empty — every proposal will be a `create`)";
  return notes
    .map((n) => {
      const pending = n.status === "pending" ? " [pending review]" : "";
      return `- **${n.title}**${pending} — ${n.domain.join(", ") || "?"} — ${n.summary}`;
    })
    .join("\n");
}

function firstSentence(body) {
  const text = body.replace(/\s+/g, " ").trim();
  const stop = text.search(/\.\s|\.$/);
  const sentence = stop === -1 ? text : text.slice(0, stop + 1);
  return sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence;
}

export function ensureFolders(config) {
  for (const folder of Object.values(config.folders)) {
    fs.mkdirSync(path.join(config.vault, folder), { recursive: true });
  }
}

/** Titles become filenames; the title is the identity, the path just follows it. */
export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

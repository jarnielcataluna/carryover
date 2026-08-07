/**
 * Writing proposals into the vault, and applying the ones you approve.
 *
 * Nothing the extractor produces ever lands in `notes/` directly. Every
 * proposal — including an edit to a note that already exists — becomes a file
 * in `inbox/` carrying `status: pending`. Approving is setting that field to
 * `approved` in Obsidian; `carryover apply` is what then moves or merges it.
 *
 * The gate is the point. An extractor that could write straight to `notes/`
 * would fill the vault with plausible-sounding claims nobody ever checked.
 */

import fs from "node:fs";
import path from "node:path";
import { renderNote, parseNote, slugify, ensureFolders } from "./vault.js";

const today = () => new Date().toISOString().slice(0, 10);

export function writeProposals(session, proposals, config) {
  ensureFolders(config);
  const inbox = path.join(config.vault, config.folders.inbox);
  const written = [];

  for (const proposal of proposals) {
    const title = proposal.action === "create" ? proposal.title : `${proposal.action}: ${proposal.target}`;
    const file = path.join(inbox, `${slugify(title)}.md`);
    if (fs.existsSync(file)) continue; // an identical proposal is already queued

    const frontmatter = {
      title,
      type: proposal.type ?? proposal.action,
      status: "pending",
      domain: [].concat(proposal.domain ?? []),
      harness: session.harness,
      session: session.id,
      confidence: proposal.confidence ?? "high",
      created: today(),
      action: proposal.action,
      target: proposal.target,
      reason: proposal.reason,
    };

    fs.writeFileSync(file, renderNote(frontmatter, proposal.body ?? ""));
    written.push(file);
  }

  return written;
}

/** Provenance: where a note came from, so a claim can be traced to its session. */
export function writeSource(session, config, proposalCount) {
  ensureFolders(config);
  const file = path.join(config.vault, config.folders.sources, `${session.id}.md`);

  const body = [
    `${session.project ?? "unknown project"} · ${session.turns.length} turns · ${session.harness}`,
    "",
    `Started: ${session.startedAt ?? "unknown"}`,
    `Proposed: ${proposalCount} note(s)`,
    "",
    "Transcript (not in the vault — this is a pointer, the file stays where the harness wrote it):",
    "",
    "```",
    session.path,
    "```",
  ].join("\n");

  fs.writeFileSync(
    file,
    renderNote(
      { title: `Session ${session.id.slice(0, 8)}`, type: "source", harness: session.harness, session: session.id, created: today() },
      body,
    ),
  );
  return file;
}

/**
 * Apply everything marked `approved`. Creates move to `notes/`; updates and
 * contradictions overwrite their target's body and are archived. Anything still
 * pending is left exactly where it is.
 */
export function apply(config) {
  const inbox = path.join(config.vault, config.folders.inbox);
  const notes = path.join(config.vault, config.folders.notes);
  const archive = path.join(config.vault, config.folders.archive);
  ensureFolders(config);

  const applied = [];
  const failed = [];

  for (const name of fs.existsSync(inbox) ? fs.readdirSync(inbox) : []) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(inbox, name);
    const { frontmatter, body } = parseNote(fs.readFileSync(file, "utf8"));

    if (frontmatter.status === "rejected") {
      fs.renameSync(file, path.join(archive, name));
      applied.push({ action: "rejected", title: frontmatter.title });
      continue;
    }
    if (frontmatter.status !== "approved") continue;

    const action = frontmatter.action ?? "create";

    if (action === "create") {
      const target = path.join(notes, name);
      fs.writeFileSync(target, renderNote({ ...frontmatter, status: "approved", action: undefined, target: undefined, reason: undefined }, body));
      fs.unlinkSync(file);
      applied.push({ action: "create", title: frontmatter.title });
      continue;
    }

    const target = findByTitle(notes, frontmatter.target);
    if (!target) {
      failed.push({ title: frontmatter.title, why: `target not found: ${frontmatter.target}` });
      continue;
    }

    const existing = parseNote(fs.readFileSync(target, "utf8"));
    const merged = {
      ...existing.frontmatter,
      status: "approved",
      // A contradiction records what it overturned; an update just supersedes.
      supersedes: action === "contradict" ? frontmatter.reason : existing.frontmatter.supersedes,
    };
    fs.writeFileSync(target, renderNote(merged, body));
    fs.renameSync(file, path.join(archive, name));
    applied.push({ action, title: frontmatter.target });
  }

  return { applied, failed };
}

/**
 * Set the verdict on pending proposals from the terminal.
 *
 * This is for recording a decision you have already made — reading the notes
 * still happens in Obsidian, where the prose is legible. A blanket approve of
 * things you have not read defeats the only safeguard in the system.
 */
export function setStatus(config, status, filter = null) {
  const inbox = path.join(config.vault, config.folders.inbox);
  if (!fs.existsSync(inbox)) return [];

  const changed = [];
  for (const name of fs.readdirSync(inbox)) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(inbox, name);
    const { frontmatter, body } = parseNote(fs.readFileSync(file, "utf8"));
    if (frontmatter.status !== "pending") continue;

    const title = frontmatter.title ?? name;
    if (filter && !title.toLowerCase().includes(filter.toLowerCase())) continue;

    fs.writeFileSync(file, renderNote({ ...frontmatter, status }, body));
    changed.push(title);
  }
  return changed;
}

/** A proposal you did not want in a month is a proposal you do not want. */
export function expire(config) {
  const inbox = path.join(config.vault, config.folders.inbox);
  const archive = path.join(config.vault, config.folders.archive);
  if (!fs.existsSync(inbox)) return [];

  const cutoff = Date.now() - config.expiryDays * 86400000;
  const moved = [];

  for (const name of fs.readdirSync(inbox)) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(inbox, name);
    const { frontmatter } = parseNote(fs.readFileSync(file, "utf8"));
    if (frontmatter.status !== "pending") continue;
    if (new Date(frontmatter.created ?? today()).getTime() > cutoff) continue;

    fs.renameSync(file, path.join(archive, name));
    moved.push(frontmatter.title);
  }
  return moved;
}

function findByTitle(dir, title) {
  if (!title || !fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(dir, name);
    const { frontmatter } = parseNote(fs.readFileSync(file, "utf8"));
    if (frontmatter.title === title) return file;
  }
  return null;
}

// One-time migration of a legacy SQLite session store (.reagent/reagent.db,
// created by older ReAgent versions) into the new one-JSONL-file-per-session
// layout under .reagent/sessions/. node:sqlite is used ONLY here, so the app
// itself carries no SQLite dependency.
//
// Usage: node scripts/migrate-sessions.mjs [projectDir]
// Safe to run more than once: it skips sessions that already have a .jsonl and
// renames reagent.db to reagent.db.bak when done.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const projectDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const stateDir = path.join(projectDir, ".reagent");
const dbPath = path.join(stateDir, "reagent.db");
const sessionsDir = path.join(stateDir, "sessions");

if (!fs.existsSync(dbPath)) {
  console.log(`No reagent.db at ${dbPath}; nothing to migrate.`);
  process.exit(0);
}

fs.mkdirSync(sessionsDir, { recursive: true });
const db = new DatabaseSync(dbPath);

let rows;
try {
  rows = db
    .prepare("SELECT id, title, created_at, updated_at, messages, todos, usage FROM sessions")
    .all();
} finally {
  db.close();
}

const parse = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

let written = 0;
let skipped = 0;
for (const row of rows) {
  const file = path.join(sessionsDir, `${row.id}.jsonl`);
  if (fs.existsSync(file)) {
    skipped += 1;
    continue;
  }
  const messages = parse(row.messages, []);
  const envelope = {
    v: 1,
    id: String(row.id),
    title: typeof row.title === "string" ? row.title : "",
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
    message_count: Array.isArray(messages) ? messages.length : 0,
    todos: parse(row.todos, []),
    usage: parse(row.usage, {}),
  };
  const lines = [JSON.stringify(envelope), ...messages.map((m) => JSON.stringify(m))];
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, lines.join("\n") + "\n");
  fs.renameSync(tmp, file);
  written += 1;
}

// Retire the old database so it is not read again (kept as .bak, not deleted).
for (const suffix of ["", "-wal", "-shm"]) {
  const p = dbPath + suffix;
  if (fs.existsSync(p)) fs.renameSync(p, p.replace(/reagent\.db/, "reagent.db.bak"));
}

console.log(
  `Migrated ${written} session(s) to ${sessionsDir}` +
    (skipped ? `, skipped ${skipped} already present` : "") +
    `. reagent.db renamed to reagent.db.bak.`,
);

// A D1-shaped wrapper over node:sqlite, so worker code that takes a `db` can be run in a test
// exactly as it runs in the Worker: prepare/bind/first/run/all, and a batch that is a real
// transaction. Without this the billing path — the one that takes people's money — could only
// be tested by reading it.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  #p() { return this.db.prepare(this.sql); }
  async first() { const r = this.#p().get(...this.args); return r === undefined ? null : r; }
  async all() { return { results: this.#p().all(...this.args), success: true }; }
  async run() {
    const r = this.#p().run(...this.args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function d1(migrationsDir) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort())
    db.exec(readFileSync(join(migrationsDir, f), "utf8"));
  return {
    raw: db,
    prepare: sql => new Stmt(db, sql),
    // D1's batch is documented as a transaction: if any statement fails the whole sequence is
    // rolled back. Reproducing that is the entire point of this shim — code that relies on it
    // for atomicity must be tested against something that actually rolls back.
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

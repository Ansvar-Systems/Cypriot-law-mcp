// Flip journal_mode WAL -> DELETE and VACUUM so the runtime WASM SQLite
// (@ansvar/mcp-sqlite) can read the DB. ingest:paid leaves the DB in WAL
// mode by default; WASM SQLite can only read DELETE-mode journals.
// Without this, runtime crashes on first db.prepare() with "unable to
// open database file" (byte 18 of the file = 0x02 instead of 0x01).

const Database = require("better-sqlite3");
const path = require("path");

const dbPath = process.argv[2] || path.resolve(__dirname, "../data/database.db");
const db = new Database(dbPath);
const before = db.pragma("journal_mode", { simple: true });
db.pragma("journal_mode = DELETE");
const after = db.pragma("journal_mode", { simple: true });
db.prepare("VACUUM").run();
db.close();
console.log(`finalised ${dbPath}: journal_mode ${before} -> ${after} + VACUUM`);

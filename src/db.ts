import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DATABASE_PATH ?? "data/tl.db";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  sector TEXT DEFAULT '',
  city TEXT DEFAULT '',
  description TEXT DEFAULT '',
  services TEXT DEFAULT '',
  hours TEXT DEFAULT '{}',
  slot_minutes INTEGER DEFAULT 60,
  tone TEXT DEFAULT 'cordiale e professionale, dai del Lei',
  faq TEXT DEFAULT '',
  owner_phone TEXT DEFAULT '',
  wa_phone_number_id TEXT DEFAULT '',
  wa_token TEXT DEFAULT '',
  ai_enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT DEFAULT '',
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  channel TEXT NOT NULL,              -- whatsapp | sito | test | manuale
  external_id TEXT NOT NULL,          -- numero WhatsApp o id visitatore
  name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  status TEXT DEFAULT 'nuovo',        -- nuovo | in trattativa | cliente | perso
  interest TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  ai_paused INTEGER DEFAULT 0,
  unread INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  last_message_at TEXT DEFAULT (datetime('now')),
  UNIQUE (business_id, channel, external_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  author TEXT NOT NULL,               -- cliente | agente | titolare
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, id);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  starts_at TEXT NOT NULL,            -- ora locale Europe/Rome, 'YYYY-MM-DDTHH:MM'
  duration_minutes INTEGER NOT NULL,
  service TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  status TEXT DEFAULT 'confermato',   -- confermato | annullato
  created_by TEXT DEFAULT 'agente',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  title TEXT NOT NULL,
  detail TEXT DEFAULT '',
  action_type TEXT NOT NULL,          -- followup | ad_draft | nota
  action_payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'da fare',      -- da fare | fatto | scartata
  result TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ad_drafts (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  platform TEXT NOT NULL,
  headline TEXT NOT NULL,
  body TEXT NOT NULL,
  cta TEXT DEFAULT 'Scrivici',
  audience TEXT DEFAULT '',
  daily_budget REAL DEFAULT 5,
  status TEXT DEFAULT 'bozza',        -- bozza | approvata | scartata
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS owner_chat (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  role TEXT NOT NULL,                 -- user | assistant
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL,
  agent TEXT NOT NULL,
  model TEXT DEFAULT '',
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  stop_reason TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Migrazioni: colonne aggiunte dopo la prima versione (idempotenti).
function addColumn(table: string, column: string, def: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
// Prequalifica
addColumn("businesses", "qualification_rules", "TEXT DEFAULT ''");
addColumn("contacts", "score", "INTEGER");                       // 0-100, NULL = non ancora valutato
addColumn("contacts", "qualification", "TEXT DEFAULT ''");       // motivazione breve
// Follow-up automatici
addColumn("businesses", "followup_enabled", "INTEGER DEFAULT 0");
addColumn("businesses", "followup_after_hours", "INTEGER DEFAULT 20");
addColumn("businesses", "followup_max", "INTEGER DEFAULT 2");
addColumn("businesses", "wa_followup_template", "TEXT DEFAULT ''"); // modello approvato da Meta, per fuori finestra 24h
addColumn("contacts", "followup_count", "INTEGER DEFAULT 0");
addColumn("contacts", "last_customer_at", "TEXT");
addColumn("messages", "kind", "TEXT DEFAULT ''");                // '' | followup
db.exec(`UPDATE contacts SET last_customer_at =
  (SELECT max(created_at) FROM messages m WHERE m.contact_id = contacts.id AND m.author = 'cliente')
  WHERE last_customer_at IS NULL`);

export const HOT_SCORE = 70;

export type Row = Record<string, any>;

export function one<T = Row>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T = Row>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}

export interface Business {
  id: number;
  slug: string;
  name: string;
  sector: string;
  city: string;
  description: string;
  services: string;
  hours: string;
  slot_minutes: number;
  tone: string;
  faq: string;
  owner_phone: string;
  wa_phone_number_id: string;
  wa_token: string;
  ai_enabled: number;
  qualification_rules: string;
  followup_enabled: number;
  followup_after_hours: number;
  followup_max: number;
  wa_followup_template: string;
}

export interface Contact {
  id: number;
  business_id: number;
  channel: string;
  external_id: string;
  name: string;
  phone: string;
  email: string;
  status: string;
  interest: string;
  notes: string;
  ai_paused: number;
  unread: number;
  created_at: string;
  last_message_at: string;
  score: number | null;
  qualification: string;
  followup_count: number;
  last_customer_at: string | null;
}

export function getBusiness(id: number): Business {
  const b = one<Business>("SELECT * FROM businesses WHERE id = ?", id);
  if (!b) throw new Error(`Attività ${id} non trovata`);
  return b;
}

export function getContact(businessId: number, contactId: number): Contact | undefined {
  return one<Contact>("SELECT * FROM contacts WHERE id = ? AND business_id = ?", contactId, businessId);
}

/** Trova o crea il contatto per un canale (es. numero WhatsApp). */
export function upsertContact(
  businessId: number,
  channel: string,
  externalId: string,
  defaults: { name?: string; phone?: string } = {},
): Contact {
  const existing = one<Contact>(
    "SELECT * FROM contacts WHERE business_id = ? AND channel = ? AND external_id = ?",
    businessId,
    channel,
    externalId,
  );
  if (existing) {
    if (!existing.name && defaults.name) {
      run("UPDATE contacts SET name = ? WHERE id = ?", defaults.name, existing.id);
      existing.name = defaults.name;
    }
    return existing;
  }
  const r = run(
    "INSERT INTO contacts (business_id, channel, external_id, name, phone) VALUES (?, ?, ?, ?, ?)",
    businessId,
    channel,
    externalId,
    defaults.name ?? "",
    defaults.phone ?? "",
  );
  return getContact(businessId, Number(r.lastInsertRowid))!;
}

export function addMessage(
  businessId: number,
  contactId: number,
  author: "cliente" | "agente" | "titolare",
  text: string,
  kind: "" | "followup" = "",
) {
  run("INSERT INTO messages (business_id, contact_id, author, text, kind) VALUES (?, ?, ?, ?, ?)", businessId, contactId, author, text, kind);
  if (author === "cliente") {
    // Il cliente ha risposto: la sequenza di follow-up riparte da zero.
    run(
      `UPDATE contacts SET last_message_at = datetime('now'), last_customer_at = datetime('now'), unread = unread + 1, followup_count = 0 WHERE id = ?`,
      contactId,
    );
  } else {
    run(`UPDATE contacts SET last_message_at = datetime('now') WHERE id = ?`, contactId);
  }
}

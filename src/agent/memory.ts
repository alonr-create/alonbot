import { db } from '../utils/db.js';

const CONTEXT_LIMIT = 50;

interface MessageRow {
  role: string;
  content: string;
  created_at: string;
}

const stmtInsert = db.prepare(
  `INSERT INTO messages (channel, sender_id, sender_name, role, content) VALUES (?, ?, ?, ?, ?)`
);

const stmtHistory = db.prepare(
  `SELECT role, content, created_at FROM messages
   WHERE channel = ? AND sender_id = ?
   ORDER BY id DESC LIMIT ?`
);

const stmtSetFact = db.prepare(
  `INSERT INTO facts (key, value, updated_at) VALUES (?, ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
);

const stmtGetFacts = db.prepare(`SELECT key, value FROM facts ORDER BY updated_at DESC LIMIT 50`);

export function saveMessage(channel: string, senderId: string, senderName: string, role: 'user' | 'assistant', content: string) {
  stmtInsert.run(channel, senderId, senderName, role, content);
}

export function getHistory(channel: string, senderId: string): Array<{ role: string; content: string }> {
  const rows = stmtHistory.all(channel, senderId, CONTEXT_LIMIT) as MessageRow[];
  return rows.reverse().map(r => ({ role: r.role, content: r.content }));
}

export function setFact(key: string, value: string) {
  stmtSetFact.run(key, value);
}

export function getAllFacts(): Array<{ key: string; value: string }> {
  return stmtGetFacts.all() as Array<{ key: string; value: string }>;
}

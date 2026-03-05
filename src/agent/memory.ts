import { db } from '../utils/db.js';

const CONTEXT_LIMIT = 20; // reduced from 50 — summaries fill the gap

// --- Types ---

export interface Memory {
  id: number;
  type: string;
  category: string | null;
  content: string;
  importance: number;
  source: string;
  created_at: string;
  last_accessed: string | null;
  access_count: number;
}

interface MessageRow {
  role: string;
  content: string;
  created_at: string;
}

interface SummaryRow {
  summary: string;
  topics: string | null;
  from_date: string;
  to_date: string;
}

// --- Prepared Statements ---

const stmtInsertMsg = db.prepare(
  `INSERT INTO messages (channel, sender_id, sender_name, role, content) VALUES (?, ?, ?, ?, ?)`
);

const stmtHistory = db.prepare(
  `SELECT role, content, created_at FROM messages
   WHERE channel = ? AND sender_id = ?
   ORDER BY id DESC LIMIT ?`
);

const stmtMessageCount = db.prepare(
  `SELECT COUNT(*) as count FROM messages WHERE channel = ? AND sender_id = ?`
);

const stmtInsertMemory = db.prepare(
  `INSERT INTO memories (type, category, content, importance, source) VALUES (?, ?, ?, ?, ?)`
);

const stmtHighImportance = db.prepare(
  `SELECT * FROM memories WHERE importance >= 8 ORDER BY importance DESC, created_at DESC LIMIT 15`
);

const stmtRecentlyAccessed = db.prepare(
  `SELECT * FROM memories WHERE last_accessed >= datetime('now', '-7 days') ORDER BY last_accessed DESC LIMIT 10`
);

const stmtSearchMemories = db.prepare(
  `SELECT * FROM memories WHERE content LIKE ? ORDER BY importance DESC LIMIT 10`
);

const stmtCategoryMemories = db.prepare(
  `SELECT * FROM memories WHERE category = ? ORDER BY importance DESC, created_at DESC LIMIT 10`
);

const stmtAllMemories = db.prepare(
  `SELECT * FROM memories ORDER BY importance DESC, created_at DESC LIMIT 30`
);

const stmtTouchMemory = db.prepare(
  `UPDATE memories SET last_accessed = datetime('now'), access_count = access_count + 1 WHERE id = ?`
);

const stmtInsertSummary = db.prepare(
  `INSERT INTO conversation_summaries (channel, sender_id, summary, topics, message_count, from_date, to_date)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

const stmtRecentSummaries = db.prepare(
  `SELECT summary, topics, from_date, to_date FROM conversation_summaries
   WHERE channel = ? AND sender_id = ?
   ORDER BY created_at DESC LIMIT 5`
);

const stmtUnsummarizedMessages = db.prepare(
  `SELECT role, content, created_at FROM messages
   WHERE channel = ? AND sender_id = ?
   AND created_at > COALESCE(
     (SELECT to_date FROM conversation_summaries WHERE channel = ? AND sender_id = ? ORDER BY created_at DESC LIMIT 1),
     '2000-01-01'
   )
   ORDER BY id ASC`
);

// --- Messages ---

export function saveMessage(channel: string, senderId: string, senderName: string, role: 'user' | 'assistant', content: string) {
  stmtInsertMsg.run(channel, senderId, senderName, role, content);
}

export function getHistory(channel: string, senderId: string): Array<{ role: string; content: string }> {
  const rows = stmtHistory.all(channel, senderId, CONTEXT_LIMIT) as MessageRow[];
  return rows.reverse().map(r => ({ role: r.role, content: r.content }));
}

export function getMessageCount(channel: string, senderId: string): number {
  const row = stmtMessageCount.get(channel, senderId) as { count: number };
  return row.count;
}

// --- Memories (replaces old facts) ---

export function saveMemory(type: string, category: string | null, content: string, importance: number = 5, source: string = 'user_told'): number {
  const result = stmtInsertMemory.run(type, category, content, Math.min(10, Math.max(1, importance)), source);
  return result.lastInsertRowid as number;
}

// Category detection keywords
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  work_dekel: ['דקל', 'לפרישה', 'פנסי', 'ליד', 'פגישה', 'רואה חשבון', 'monday', 'שכ"ט', 'עמלה', 'פרישה'],
  work_mazpen: ['מצפן', 'לעושר', 'ג׳סי', "ג'סי", 'jesse', 'קורס', 'קהילה', 'wealthy'],
  work_alon_dev: ['alon.dev', 'אתר', 'לקוח', 'פרויקט', 'תכנות', 'קידום'],
  work_aliza: ['עליזה', 'המפרסמת', 'פוסט', 'קמפיין', 'שיווק', 'רשתות'],
  personal: ['משפחה', 'אישה', 'ילד', 'יום הולדת', 'תחביב', 'ספורט', 'בריאות', 'חופשה'],
  finance: ['כסף', 'השקעה', 'חיסכון', 'הוצאה', 'הכנסה', 'בנק', 'משכנתא'],
};

function detectCategory(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) return category;
  }
  return null;
}

export function getRelevantMemories(userMessage: string): Memory[] {
  const seen = new Set<number>();
  const results: Memory[] = [];

  function addUnique(memories: Memory[]) {
    for (const m of memories) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        results.push(m);
      }
    }
  }

  // 1. Always include high-importance memories
  addUnique(stmtHighImportance.all() as Memory[]);

  // 2. Recently accessed memories
  addUnique(stmtRecentlyAccessed.all() as Memory[]);

  // 3. Keyword search from user message
  const words = userMessage.split(/\s+/).filter(w => w.length >= 2);
  for (const word of words.slice(0, 5)) { // limit to 5 keywords
    addUnique(stmtSearchMemories.all(`%${word}%`) as Memory[]);
  }

  // 4. Category-based retrieval
  const detectedCategory = detectCategory(userMessage);
  if (detectedCategory) {
    addUnique(stmtCategoryMemories.all(detectedCategory) as Memory[]);
  }

  // 5. If still few results, add general top memories
  if (results.length < 5) {
    addUnique(stmtAllMemories.all() as Memory[]);
  }

  // Mark retrieved memories as accessed
  for (const m of results) {
    stmtTouchMemory.run(m.id);
  }

  // Cap at 25 memories max
  return results.slice(0, 25);
}

// --- Conversation Summaries ---

export function saveSummary(channel: string, senderId: string, summary: string, topics: string[], messageCount: number, fromDate: string, toDate: string) {
  stmtInsertSummary.run(channel, senderId, summary, JSON.stringify(topics), messageCount, fromDate, toDate);
}

export function getRecentSummaries(channel: string, senderId: string): SummaryRow[] {
  return stmtRecentSummaries.all(channel, senderId) as SummaryRow[];
}

export function getUnsummarizedMessages(channel: string, senderId: string): MessageRow[] {
  return stmtUnsummarizedMessages.all(channel, senderId, channel, senderId) as MessageRow[];
}

export function shouldSummarize(channel: string, senderId: string): boolean {
  const unsummarized = getUnsummarizedMessages(channel, senderId);
  return unsummarized.length >= 40;
}

// --- Backwards compatibility (used by old tool) ---

export function setFact(key: string, value: string) {
  saveMemory('fact', 'personal', `${key}: ${value}`, 5, 'user_told');
}

export function getAllFacts(): Array<{ key: string; value: string }> {
  const memories = stmtAllMemories.all() as Memory[];
  return memories.map(m => ({ key: m.type, value: m.content }));
}

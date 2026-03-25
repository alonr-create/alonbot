import { db } from '../utils/db.js';
import { getEmbedding } from '../utils/embeddings.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('memory');

const CONTEXT_LIMIT = 35; // increased from 20 — better context retention

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

const stmtInsertVector = db.prepare(
  `INSERT INTO memory_vectors (rowid, embedding) VALUES (?, ?)`
);

const stmtDeleteVector = db.prepare(
  `DELETE FROM memory_vectors WHERE rowid = ?`
);

const stmtVectorSearch = db.prepare(`
  SELECT mv.rowid as memory_id, mv.distance, m.*
  FROM memory_vectors mv
  JOIN memories m ON m.id = mv.rowid
  WHERE mv.embedding MATCH ? AND k = ?
  ORDER BY mv.distance
`);

const stmtUnembeddedMemories = db.prepare(
  `SELECT m.* FROM memories m
   WHERE m.id NOT IN (SELECT rowid FROM memory_vectors)
   ORDER BY m.created_at DESC`
);

// --- Messages ---

export function saveMessage(channel: string, senderId: string, senderName: string, role: 'user' | 'assistant', content: string) {
  try {
    stmtInsertMsg.run(channel, senderId, senderName, role, content);
  } catch (e: any) {
    log.error({ err: e.message, channel, senderId, role }, 'saveMessage FAILED');
  }
}

export function getHistory(channel: string, senderId: string): Array<{ role: string; content: string }> {
  const rows = stmtHistory.all(channel, senderId, CONTEXT_LIMIT) as MessageRow[];
  return rows.reverse().map(r => ({ role: r.role, content: r.content }));
}

export function getMessageCount(channel: string, senderId: string): number {
  const row = stmtMessageCount.get(channel, senderId) as { count: number };
  return row.count;
}

// --- Smart Context: pull relevant old messages beyond the context window ---

const stmtOldMessages = db.prepare(
  `SELECT role, content, created_at FROM messages
   WHERE channel = ? AND sender_id = ?
   AND id NOT IN (
     SELECT id FROM messages WHERE channel = ? AND sender_id = ?
     ORDER BY id DESC LIMIT ?
   )
   AND content LIKE ?
   ORDER BY id DESC LIMIT 5`
);

export function getSmartContext(channel: string, senderId: string, userMessage: string): Array<{ role: string; content: string }> {
  const results: Array<{ role: string; content: string }> = [];
  const seen = new Set<string>();

  // Extract meaningful keywords (3+ chars, skip common Hebrew words)
  const stopWords = new Set(['את', 'של', 'על', 'עם', 'זה', 'היא', 'הוא', 'אני', 'לא', 'כן', 'מה', 'איך', 'למה', 'the', 'and', 'for', 'that', 'this']);
  const words = userMessage.split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));

  for (const word of words.slice(0, 3)) {
    try {
      const rows = stmtOldMessages.all(channel, senderId, channel, senderId, CONTEXT_LIMIT, `%${word}%`) as MessageRow[];
      for (const r of rows) {
        const key = `${r.role}:${r.content.slice(0, 50)}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ role: r.role, content: `[הקשר ישן - ${r.created_at}] ${r.content}` });
        }
      }
    } catch (e: any) {
      log.error({ err: e.message }, 'smart context search failed');
    }
  }

  return results.slice(0, 5);
}

// --- Memories (replaces old facts) ---

export function saveMemory(type: string, category: string | null, content: string, importance: number = 5, source: string = 'user_told'): number {
  const result = stmtInsertMemory.run(type, category, content, Math.min(10, Math.max(1, importance)), source);
  const id = result.lastInsertRowid as number;

  // Embed asynchronously (don't block the response)
  embedMemory(id, content).catch(err =>
    log.error({ memoryId: id, err: err.message }, 'failed to embed memory')
  );

  return id;
}

async function embedMemory(memoryId: number, content: string) {
  const embedding = await getEmbedding(content);
  stmtInsertVector.run(BigInt(memoryId), Buffer.from(embedding.buffer));
  log.info({ memoryId, dims: embedding.length }, 'memory embedded');
}

export async function embedUnembeddedMemories() {
  const memories = stmtUnembeddedMemories.all() as Memory[];
  if (memories.length === 0) return;
  log.info({ count: memories.length }, 'found unembedded memories, processing');
  for (const m of memories) {
    await embedMemory(m.id, m.content);
  }
}

// Category detection keywords
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  work_dekel: ['דקל', 'לפרישה', 'פנסי', 'ליד', 'פגישה', 'רואה חשבון', 'monday', 'שכ"ט', 'עמלה', 'פרישה'],
  work_mazpen: ['מצפן', 'לעושר', 'ג׳סי', "ג'סי", 'jesse', 'קורס', 'קהילה', 'wealthy'],
  work_alon_dev: ['alon.dev', 'אתר', 'לקוח', 'פרויקט', 'תכנות', 'קידום'],
  work_aliza: ['עליזה', 'המפרסמת', 'פוסט', 'קמפיין', 'שיווק', 'רשתות'],
  personal: ['משפחה', 'אישה', 'ילד', 'יום הולדת', 'תחביב', 'ספורט', 'בריאות', 'חופשה'],
  finance: ['כסף', 'השקעה', 'חיסכון', 'הוצאה', 'הכנסה', 'בנק', 'משכנתא'],
  feedback: ['תיקון', 'שגיאה', 'טעות', 'זכור', 'לא נכון', 'בטעות', 'אל תעשה', 'correction', 'feedback'],
  rule: ['כלל', 'תמיד', 'אף פעם', 'חוק', 'עקרון', 'חובה', 'אסור', 'iron rule', 'rule'],
};

function detectCategory(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) return category;
  }
  return null;
}

export async function getRelevantMemories(userMessage: string): Promise<Memory[]> {
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
  for (const word of words.slice(0, 5)) {
    addUnique(stmtSearchMemories.all(`%${word.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`) as Memory[]);
  }

  // 4. Vector semantic search (if message is meaningful)
  if (userMessage.length >= 3) {
    try {
      const queryEmbedding = await getEmbedding(userMessage);
      const vectorResults = stmtVectorSearch.all(
        Buffer.from(queryEmbedding.buffer),
        10
      ) as (Memory & { memory_id: number; distance: number })[];
      // Only include results with reasonable similarity (cosine distance < 1.2)
      addUnique(vectorResults.filter(r => r.distance < 1.2));
    } catch (err: any) {
      log.error({ err: err.message }, 'vector search failed');
      // Fall back to keyword-only — don't block on embedding errors
    }
  }

  // 5. Category-based retrieval
  const detectedCategory = detectCategory(userMessage);
  if (detectedCategory) {
    addUnique(stmtCategoryMemories.all(detectedCategory) as Memory[]);
  }

  // 6. If still few results, add general top memories
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

const stmtUnsummarizedCount = db.prepare(
  `SELECT COUNT(*) as count FROM messages
   WHERE channel = ? AND sender_id = ?
   AND created_at > COALESCE(
     (SELECT to_date FROM conversation_summaries WHERE channel = ? AND sender_id = ? ORDER BY created_at DESC LIMIT 1),
     '2000-01-01'
   )`
);

export function shouldSummarize(channel: string, senderId: string): boolean {
  const row = stmtUnsummarizedCount.get(channel, senderId, channel, senderId) as { count: number };
  return row.count >= 40;
}

// --- Memory Maintenance (Phase 3) ---

const stmtDecayMemories = db.prepare(
  `UPDATE memories
   SET importance = MAX(1, importance - 1)
   WHERE importance > 1
     AND importance < 8
     AND (last_accessed IS NULL OR last_accessed < datetime('now', '-60 days'))
     AND created_at < datetime('now', '-60 days')
     AND type NOT IN ('feedback', 'rule')`
);

const stmtOldEpisodicMemories = db.prepare(
  `SELECT * FROM memories
   WHERE type = 'event'
     AND created_at < datetime('now', '-30 days')
     AND importance < 7
   ORDER BY created_at ASC`
);

const stmtDeleteMemory = db.prepare(`DELETE FROM memories WHERE id = ?`);

const stmtDuplicateCheck = db.prepare(
  `SELECT id, content FROM memories WHERE content LIKE ? AND id != ? LIMIT 5`
);

export async function runMemoryMaintenance(): Promise<{ decayed: number; consolidated: number; deleted: number }> {
  // 1. Decay: reduce importance of untouched memories (60+ days)
  const decayResult = stmtDecayMemories.run();
  const decayed = decayResult.changes;
  if (decayed > 0) log.info({ decayed }, 'decayed old memories');

  // 2. Delete old low-importance events (30+ days, importance < 3)
  const oldEvents = stmtOldEpisodicMemories.all() as Memory[];
  let deleted = 0;
  for (const m of oldEvents) {
    if (m.importance <= 2 && m.access_count === 0) {
      stmtDeleteMemory.run(m.id);
      stmtDeleteVector.run(BigInt(m.id));
      deleted++;
    }
  }
  if (deleted > 0) log.info({ deleted }, 'deleted stale events');

  // 3. Consolidate: merge near-duplicate memories using text similarity + vector similarity
  let consolidated = 0;
  const allMemories = stmtAllMemories.all() as Memory[];
  const deletedIds = new Set<number>();

  for (const m of allMemories) {
    if (deletedIds.has(m.id)) continue;

    // Strategy A: text prefix match (fast, catches exact-ish duplicates)
    const keyPhrase = m.content.slice(0, 30);
    if (keyPhrase.length >= 10) {
      const dupes = stmtDuplicateCheck.all(`%${keyPhrase}%`, m.id) as Memory[];
      for (const dupe of dupes) {
        if (deletedIds.has(dupe.id)) continue;
        const lenRatio = Math.min(m.content.length, dupe.content.length) / Math.max(m.content.length, dupe.content.length);
        if (lenRatio > 0.5 && dupe.importance <= m.importance) {
          stmtDeleteMemory.run(dupe.id);
          stmtDeleteVector.run(BigInt(dupe.id));
          deletedIds.add(dupe.id);
          consolidated++;
        }
      }
    }

    // Strategy B: vector similarity (catches semantic duplicates)
    try {
      const embedding = await getEmbedding(m.content);
      const similar = stmtVectorSearch.all(Buffer.from(embedding.buffer), 5) as (Memory & { memory_id: number; distance: number })[];
      for (const sim of similar) {
        if (sim.id === m.id || deletedIds.has(sim.id)) continue;
        // Very close semantic match (distance < 0.3 = nearly identical meaning)
        if (sim.distance < 0.3 && sim.importance <= m.importance) {
          stmtDeleteMemory.run(sim.id);
          stmtDeleteVector.run(BigInt(sim.id));
          deletedIds.add(sim.id);
          consolidated++;
          log.info({ kept: m.id, removed: sim.id, distance: sim.distance }, 'semantic dedup');
        }
      }
    } catch {
      // Vector search failed — skip semantic dedup for this memory
    }
  }
  if (consolidated > 0) log.info({ consolidated }, 'consolidated duplicate memories');

  return { decayed, consolidated, deleted };
}

// --- Document Indexing to Memory ---

export function indexDocumentToMemory(content: string, source: string, docType: 'pdf' | 'image' | 'text' = 'text'): number[] {
  const ids: number[] = [];
  const maxChunkSize = 500;

  // Split content into chunks
  const chunks = [];
  if (content.length <= maxChunkSize) {
    chunks.push(content);
  } else {
    // Split by paragraphs first, then by size
    const paragraphs = content.split(/\n\n+/);
    let current = '';
    for (const p of paragraphs) {
      if ((current + '\n\n' + p).length > maxChunkSize && current) {
        chunks.push(current.trim());
        current = p;
      } else {
        current = current ? current + '\n\n' + p : p;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }

  for (const chunk of chunks) {
    if (chunk.length < 10) continue; // skip tiny chunks
    const id = saveMemory(
      'document',
      detectCategory(chunk),
      `[${docType}:${source}] ${chunk}`,
      4, // medium importance — can be boosted later
      `document_${docType}`
    );
    ids.push(id);
  }

  log.info({ source, docType, chunks: ids.length }, 'indexed document to memory');
  return ids;
}

// --- Entity Extraction ---

const stmtUpsertEntity = db.prepare(
  `INSERT INTO entities (subject, predicate, object, confidence, source)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(subject, predicate, object) DO UPDATE SET
     confidence = MAX(entities.confidence, excluded.confidence),
     updated_at = datetime('now')`
);

const stmtGetEntities = db.prepare(
  `SELECT * FROM entities WHERE subject = ? ORDER BY confidence DESC, updated_at DESC LIMIT 30`
);

const stmtSearchEntities = db.prepare(
  `SELECT * FROM entities WHERE subject LIKE ? OR object LIKE ? ORDER BY confidence DESC LIMIT 20`
);

const stmtDeleteEntity = db.prepare(
  `DELETE FROM entities WHERE id = ?`
);

const stmtDeleteEntityByContent = db.prepare(
  `DELETE FROM entities WHERE object LIKE ?`
);

// Hebrew entity extraction patterns
const ENTITY_PATTERNS: Array<{ regex: RegExp; subject: string; predicate: string; objectGroup: number }> = [
  // "אני אוהב X" / "אני שונא X"
  { regex: /אני (?:אוהב|מעדיף|חושב ש|רוצה|צריך|לא אוהב|שונא)\s+(.+)/i, subject: 'אלון', predicate: 'preference', objectGroup: 1 },
  // "השם שלי X" / "קוראים לי X"
  { regex: /(?:קוראים לי|השם שלי|אני)\s+([א-ת]{2,}(?:\s+[א-ת]{2,})?)/i, subject: 'אלון', predicate: 'name', objectGroup: 1 },
  // "יש לי X" (possession)
  { regex: /יש לי\s+(.+)/i, subject: 'אלון', predicate: 'has', objectGroup: 1 },
  // "אני גר ב-X" / "אני מ-X"
  { regex: /אני (?:גר|מ|נמצא)\s*(?:ב|מ)\s*(.+)/i, subject: 'אלון', predicate: 'location', objectGroup: 1 },
  // "X הוא/היא Y" (definitions)
  { regex: /([א-ת\w]{2,}(?:\s+[א-ת\w]{2,})?)\s+(?:הוא|היא|זה)\s+(.+)/i, subject: 'אלון', predicate: 'knows', objectGroup: 0 },
  // "הבן/הבת/האישה שלי X"
  { regex: /(?:הבן|הבת|האישה|הבעל|האמא|האבא|האח|האחות)\s+שלי\s+(?:שם\w*\s+)?([א-ת]{2,})/i, subject: 'אלון', predicate: 'family', objectGroup: 0 },
  // "אני עובד ב-X" / "אני X (profession)"
  { regex: /אני (?:עובד|עובדת)\s+(?:ב|כ)\s*(.+)/i, subject: 'אלון', predicate: 'work', objectGroup: 1 },
  // "יום ההולדת שלי ב-X"
  { regex: /יום (?:ה)?הולדת\s+(?:שלי\s+)?(?:ב|הוא\s+)?(.+)/i, subject: 'אלון', predicate: 'birthday', objectGroup: 1 },
];

export function extractEntities(text: string, source: string = 'conversation'): Array<{ subject: string; predicate: string; object: string }> {
  const extracted: Array<{ subject: string; predicate: string; object: string }> = [];

  for (const pattern of ENTITY_PATTERNS) {
    const match = text.match(pattern.regex);
    if (match) {
      const obj = pattern.objectGroup === 0
        ? match[0] // full match
        : match[pattern.objectGroup]?.trim();
      if (obj && obj.length >= 2 && obj.length <= 100) {
        const entity = { subject: pattern.subject, predicate: pattern.predicate, object: obj };
        extracted.push(entity);
        try {
          stmtUpsertEntity.run(entity.subject, entity.predicate, entity.object, 0.7, source);
          log.info({ entity }, 'extracted entity');
        } catch (e: any) {
          log.debug({ err: e.message }, 'entity upsert failed');
        }
      }
    }
  }

  return extracted;
}

export function getEntities(subject: string): Array<{ id: number; subject: string; predicate: string; object: string; confidence: number }> {
  return stmtGetEntities.all(subject) as any[];
}

export function searchEntities(query: string): Array<{ id: number; subject: string; predicate: string; object: string; confidence: number }> {
  return stmtSearchEntities.all(`%${query}%`, `%${query}%`) as any[];
}

export function deleteEntity(id: number) {
  stmtDeleteEntity.run(id);
}

export function forgetEntityByContent(content: string): number {
  const result = stmtDeleteEntityByContent.run(`%${content}%`);
  return result.changes;
}

// --- Backwards compatibility (used by old tool) ---

export function setFact(key: string, value: string) {
  saveMemory('fact', 'personal', `${key}: ${value}`, 5, 'user_told');
}

export function getAllFacts(): Array<{ key: string; value: string }> {
  const memories = stmtAllMemories.all() as Memory[];
  return memories.map(m => ({ key: m.type, value: m.content }));
}

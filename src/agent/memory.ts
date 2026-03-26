import { db } from '../utils/db.js';
import { getEmbedding } from '../utils/embeddings.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('memory');

// Cold start gate: vector search is skipped until initial embedding pass completes
let embeddingsReady = false;

export function isEmbeddingsReady(): boolean {
  return embeddingsReady;
}

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
  if (memories.length === 0) {
    embeddingsReady = true;
    log.info('embeddings ready (no unembedded memories)');
    return;
  }
  log.info({ count: memories.length }, 'found unembedded memories, processing');
  for (const m of memories) {
    await embedMemory(m.id, m.content);
  }
  embeddingsReady = true;
  log.info('embeddings ready (all memories embedded)');
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

  // 4. Vector semantic search (if message is meaningful and embeddings are ready)
  if (userMessage.length >= 3) {
    if (!embeddingsReady) {
      log.info('embeddings not ready yet, skipping vector search');
    } else {
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

  // 4. Auto-boost frequently accessed memories
  const boosted = autoBoostMemories();
  if (boosted > 0) log.info({ boosted }, 'auto-boosted frequently accessed memories');

  // 5. Expire old commitments (14+ days)
  const expired = expireOldCommitments();
  if (expired > 0) log.info({ expired }, 'expired old commitments');

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

// --- Auto-Correction Detection ---
// Detects when user corrects the bot and auto-saves as high-importance feedback

const CORRECTION_PATTERNS: Array<{ regex: RegExp; extract: (match: RegExpMatchArray) => string }> = [
  { regex: /(?:לא[,.]?\s+)?(?:טעית|טעות|שגיאה|לא נכון|לא מדויק|זה לא נכון)/i, extract: (m) => m.input?.trim() || '' },
  { regex: /(?:לא ככה|לא כך|אל תעשה ככה|לא ככה צריך)/i, extract: (m) => m.input?.trim() || '' },
  { regex: /(?:אמרתי|התכוונתי)\s+(.+?)(?:\s+לא\s+(.+))?$/i, extract: (m) => m.input?.trim() || '' },
  { regex: /(?:תתקן|תשנה|תעדכן)\s*[—–-]?\s*(.+)/i, extract: (m) => m[1]?.trim() || m.input?.trim() || '' },
  { regex: /(?:לא!+|לא לא|ממש לא|בשום פנים)/i, extract: (m) => m.input?.trim() || '' },
  { regex: /(?:wrong|incorrect|no that's not|fix that|not what I)/i, extract: (m) => m.input?.trim() || '' },
  { regex: /(?:אסור|חובה|תמיד תעשה|אף פעם אל)\s+(.+)/i, extract: (m) => m.input?.trim() || '' },
];

export function detectCorrection(userMessage: string, botPreviousMessage?: string): { isCorrection: boolean; content: string } | null {
  for (const pattern of CORRECTION_PATTERNS) {
    const match = userMessage.match(pattern.regex);
    if (match) {
      const content = pattern.extract(match);
      if (content.length >= 5 && content.length <= 300) {
        return { isCorrection: true, content };
      }
    }
  }
  return null;
}

export function autoSaveCorrection(userMessage: string, channel: string, senderId: string): number | null {
  const correction = detectCorrection(userMessage);
  if (!correction) return null;

  // Check if similar correction already exists
  const existing = stmtSearchMemories.all(`%${correction.content.slice(0, 30)}%`) as Memory[];
  if (existing.some(m => m.type === 'feedback' && m.content.includes(correction.content.slice(0, 20)))) {
    return null; // Already saved
  }

  const id = saveMemory(
    'feedback',
    'feedback',
    `תיקון מהמשתמש: ${correction.content}`,
    9, // High importance — corrections are critical
    `auto_correction:${channel}:${senderId}`
  );
  log.info({ id, content: correction.content.slice(0, 50) }, 'auto-saved correction as feedback');
  return id;
}

// --- Memory Importance Auto-Boost ---
// Memories accessed frequently get importance boost

const stmtFrequentlyAccessed = db.prepare(
  `SELECT * FROM memories
   WHERE access_count >= 5
     AND importance < 8
     AND type NOT IN ('event')
   ORDER BY access_count DESC LIMIT 20`
);

const stmtBoostImportance = db.prepare(
  `UPDATE memories SET importance = MIN(8, importance + 1) WHERE id = ?`
);

export function autoBoostMemories(): number {
  const frequent = stmtFrequentlyAccessed.all() as Memory[];
  let boosted = 0;
  for (const m of frequent) {
    // Boost by 1 for every 5 accesses beyond threshold
    const shouldBoost = m.access_count >= 5 && m.importance < 8;
    if (shouldBoost) {
      stmtBoostImportance.run(m.id);
      boosted++;
      log.info({ id: m.id, oldImportance: m.importance, accessCount: m.access_count }, 'auto-boosted memory');
    }
  }
  return boosted;
}

// --- Mood/Sentiment Tracking ---

const SENTIMENT_PATTERNS: Array<{ regex: RegExp; sentiment: 'positive' | 'negative' | 'frustrated'; score: number }> = [
  // Frustrated
  { regex: /(?:מתסכל|מעצבן|לא עובד|נמאס|עוד פעם|שוב|מספיק|wtf|omg)/i, sentiment: 'frustrated', score: -0.8 },
  { regex: /(?:!!!+|!!\?|מה זה|למה זה)/i, sentiment: 'frustrated', score: -0.5 },
  // Negative
  { regex: /(?:עצוב|מאוכזב|לא טוב|גרוע|בעיה|נכשל|קשה|מלחיץ)/i, sentiment: 'negative', score: -0.6 },
  { regex: /(?:sad|bad|terrible|awful|frustrated|annoyed)/i, sentiment: 'negative', score: -0.6 },
  // Positive
  { regex: /(?:מעולה|אחלה|מדהים|פצצה|תותח|יופי|נהדר|סבבה|שיא|וואו|wow)/i, sentiment: 'positive', score: 0.8 },
  { regex: /(?:תודה|תנקס|thanks|awesome|great|perfect|love it|amazing)/i, sentiment: 'positive', score: 0.7 },
  { regex: /(?:😊|😄|🎉|👍|❤️|🔥|💪|👏)/i, sentiment: 'positive', score: 0.5 },
  { regex: /(?:😤|😡|😠|💀|🤦)/i, sentiment: 'frustrated', score: -0.6 },
];

const stmtInsertSentiment = db.prepare(
  `INSERT INTO sentiment_log (channel, sender_id, sentiment, score, trigger_text) VALUES (?, ?, ?, ?, ?)`
);

const stmtRecentSentiment = db.prepare(
  `SELECT sentiment, score, created_at FROM sentiment_log
   WHERE channel = ? AND sender_id = ?
   ORDER BY created_at DESC LIMIT 10`
);

const stmtSentimentTrend = db.prepare(
  `SELECT
     AVG(score) as avg_score,
     COUNT(*) as count,
     SUM(CASE WHEN sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
     SUM(CASE WHEN sentiment = 'negative' THEN 1 ELSE 0 END) as negative,
     SUM(CASE WHEN sentiment = 'frustrated' THEN 1 ELSE 0 END) as frustrated
   FROM sentiment_log
   WHERE channel = ? AND sender_id = ?
     AND created_at >= datetime('now', '-7 days')`
);

export function trackSentiment(channel: string, senderId: string, message: string): { sentiment: string; score: number } | null {
  for (const pattern of SENTIMENT_PATTERNS) {
    if (pattern.regex.test(message)) {
      try {
        stmtInsertSentiment.run(channel, senderId, pattern.sentiment, pattern.score, message.slice(0, 100));
      } catch (e: any) {
        log.debug({ err: e.message }, 'sentiment insert failed');
      }
      return { sentiment: pattern.sentiment, score: pattern.score };
    }
  }
  // Default: neutral (don't log every message, only notable ones)
  return null;
}

export function getSentimentTrend(channel: string, senderId: string): { mood: string; avgScore: number; details: string } {
  const trend = stmtSentimentTrend.get(channel, senderId) as any;
  if (!trend || trend.count === 0) {
    return { mood: 'neutral', avgScore: 0, details: 'אין מספיק נתונים' };
  }

  const avg = trend.avg_score;
  let mood: string;
  if (avg > 0.3) mood = 'positive';
  else if (avg < -0.5) mood = 'frustrated';
  else if (avg < -0.2) mood = 'negative';
  else mood = 'neutral';

  const details = `שבוע אחרון: ${trend.positive} חיוביים, ${trend.negative} שליליים, ${trend.frustrated} מתוסכלים (ממוצע: ${avg.toFixed(2)})`;
  return { mood, avgScore: avg, details };
}

export function getRecentMood(channel: string, senderId: string): string | null {
  const recent = stmtRecentSentiment.all(channel, senderId) as Array<{ sentiment: string; score: number; created_at: string }>;
  if (recent.length < 2) return null;

  // Check last 3 messages for frustration pattern
  const last3 = recent.slice(0, 3);
  const frustrationCount = last3.filter(s => s.sentiment === 'frustrated' || s.sentiment === 'negative').length;
  if (frustrationCount >= 2) return 'frustrated';

  const positiveCount = last3.filter(s => s.sentiment === 'positive').length;
  if (positiveCount >= 2) return 'happy';

  return null;
}

// --- Conversation Topic Tagging ---

const TOPIC_KEYWORDS: Record<string, string[]> = {
  'לידים ומכירות': ['ליד', 'לידים', 'מכירה', 'מכירות', 'קמפיין', 'פרסום', 'leads', 'campaign'],
  'פגישות ויומן': ['פגישה', 'פגישות', 'יומן', 'זום', 'calendar', 'meeting', 'zoom'],
  'פיתוח ותכנות': ['קוד', 'באג', 'פיתוח', 'אתר', 'deploy', 'code', 'bug', 'website', 'build'],
  'דקל לפרישה': ['דקל', 'פנסיה', 'פרישה', 'ייעוץ פנסיוני', 'monday'],
  'כספים': ['כסף', 'הכנסה', 'הוצאה', 'עלות', 'תקציב', 'חשבון', 'תשלום', 'money', 'budget'],
  'אישי': ['משפחה', 'בריאות', 'חופש', 'יום הולדת', 'אישה', 'ילד', 'בן', 'בת'],
  'AI וטכנולוגיה': ['claude', 'gemini', 'gpt', 'בוט', 'אוטומציה', 'ai', 'bot', 'automation'],
  'תוכן ושיווק': ['פוסט', 'סרטון', 'וידאו', 'תוכן', 'שיווק', 'content', 'marketing', 'video'],
  'וואטסאפ': ['וואטסאפ', 'whatsapp', 'הודעה', 'שידור', 'broadcast'],
  'טלגרם': ['טלגרם', 'telegram', 'ערוץ', 'channel'],
};

const stmtUpsertTopic = db.prepare(
  `INSERT INTO conversation_topics (channel, sender_id, topic, first_mentioned, last_mentioned, mention_count)
   VALUES (?, ?, ?, datetime('now'), datetime('now'), 1)
   ON CONFLICT(channel, sender_id, topic) DO UPDATE SET
     last_mentioned = datetime('now'),
     mention_count = mention_count + 1`
);

const stmtRecentTopics = db.prepare(
  `SELECT topic, mention_count, last_mentioned FROM conversation_topics
   WHERE channel = ? AND sender_id = ?
   ORDER BY last_mentioned DESC LIMIT 10`
);

const stmtTopicHistory = db.prepare(
  `SELECT topic, first_mentioned, last_mentioned, mention_count FROM conversation_topics
   WHERE channel = ? AND sender_id = ? AND topic LIKE ?
   ORDER BY last_mentioned DESC LIMIT 5`
);

export function tagConversationTopics(channel: string, senderId: string, message: string): string[] {
  const detected: string[] = [];
  const lower = message.toLowerCase();

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      detected.push(topic);
      try {
        stmtUpsertTopic.run(channel, senderId, topic);
      } catch (e: any) {
        log.debug({ err: e.message }, 'topic upsert failed');
      }
    }
  }

  return detected;
}

export function getRecentTopics(channel: string, senderId: string): Array<{ topic: string; count: number; lastMentioned: string }> {
  const rows = stmtRecentTopics.all(channel, senderId) as Array<{ topic: string; mention_count: number; last_mentioned: string }>;
  return rows.map(r => ({ topic: r.topic, count: r.mention_count, lastMentioned: r.last_mentioned }));
}

// --- Memory Timeline & "Last Time" ---

const stmtTimelineSearch = db.prepare(
  `SELECT content, created_at, type, category, importance FROM memories
   WHERE content LIKE ?
   ORDER BY created_at DESC LIMIT 10`
);

const stmtMessageTimelineSearch = db.prepare(
  `SELECT role, content, created_at FROM messages
   WHERE channel = ? AND sender_id = ?
     AND content LIKE ?
   ORDER BY created_at DESC LIMIT 10`
);

export function getMemoryTimeline(query: string, channel?: string, senderId?: string): Array<{ source: string; content: string; date: string; type?: string }> {
  const results: Array<{ source: string; content: string; date: string; type?: string }> = [];
  const searchTerm = `%${query}%`;

  // Search memories
  const memories = stmtTimelineSearch.all(searchTerm) as Array<{ content: string; created_at: string; type: string; category: string; importance: number }>;
  for (const m of memories) {
    results.push({ source: 'memory', content: m.content, date: m.created_at, type: m.type });
  }

  // Search messages
  if (channel && senderId) {
    const messages = stmtMessageTimelineSearch.all(channel, senderId, searchTerm) as Array<{ role: string; content: string; created_at: string }>;
    for (const msg of messages) {
      results.push({ source: msg.role === 'user' ? 'you_said' : 'bot_said', content: msg.content.slice(0, 200), date: msg.created_at });
    }

    // Search topics
    const topics = stmtTopicHistory.all(channel, senderId, searchTerm) as Array<{ topic: string; first_mentioned: string; last_mentioned: string; mention_count: number }>;
    for (const t of topics) {
      results.push({ source: 'topic', content: `נושא "${t.topic}" — ${t.mention_count} פעמים, ראשון: ${t.first_mentioned}`, date: t.last_mentioned });
    }
  }

  // Sort by date descending
  results.sort((a, b) => b.date.localeCompare(a.date));
  return results.slice(0, 15);
}

export function getLastTimeTalkedAbout(query: string, channel: string, senderId: string): string {
  const timeline = getMemoryTimeline(query, channel, senderId);
  if (timeline.length === 0) {
    return `לא מצאתי שום דבר על "${query}" בזיכרון או בהיסטוריה.`;
  }

  const first = timeline[0];
  const daysDiff = Math.floor((Date.now() - new Date(first.date).getTime()) / (1000 * 60 * 60 * 24));
  const timeAgo = daysDiff === 0 ? 'היום' : daysDiff === 1 ? 'אתמול' : `לפני ${daysDiff} ימים`;

  let result = `דיברנו על "${query}" לאחרונה ${timeAgo} (${first.date}).\n`;
  result += `נמצאו ${timeline.length} התייחסויות:\n`;
  for (const item of timeline.slice(0, 5)) {
    const label = item.source === 'you_said' ? '👤 אתה' : item.source === 'bot_said' ? '🤖 אני' : item.source === 'memory' ? '🧠 זיכרון' : '🏷️ נושא';
    result += `- ${label} (${item.date}): ${item.content.slice(0, 100)}\n`;
  }
  return result;
}

// --- Proactive Context Bridge ---
// At start of conversation, check what was discussed last time

const stmtLastMessageTime = db.prepare(
  `SELECT created_at FROM messages WHERE channel = ? AND sender_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1 OFFSET 1`
);

const stmtLastTopics = db.prepare(
  `SELECT topic, mention_count FROM conversation_topics
   WHERE channel = ? AND sender_id = ?
   ORDER BY last_mentioned DESC LIMIT 3`
);

const stmtLastSummary = db.prepare(
  `SELECT summary, to_date FROM conversation_summaries
   WHERE channel = ? AND sender_id = ?
   ORDER BY created_at DESC LIMIT 1`
);

const stmtPendingCommitments = db.prepare(
  `SELECT content, due_hint, created_at FROM commitments
   WHERE channel = ? AND sender_id = ? AND status = 'pending'
   ORDER BY created_at DESC LIMIT 5`
);

export function getContextBridge(channel: string, senderId: string): string | null {
  try {
    // Check time since last message
    const lastMsg = stmtLastMessageTime.get(channel, senderId) as { created_at: string } | undefined;
    if (!lastMsg) return null;

    const lastTime = new Date(lastMsg.created_at + 'Z');
    const hoursSince = (Date.now() - lastTime.getTime()) / (1000 * 60 * 60);

    // Only bridge if 4+ hours since last conversation
    if (hoursSince < 4) return null;

    const parts: string[] = [];

    // Recent topics
    const topics = stmtLastTopics.all(channel, senderId) as Array<{ topic: string; mention_count: number }>;
    if (topics.length > 0) {
      parts.push(`נושאים אחרונים: ${topics.map(t => t.topic).join(', ')}`);
    }

    // Last summary
    const summary = stmtLastSummary.get(channel, senderId) as { summary: string; to_date: string } | undefined;
    if (summary) {
      parts.push(`סיכום אחרון (${summary.to_date}): ${summary.summary.slice(0, 200)}`);
    }

    // Pending commitments
    const commitments = stmtPendingCommitments.all(channel, senderId) as Array<{ content: string; due_hint: string | null; created_at: string }>;
    if (commitments.length > 0) {
      parts.push(`התחייבויות פתוחות: ${commitments.map(c => c.content + (c.due_hint ? ` (${c.due_hint})` : '')).join('; ')}`);
    }

    if (parts.length === 0) return null;

    const hoursLabel = hoursSince < 24 ? `${Math.round(hoursSince)} שעות` : `${Math.round(hoursSince / 24)} ימים`;
    return `[הקשר מהשיחה האחרונה — לפני ${hoursLabel}]\n${parts.join('\n')}`;
  } catch (e: any) {
    log.debug({ err: e.message }, 'context bridge failed');
    return null;
  }
}

// --- Promise/Commitment Tracker ---

const COMMITMENT_PATTERNS: Array<{ regex: RegExp; dueExtract?: (match: RegExpMatchArray) => string | null }> = [
  { regex: /(?:אני צריך|צריך|חייב|חייבת)\s+(?:ל)?(.{5,80})/i, dueExtract: undefined },
  { regex: /(?:מחר\s+(?:אני\s+)?(?:צריך|חייב|אעשה|אטפל))\s+(.{3,80})/i, dueExtract: () => 'מחר' },
  { regex: /(?:בשבוע הבא)\s+(.{3,80})/i, dueExtract: () => 'שבוע הבא' },
  { regex: /(?:אל תשכח|תזכיר לי)\s+(?:ש|ל)?(.{5,80})/i, dueExtract: undefined },
  { regex: /(?:אני אעשה|אטפל ב|אסיים את)\s+(.{3,80})/i, dueExtract: undefined },
  { regex: /(?:עד )((?:יום\s+)?(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת))\s+(.{3,60})/i, dueExtract: (m) => m[1] || null },
];

const stmtInsertCommitment = db.prepare(
  `INSERT INTO commitments (channel, sender_id, content, due_hint) VALUES (?, ?, ?, ?)`
);

const stmtResolveCommitment = db.prepare(
  `UPDATE commitments SET status = 'done', resolved_at = datetime('now') WHERE id = ?`
);

const stmtSearchCommitments = db.prepare(
  `SELECT * FROM commitments WHERE channel = ? AND sender_id = ? AND status = 'pending' AND content LIKE ? LIMIT 5`
);

const stmtAllPendingCommitments = db.prepare(
  `SELECT * FROM commitments WHERE channel = ? AND sender_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 15`
);

const stmtExpireOldCommitments = db.prepare(
  `UPDATE commitments SET status = 'expired' WHERE status = 'pending' AND created_at < datetime('now', '-14 days')`
);

export function extractCommitments(text: string, channel: string, senderId: string): Array<{ content: string; due: string | null }> {
  const extracted: Array<{ content: string; due: string | null }> = [];

  for (const pattern of COMMITMENT_PATTERNS) {
    const match = text.match(pattern.regex);
    if (match) {
      const content = match[1]?.trim() || match[0]?.trim();
      if (content && content.length >= 5 && content.length <= 100) {
        const due = pattern.dueExtract ? pattern.dueExtract(match) : null;

        // Check for duplicate
        const existing = stmtSearchCommitments.all(channel, senderId, `%${content.slice(0, 20)}%`) as any[];
        if (existing.length === 0) {
          try {
            stmtInsertCommitment.run(channel, senderId, content, due);
            extracted.push({ content, due });
            log.info({ content: content.slice(0, 50), due }, 'extracted commitment');
          } catch (e: any) {
            log.debug({ err: e.message }, 'commitment insert failed');
          }
        }
      }
    }
  }

  return extracted;
}

export function getPendingCommitments(channel: string, senderId: string): Array<{ id: number; content: string; due_hint: string | null; created_at: string }> {
  return stmtAllPendingCommitments.all(channel, senderId) as any[];
}

export function resolveCommitment(id: number) {
  stmtResolveCommitment.run(id);
}

export function expireOldCommitments(): number {
  const result = stmtExpireOldCommitments.run();
  return result.changes;
}

// --- Relationship Graph ---

const RELATIONSHIP_PATTERNS: Array<{ regex: RegExp; extractPerson: number; extractRole: (match: RegExpMatchArray) => string }> = [
  // "רמי הוא רואה החשבון שלי"
  { regex: /([א-ת]{2,}(?:\s+[א-ת]{2,})?)\s+(?:הוא|היא)\s+(?:ה)?(.{2,30})\s+שלי/i, extractPerson: 1, extractRole: (m) => m[2] },
  // "רואה החשבון שלי הוא רמי"
  { regex: /(?:ה)?(.{2,30})\s+שלי\s+(?:הוא|היא|זה)\s+([א-ת]{2,}(?:\s+[א-ת]{2,})?)/i, extractPerson: 2, extractRole: (m) => m[1] },
  // "הבן/הבת/האישה שלי X"
  { regex: /(הבן|הבת|האישה|הבעל|האמא|האבא|האח|האחות|השותף|השותפה)\s+שלי\s+(?:(?:הוא|היא|שמ\w*)\s+)?([א-ת]{2,}(?:\s+[א-ת]{2,})?)/i, extractPerson: 2, extractRole: (m) => m[1].replace(/^ה/, '') },
  // "X השותף/העובד שלי"
  { regex: /([א-ת]{2,}(?:\s+[א-ת]{2,})?)\s+(השותף|העובד|העובדת|המנהל|המנהלת|הלקוח|המזכירה)\s+שלי/i, extractPerson: 1, extractRole: (m) => m[2].replace(/^ה/, '') },
  // "אני עובד עם X"
  { regex: /אני עובד(?:ת)?\s+עם\s+([א-ת]{2,}(?:\s+[א-ת]{2,})?)/i, extractPerson: 1, extractRole: () => 'עמית' },
];

const stmtUpsertRelationship = db.prepare(
  `INSERT INTO relationships (person_name, role, context, confidence)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(person_name, role) DO UPDATE SET
     context = COALESCE(excluded.context, relationships.context),
     confidence = MAX(relationships.confidence, excluded.confidence),
     updated_at = datetime('now')`
);

const stmtGetRelationships = db.prepare(
  `SELECT * FROM relationships ORDER BY confidence DESC, updated_at DESC LIMIT 30`
);

const stmtSearchRelationships = db.prepare(
  `SELECT * FROM relationships WHERE person_name LIKE ? OR role LIKE ? ORDER BY confidence DESC LIMIT 10`
);

export function extractRelationships(text: string, source: string = 'conversation'): Array<{ person: string; role: string }> {
  const extracted: Array<{ person: string; role: string }> = [];

  for (const pattern of RELATIONSHIP_PATTERNS) {
    const match = text.match(pattern.regex);
    if (match) {
      const person = match[pattern.extractPerson]?.trim();
      const role = pattern.extractRole(match)?.trim();
      if (person && role && person.length >= 2 && person.length <= 30 && role.length >= 2) {
        try {
          stmtUpsertRelationship.run(person, role, source, 0.7);
          extracted.push({ person, role });
          log.info({ person, role }, 'extracted relationship');
        } catch (e: any) {
          log.debug({ err: e.message }, 'relationship upsert failed');
        }
      }
    }
  }

  return extracted;
}

export function getAllRelationships(): Array<{ id: number; person_name: string; role: string; context: string | null; confidence: number }> {
  return stmtGetRelationships.all() as any[];
}

export function searchRelationship(query: string): Array<{ person_name: string; role: string; confidence: number }> {
  return stmtSearchRelationships.all(`%${query}%`, `%${query}%`) as any[];
}

// --- Memory Conflict Detection ---

export async function detectMemoryConflict(newContent: string): Promise<{ hasConflict: boolean; conflicting?: Memory; explanation?: string } | null> {
  try {
    // Search for semantically similar memories
    const embedding = await getEmbedding(newContent);
    const similar = stmtVectorSearch.all(Buffer.from(embedding.buffer), 5) as (Memory & { distance: number })[];

    for (const existing of similar) {
      // Only check close matches (but not identical — those are duplicates, not conflicts)
      if (existing.distance > 0.15 && existing.distance < 0.6) {
        // Check for contradiction signals
        const newLower = newContent.toLowerCase();
        const existingLower = existing.content.toLowerCase();

        // Number contradiction: same context but different numbers
        const newNumbers: string[] = newLower.match(/\d+/g) || [];
        const existingNumbers: string[] = existingLower.match(/\d+/g) || [];
        if (newNumbers.length > 0 && existingNumbers.length > 0) {
          const hasConflict = newNumbers.some(n => !existingNumbers.includes(n)) &&
                             existingNumbers.some(n => !newNumbers.includes(n));
          if (hasConflict) {
            return {
              hasConflict: true,
              conflicting: existing,
              explanation: `מספרים שונים: חדש=${newNumbers.join(',')} vs ישן=${existingNumbers.join(',')}`
            };
          }
        }

        // Negation contradiction: "אוהב" vs "לא אוהב", "רוצה" vs "לא רוצה"
        const negationPairs = [
          ['אוהב', 'לא אוהב'], ['רוצה', 'לא רוצה'], ['צריך', 'לא צריך'],
          ['אפשר', 'אי אפשר'], ['כן', 'לא'], ['טוב', 'לא טוב'], ['גר ב', 'עבר ל'],
        ];
        for (const [pos, neg] of negationPairs) {
          if ((newLower.includes(neg) && existingLower.includes(pos) && !existingLower.includes(neg)) ||
              (newLower.includes(pos) && !newLower.includes(neg) && existingLower.includes(neg))) {
            return {
              hasConflict: true,
              conflicting: existing,
              explanation: `סתירה: "${pos}" מול "${neg}"`
            };
          }
        }
      }
    }
  } catch (e: any) {
    log.debug({ err: e.message }, 'conflict detection failed');
  }
  return null;
}

// --- Weekly Memory Digest ---

const stmtMemoriesThisWeek = db.prepare(
  `SELECT COUNT(*) as count, type FROM memories
   WHERE created_at >= datetime('now', '-7 days')
   GROUP BY type`
);

const stmtTopTopicsThisWeek = db.prepare(
  `SELECT topic, SUM(mention_count) as total FROM conversation_topics
   WHERE last_mentioned >= datetime('now', '-7 days')
   GROUP BY topic ORDER BY total DESC LIMIT 5`
);

const stmtSentimentThisWeek = db.prepare(
  `SELECT
     AVG(score) as avg_score,
     COUNT(*) as total,
     SUM(CASE WHEN sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
     SUM(CASE WHEN sentiment = 'negative' THEN 1 ELSE 0 END) as negative,
     SUM(CASE WHEN sentiment = 'frustrated' THEN 1 ELSE 0 END) as frustrated
   FROM sentiment_log
   WHERE created_at >= datetime('now', '-7 days')`
);

const stmtTotalMemories = db.prepare(`SELECT COUNT(*) as count FROM memories`);
const stmtTotalEntities = db.prepare(`SELECT COUNT(*) as count FROM entities`);
const stmtTotalMessages = db.prepare(
  `SELECT COUNT(*) as count FROM messages WHERE created_at >= datetime('now', '-7 days')`
);

export function getWeeklyDigest(): string {
  const typeLabels: Record<string, string> = {
    fact: 'עובדות', preference: 'העדפות', event: 'אירועים', pattern: 'דפוסים',
    relationship: 'אנשים', feedback: 'תיקונים', rule: 'כללים', document: 'מסמכים',
  };

  let digest = '# דייג\'סט זיכרון שבועי\n\n';

  // Total stats
  const totalMem = (stmtTotalMemories.get() as any).count;
  let totalEnt = 0;
  try { totalEnt = (stmtTotalEntities.get() as any).count; } catch { /* ok */ }
  const weekMessages = (stmtTotalMessages.get() as any).count;
  digest += `## סה"כ\n- ${totalMem} זיכרונות | ${totalEnt} עובדות מובנות | ${weekMessages} הודעות השבוע\n\n`;

  // New memories this week
  const newMemories = stmtMemoriesThisWeek.all() as Array<{ count: number; type: string }>;
  if (newMemories.length > 0) {
    const totalNew = newMemories.reduce((sum, m) => sum + m.count, 0);
    digest += `## זיכרונות חדשים השבוע: ${totalNew}\n`;
    for (const m of newMemories) {
      digest += `- ${typeLabels[m.type] || m.type}: +${m.count}\n`;
    }
    digest += '\n';
  }

  // Top topics
  const topics = stmtTopTopicsThisWeek.all() as Array<{ topic: string; total: number }>;
  if (topics.length > 0) {
    digest += '## נושאים חמים\n';
    for (const t of topics) {
      digest += `- ${t.topic}: ${t.total} אזכורים\n`;
    }
    digest += '\n';
  }

  // Sentiment trend
  const sentiment = stmtSentimentThisWeek.get() as any;
  if (sentiment && sentiment.total > 0) {
    const avg = sentiment.avg_score;
    const moodLabel = avg > 0.3 ? 'חיובי' : avg < -0.3 ? 'שלילי' : 'ניטרלי';
    digest += `## מצב רוח\n- ממוצע: ${moodLabel} (${avg.toFixed(2)})\n`;
    digest += `- ${sentiment.positive} חיוביים | ${sentiment.negative} שליליים | ${sentiment.frustrated} מתוסכלים\n\n`;
  }

  // Pending commitments count
  try {
    const pendingCount = db.prepare(`SELECT COUNT(*) as count FROM commitments WHERE status = 'pending'`).get() as any;
    if (pendingCount.count > 0) {
      digest += `## התחייבויות פתוחות: ${pendingCount.count}\n`;
    }
  } catch { /* ok */ }

  // Relationships count
  try {
    const relCount = db.prepare(`SELECT COUNT(*) as count FROM relationships`).get() as any;
    if (relCount.count > 0) {
      digest += `## אנשים מוכרים: ${relCount.count}\n`;
    }
  } catch { /* ok */ }

  return digest;
}

// --- Backwards compatibility (used by old tool) ---

export function setFact(key: string, value: string) {
  saveMemory('fact', 'personal', `${key}: ${value}`, 5, 'user_told');
}

export function getAllFacts(): Array<{ key: string; value: string }> {
  const memories = stmtAllMemories.all() as Memory[];
  return memories.map(m => ({ key: m.type, value: m.content }));
}

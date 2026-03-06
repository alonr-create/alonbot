import { db } from '../utils/db.js';
import { getEmbedding } from '../utils/embeddings.js';
import { config } from '../utils/config.js';

interface KnowledgeDoc {
  id: number;
  title: string;
  source_type: string;
  source_ref: string | null;
  chunk_count: number;
  created_at: string;
}

interface KnowledgeChunk {
  id: number;
  doc_id: number;
  chunk_index: number;
  content: string;
}

// --- Prepared Statements ---

const stmtInsertDoc = db.prepare(
  `INSERT INTO knowledge_docs (title, source_type, source_ref, chunk_count) VALUES (?, ?, ?, ?)`
);

const stmtInsertChunk = db.prepare(
  `INSERT INTO knowledge_chunks (doc_id, chunk_index, content) VALUES (?, ?, ?)`
);

const stmtInsertVector = db.prepare(
  `INSERT INTO knowledge_vectors (rowid, embedding) VALUES (?, ?)`
);

const stmtVectorSearch = db.prepare(`
  SELECT kv.rowid as chunk_id, kv.distance, kc.content, kc.doc_id, kd.title
  FROM knowledge_vectors kv
  JOIN knowledge_chunks kc ON kc.id = kv.rowid
  JOIN knowledge_docs kd ON kd.id = kc.doc_id
  WHERE kv.embedding MATCH ? AND k = ?
  ORDER BY kv.distance
`);

const stmtListDocs = db.prepare(
  `SELECT id, title, source_type, source_ref, chunk_count, created_at FROM knowledge_docs ORDER BY created_at DESC`
);

const stmtDeleteDoc = db.prepare(`DELETE FROM knowledge_docs WHERE id = ?`);
const stmtDeleteChunks = db.prepare(`DELETE FROM knowledge_chunks WHERE doc_id = ?`);
const stmtGetChunkIds = db.prepare(`SELECT id FROM knowledge_chunks WHERE doc_id = ?`);
const stmtDeleteVector = db.prepare(`DELETE FROM knowledge_vectors WHERE rowid = ?`);

// --- Chunking ---

function chunkText(text: string, maxChunkSize: number = 800, overlap: number = 100): string[] {
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChunkSize && current.length > 0) {
      chunks.push(current.trim());
      // Keep overlap from end of previous chunk
      const words = current.split(/\s+/);
      const overlapWords = words.slice(-Math.floor(overlap / 5));
      current = overlapWords.join(' ') + ' ' + sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

// --- Ingest ---

export async function ingestUrl(url: string, title?: string): Promise<{ docId: number; chunks: number }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlonBot/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Failed to fetch URL: ${res.status}`);

  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const docTitle = title || url.split('/').pop()?.split('?')[0] || url;
  return ingestText(text, docTitle, 'url', url);
}

export async function ingestText(text: string, title: string, sourceType: string = 'text', sourceRef?: string): Promise<{ docId: number; chunks: number }> {
  const chunks = chunkText(text);
  if (chunks.length === 0) throw new Error('No content to ingest');

  const docResult = stmtInsertDoc.run(title, sourceType, sourceRef || null, chunks.length);
  const docId = docResult.lastInsertRowid as number;

  for (let i = 0; i < chunks.length; i++) {
    const chunkResult = stmtInsertChunk.run(docId, i, chunks[i]);
    const chunkId = chunkResult.lastInsertRowid as number;

    try {
      const embedding = await getEmbedding(chunks[i]);
      stmtInsertVector.run(BigInt(chunkId), Buffer.from(embedding.buffer));
    } catch (err: any) {
      console.error(`[Knowledge] Failed to embed chunk ${i}:`, err.message);
    }
  }

  console.log(`[Knowledge] Ingested "${title}": ${chunks.length} chunks`);
  return { docId, chunks: chunks.length };
}

// --- Search ---

export async function searchKnowledge(query: string, topK: number = 5): Promise<Array<{ content: string; title: string; distance: number }>> {
  try {
    const queryEmbedding = await getEmbedding(query);
    const results = stmtVectorSearch.all(
      Buffer.from(queryEmbedding.buffer),
      topK
    ) as Array<{ chunk_id: number; distance: number; content: string; doc_id: number; title: string }>;

    return results
      .filter(r => r.distance < 1.3)
      .map(r => ({ content: r.content, title: r.title, distance: r.distance }));
  } catch (err: any) {
    console.error('[Knowledge] Search failed:', err.message);
    return [];
  }
}

// --- Management ---

export function listDocs(): KnowledgeDoc[] {
  return stmtListDocs.all() as KnowledgeDoc[];
}

export function deleteDoc(docId: number): boolean {
  // Delete vectors for all chunks of this doc
  const chunkIds = stmtGetChunkIds.all(docId) as Array<{ id: number }>;
  for (const c of chunkIds) {
    stmtDeleteVector.run(BigInt(c.id));
  }
  stmtDeleteChunks.run(docId);
  const result = stmtDeleteDoc.run(docId);
  return result.changes > 0;
}

import { config } from './config.js';

const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIM = 768;

export { EMBEDDING_DIM };

export async function getEmbedding(text: string): Promise<Float32Array> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${config.geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBEDDING_DIM,
      }),
    }
  );

  if (!resp.ok) {
    throw new Error(`Embedding API error: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json() as { embedding: { values: number[] } };
  return new Float32Array(data.embedding.values);
}

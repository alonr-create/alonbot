import { ingestUrl, ingestText, searchKnowledge, listDocs, deleteDoc } from '../../agent/knowledge.js';
import { isUrlAllowed } from '../../utils/security.js';
import type { ToolHandler } from '../types.js';

const handlers: ToolHandler[] = [
  {
    name: 'learn_url',
    definition: {
      name: 'learn_url',
      description: 'Ingest a web page into knowledge base for later retrieval',
      input_schema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['url'],
      },
    },
    async execute(input, ctx) {
      if (!ctx.config.geminiApiKey) return 'Error: GEMINI_API_KEY needed for embeddings.';
      if (!isUrlAllowed(input.url)) return 'Error: URL not allowed (private/internal addresses blocked).';
      try {
        const result = await ingestUrl(input.url, input.title);
        return `Ingested "${input.title || input.url}": ${result.chunks} chunks saved to knowledge base (doc #${result.docId})`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
  },
  {
    name: 'learn_text',
    definition: {
      name: 'learn_text',
      description: 'Ingest text content into knowledge base',
      input_schema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['text', 'title'],
      },
    },
    async execute(input, ctx) {
      if (!ctx.config.geminiApiKey) return 'Error: GEMINI_API_KEY needed for embeddings.';
      try {
        const result = await ingestText(input.text, input.title);
        return `Ingested "${input.title}": ${result.chunks} chunks saved to knowledge base (doc #${result.docId})`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
  },
  {
    name: 'search_knowledge',
    definition: {
      name: 'search_knowledge',
      description: 'Search knowledge base (ingested docs) by semantic query',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string' },
          top_k: { type: 'number' },
        },
        required: ['query'],
      },
    },
    async execute(input, ctx) {
      if (!ctx.config.geminiApiKey) return 'Error: GEMINI_API_KEY needed for search.';
      try {
        const results = await searchKnowledge(input.query, input.top_k || 5);
        if (results.length === 0) return 'No relevant knowledge found.';
        return results.map((r, i) => `[${i + 1}] (${r.title}) ${r.content}`).join('\n\n');
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
  },
  {
    name: 'list_knowledge',
    definition: {
      name: 'list_knowledge',
      description: 'List all documents in knowledge base',
      input_schema: { type: 'object' as const, properties: {} },
    },
    async execute() {
      const docs = listDocs();
      if (docs.length === 0) return 'Knowledge base is empty.';
      return docs.map(d => `#${d.id} "${d.title}" (${d.source_type}, ${d.chunk_count} chunks, ${d.created_at})`).join('\n');
    },
  },
  {
    name: 'delete_knowledge',
    definition: {
      name: 'delete_knowledge',
      description: 'Delete document from knowledge base',
      input_schema: {
        type: 'object' as const,
        properties: { doc_id: { type: 'number' } },
        required: ['doc_id'],
      },
    },
    async execute(input) {
      const success = deleteDoc(input.doc_id);
      return success ? `Document #${input.doc_id} deleted from knowledge base.` : `Document #${input.doc_id} not found.`;
    },
  },
];

export default handlers;

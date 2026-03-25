import { getRelevantMemories, getEntities, searchEntities, forgetEntityByContent, type Memory } from '../../agent/memory.js';
import { db } from '../../utils/db.js';
import type { ToolHandler } from '../types.js';

const stmtAllMemories = db.prepare(
  `SELECT * FROM memories ORDER BY importance DESC, created_at DESC LIMIT 50`
);

const stmtSearchMemoriesExact = db.prepare(
  `SELECT * FROM memories WHERE content LIKE ? ORDER BY importance DESC LIMIT 20`
);

const stmtDeleteMemory = db.prepare(`DELETE FROM memories WHERE id = ?`);

const stmtMemoryStats = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN type = 'fact' THEN 1 ELSE 0 END) as facts,
    SUM(CASE WHEN type = 'preference' THEN 1 ELSE 0 END) as preferences,
    SUM(CASE WHEN type = 'event' THEN 1 ELSE 0 END) as events,
    SUM(CASE WHEN type = 'feedback' THEN 1 ELSE 0 END) as feedback,
    SUM(CASE WHEN type = 'rule' THEN 1 ELSE 0 END) as rules,
    SUM(CASE WHEN type = 'document' THEN 1 ELSE 0 END) as documents,
    SUM(CASE WHEN type = 'relationship' THEN 1 ELSE 0 END) as relationships,
    SUM(CASE WHEN type = 'pattern' THEN 1 ELSE 0 END) as patterns
  FROM memories
`);

const stmtEntityCount = db.prepare(`SELECT COUNT(*) as count FROM entities`);

const handlers: ToolHandler[] = [
  {
    name: 'my_memories',
    definition: {
      name: 'my_memories',
      description: 'Show what the bot remembers about the user. Use when user asks "what do you remember?", "מה אתה זוכר?", "what do you know about me?"',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Optional search query to filter memories' },
          show_entities: { type: 'boolean', description: 'Also show structured entity facts' },
        },
        required: [],
      },
    },
    async execute(input) {
      let result = '';

      // Stats
      const stats = stmtMemoryStats.get() as any;
      let entityCount = 0;
      try { entityCount = (stmtEntityCount.get() as any).count; } catch { /* ok */ }
      result += `📊 סטטיסטיקות זיכרון:\n`;
      result += `סה"כ: ${stats.total} זיכרונות | ${entityCount} עובדות מובנות\n`;
      result += `עובדות: ${stats.facts} | העדפות: ${stats.preferences} | אירועים: ${stats.events}\n`;
      result += `תיקונים: ${stats.feedback} | כללים: ${stats.rules} | מסמכים: ${stats.documents}\n`;
      result += `אנשים: ${stats.relationships} | דפוסים: ${stats.patterns}\n\n`;

      // Search or show all
      let memories: Memory[];
      if (input.query) {
        memories = stmtSearchMemoriesExact.all(`%${input.query}%`) as Memory[];
        result += `🔍 תוצאות חיפוש "${input.query}" (${memories.length}):\n`;
      } else {
        memories = stmtAllMemories.all() as Memory[];
        result += `📝 זיכרונות (top 50):\n`;
      }

      for (const m of memories) {
        const stars = m.importance >= 8 ? ' ⭐' : '';
        result += `[${m.id}] (${m.type}/${m.category || '-'}, חשיבות:${m.importance}) ${m.content}${stars}\n`;
      }

      // Show entities if requested
      if (input.show_entities) {
        const entities = getEntities('אלון');
        if (entities.length > 0) {
          result += `\n🧠 עובדות מובנות:\n`;
          for (const e of entities) {
            result += `[${e.id}] ${e.subject} → ${e.predicate} → ${e.object} (${(e.confidence * 100).toFixed(0)}%)\n`;
          }
        }
      }

      return result;
    },
  },
  {
    name: 'forget',
    definition: {
      name: 'forget',
      description: 'Delete a specific memory or entity. Use when user says "forget X", "תשכח X", "delete memory", "תמחק את הזיכרון"',
      input_schema: {
        type: 'object' as const,
        properties: {
          memory_id: { type: 'number', description: 'Specific memory ID to delete' },
          search: { type: 'string', description: 'Search text to find and delete matching memories' },
          forget_entities_too: { type: 'boolean', description: 'Also delete matching entities' },
        },
        required: [],
      },
    },
    async execute(input) {
      let deleted = 0;

      if (input.memory_id) {
        stmtDeleteMemory.run(input.memory_id);
        try { db.prepare('DELETE FROM memory_vectors WHERE rowid = ?').run(BigInt(input.memory_id)); } catch { /* ok */ }
        deleted++;
      }

      if (input.search) {
        const matches = stmtSearchMemoriesExact.all(`%${input.search}%`) as Memory[];
        for (const m of matches) {
          // Don't auto-delete high importance memories — flag them
          if (m.importance >= 8) {
            continue; // skip critical memories
          }
          stmtDeleteMemory.run(m.id);
          try { db.prepare('DELETE FROM memory_vectors WHERE rowid = ?').run(BigInt(m.id)); } catch { /* ok */ }
          deleted++;
        }

        if (input.forget_entities_too) {
          const entityDeleted = forgetEntityByContent(input.search);
          deleted += entityDeleted;
        }
      }

      if (deleted === 0) {
        return 'לא מצאתי זיכרונות תואמים למחיקה. תנסה חיפוש מדויק יותר, או תן memory_id ספציפי (אפשר לראות עם my_memories).';
      }

      return `נמחקו ${deleted} זיכרונות. שכחתי את זה.`;
    },
  },
];

export default handlers;

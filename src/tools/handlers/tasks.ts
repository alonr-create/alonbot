import type { ToolHandler } from '../types.js';

const handlers: ToolHandler[] = [
  {
    name: 'add_task',
    definition: {
      name: 'add_task',
      description: 'Add task to todo list',
      input_schema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string' },
          priority: { type: 'number', description: '1-10' },
          due_date: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['title'],
      },
    },
    async execute(input, ctx) {
      const stmt = ctx.db.prepare('INSERT INTO tasks (title, priority, due_date) VALUES (?, ?, ?)');
      const result = stmt.run(input.title, input.priority || 5, input.due_date || null);
      return `Task #${result.lastInsertRowid} added: "${input.title}"`;
    },
  },
  {
    name: 'list_tasks',
    definition: {
      name: 'list_tasks',
      description: 'List pending tasks',
      input_schema: { type: 'object' as const, properties: {} },
    },
    async execute(input, ctx) {
      const tasks = ctx.db.prepare("SELECT id, title, priority, due_date, created_at FROM tasks WHERE status = 'pending' ORDER BY priority DESC, created_at").all() as any[];
      if (tasks.length === 0) return 'No pending tasks.';
      return tasks.map(t => `#${t.id} [${t.priority}] ${t.title}${t.due_date ? ` (עד ${t.due_date})` : ''}`).join('\n');
    },
  },
  {
    name: 'complete_task',
    definition: {
      name: 'complete_task',
      description: 'Mark task as done',
      input_schema: {
        type: 'object' as const,
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
    async execute(input, ctx) {
      const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace(' ', 'T');
      const result = ctx.db.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ? AND status = 'pending'").run(now, input.id);
      return result.changes > 0 ? `Task #${input.id} completed!` : `Task #${input.id} not found or already done.`;
    },
  },
];

export default handlers;

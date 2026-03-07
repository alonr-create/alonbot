import { saveMemory } from '../../agent/memory.js';
import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'remember',
  definition: {
    name: 'remember',
    description: 'Save memory about user',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string' },
        type: { type: 'string', enum: ['fact', 'preference', 'event', 'pattern', 'relationship'] },
        category: { type: 'string', enum: ['personal', 'work_dekel', 'work_mazpen', 'work_alon_dev', 'work_aliza', 'health', 'finance'] },
        importance: { type: 'number', description: '1-10' },
      },
      required: ['content', 'type'],
    },
  },
  async execute(input) {
    const id = saveMemory(
      input.type || 'fact',
      input.category || null,
      input.content,
      input.importance || 5,
      'user_told'
    );
    return `Remembered (id=${id}, type=${input.type}): ${input.content}`;
  },
};

export default handler;

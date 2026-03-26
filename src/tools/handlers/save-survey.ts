import type { ToolHandler } from '../types.js';
import { db } from '../../utils/db.js';
import { withRetry } from '../../utils/retry.js';

// Ensure survey_responses table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS survey_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    lead_name TEXT,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

const handler: ToolHandler = {
  name: 'save_survey',
  definition: {
    name: 'save_survey',
    description: 'Save lead survey/discovery answers to DB and update Monday.com. Call after gathering 2-3 answers from the lead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        phone: { type: 'string', description: 'Lead phone number' },
        lead_name: { type: 'string', description: 'Lead name' },
        business_type: { type: 'string', description: 'What the business does' },
        has_website: { type: 'string', description: 'Current website situation (none/old/competitor-built)' },
        lead_source: { type: 'string', description: 'Where their customers come from (Google/Facebook/word of mouth/none)' },
        main_need: { type: 'string', description: 'Most urgent digital need' },
        extra_notes: { type: 'string', description: 'Any other relevant info from the conversation' },
      },
      required: ['phone'],
    },
  },
  async execute(input, ctx) {
    try {
      const answers: Record<string, string> = {};
      if (input.business_type) answers['סוג עסק'] = input.business_type;
      if (input.has_website) answers['אתר קיים'] = input.has_website;
      if (input.lead_source) answers['מקור לקוחות'] = input.lead_source;
      if (input.main_need) answers['צורך עיקרי'] = input.main_need;
      if (input.extra_notes) answers['הערות'] = input.extra_notes;

      // Save each answer to DB
      const insert = db.prepare('INSERT INTO survey_responses (phone, lead_name, question, answer) VALUES (?, ?, ?, ?)');
      for (const [q, a] of Object.entries(answers)) {
        insert.run(input.phone, input.lead_name || null, q, a);
      }

      // Build summary for Monday.com
      const summary = Object.entries(answers).map(([q, a]) => `${q}: ${a}`).join('\n');

      // Update Monday.com lead notes if API key available
      if (ctx.config.mondayApiKey && summary) {
        try {
          // Find the lead's item by phone
          const searchQuery = `{ items_page_by_column_values (board_id: 5092777389, limit: 1, columns: [{column_id: "phone_mm16hqz2", column_values: ["${input.phone.replace(/\D/g, '')}"]}]) { items { id } } }`;
          const searchRes = await withRetry(() => fetch('https://api.monday.com/v2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': ctx.config.mondayApiKey },
            body: JSON.stringify({ query: searchQuery }),
          }));
          const searchData = await searchRes.json() as any;
          const itemId = searchData?.data?.items_page_by_column_values?.items?.[0]?.id;

          if (itemId) {
            // Add survey results as an update (comment) on the item
            const updateQuery = `mutation { create_update (item_id: ${itemId}, body: "📋 תחקיר ליד:\\n${summary.replace(/"/g, '\\"').replace(/\n/g, '\\n')}") { id } }`;
            await withRetry(() => fetch('https://api.monday.com/v2', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': ctx.config.mondayApiKey },
              body: JSON.stringify({ query: updateQuery }),
            }));
          }
        } catch (e: any) {
          // Monday update is best-effort
        }
      }

      return `Survey saved (${Object.keys(answers).length} answers). ${summary ? 'Summary: ' + summary : ''}`;
    } catch (e: any) {
      return `Error saving survey: ${e.message}`;
    }
  },
};

export default handler;

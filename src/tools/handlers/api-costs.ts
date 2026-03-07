import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'api_costs',
  definition: {
    name: 'api_costs',
    description: 'Show API usage costs (today/week/month/all)',
    input_schema: {
      type: 'object' as const,
      properties: {
        period: { type: 'string', enum: ['today', 'week', 'month', 'all'], description: 'Time period' },
      },
      required: ['period'],
    },
  },
  async execute(input, ctx) {
    const periods: Record<string, string> = {
      today: "date(created_at) = date('now')",
      week: "created_at >= datetime('now', '-7 days')",
      month: "created_at >= datetime('now', '-30 days')",
      all: '1=1',
    };
    const where = periods[input.period];
    if (!where) return `Invalid period. Use: today, week, month, all`;
    const rows = ctx.db.prepare(`
      SELECT model, COUNT(*) as calls, SUM(input_tokens) as input_t, SUM(output_tokens) as output_t,
             ROUND(SUM(cost_usd), 4) as total_cost
      FROM api_usage WHERE ${where} GROUP BY model
    `).all() as any[];
    if (rows.length === 0) return `No API usage for period: ${input.period}`;
    const total = rows.reduce((s, r) => s + (r.total_cost || 0), 0);
    const lines = rows.map(r => `${r.model}: ${r.calls} calls, ${r.input_t?.toLocaleString()}↓ ${r.output_t?.toLocaleString()}↑, $${r.total_cost}`);
    lines.push(`\nTotal: $${total.toFixed(4)}`);
    return lines.join('\n');
  },
};

export default handler;

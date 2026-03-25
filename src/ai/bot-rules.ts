/**
 * Bot learning rules — persistent memory from boss corrections and preferences.
 * Rules are loaded into the system prompt so the bot learns from feedback.
 */
import { getDb } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('bot-rules');

export interface BotRule {
  id: number;
  rule: string;
  source: string;
  created_at: string;
}

/** Get all active rules. */
export function getActiveRules(): BotRule[] {
  const db = getDb();
  return db
    .prepare('SELECT id, rule, source, created_at FROM bot_rules WHERE active = 1 ORDER BY created_at ASC')
    .all() as BotRule[];
}

/** Add a new rule. Returns the rule ID. */
export function addRule(rule: string, source = 'boss'): number {
  const db = getDb();
  // Check for duplicate
  const existing = db
    .prepare('SELECT id FROM bot_rules WHERE rule = ? AND active = 1')
    .get(rule) as { id: number } | undefined;
  if (existing) {
    log.debug({ rule }, 'rule already exists, skipping');
    return existing.id;
  }

  const result = db
    .prepare('INSERT INTO bot_rules (rule, source) VALUES (?, ?)')
    .run(rule, source);
  log.info({ rule, source, id: result.lastInsertRowid }, 'new rule added');
  return result.lastInsertRowid as number;
}

/** Deactivate a rule by ID. */
export function removeRule(id: number): boolean {
  const db = getDb();
  const result = db.prepare('UPDATE bot_rules SET active = 0 WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Format rules for inclusion in system prompt. */
export function formatRulesForPrompt(): string {
  const rules = getActiveRules();
  if (rules.length === 0) return '';

  const lines = rules.map((r, i) => `${i + 1}. ${r.rule}`);
  return `
## כללים שלמדתי (${rules.length})
הכללים הבאים נוספו על ידי הבוס. **חובה לציית להם תמיד**:
${lines.join('\n')}
`;
}

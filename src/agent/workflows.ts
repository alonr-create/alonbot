import { db } from '../utils/db.js';

export interface WorkflowAction {
  type: 'send_message' | 'add_task' | 'send_email' | 'remember' | 'set_reminder';
  params: Record<string, any>;
}

export interface Workflow {
  id: number;
  name: string;
  trigger_type: 'keyword' | 'cron' | 'event';
  trigger_value: string;
  actions: WorkflowAction[];
  enabled: number;
  created_at: string;
}

// --- Prepared Statements ---

const stmtInsert = db.prepare(
  `INSERT INTO workflows (name, trigger_type, trigger_value, actions) VALUES (?, ?, ?, ?)`
);

const stmtAll = db.prepare(
  `SELECT * FROM workflows WHERE enabled = 1 ORDER BY created_at DESC`
);

const stmtList = db.prepare(
  `SELECT * FROM workflows ORDER BY created_at DESC`
);

const stmtDelete = db.prepare(`DELETE FROM workflows WHERE id = ?`);

const stmtToggle = db.prepare(
  `UPDATE workflows SET enabled = ? WHERE id = ?`
);

// --- Management ---

export function addWorkflow(name: string, triggerType: string, triggerValue: string, actions: WorkflowAction[]): number {
  const result = stmtInsert.run(name, triggerType, triggerValue, JSON.stringify(actions));
  return result.lastInsertRowid as number;
}

export function listWorkflows(): Workflow[] {
  const rows = stmtList.all() as any[];
  return rows.map(r => ({ ...r, actions: JSON.parse(r.actions) }));
}

export function deleteWorkflow(id: number): boolean {
  return stmtDelete.run(id).changes > 0;
}

export function toggleWorkflow(id: number, enabled: boolean): boolean {
  return stmtToggle.run(enabled ? 1 : 0, id).changes > 0;
}

// --- Matching ---

export function matchKeywordWorkflows(message: string): Workflow[] {
  const enabled = stmtAll.all() as any[];
  const workflows = enabled.map((r: any) => ({ ...r, actions: JSON.parse(r.actions) })) as Workflow[];

  return workflows
    .filter(w => w.trigger_type === 'keyword')
    .filter(w => {
      const keywords = w.trigger_value.split(',').map(k => k.trim().toLowerCase());
      const lowerMsg = message.toLowerCase();
      return keywords.some(kw => lowerMsg.includes(kw));
    });
}

export function getEventWorkflows(eventName: string): Workflow[] {
  const enabled = stmtAll.all() as any[];
  const workflows = enabled.map((r: any) => ({ ...r, actions: JSON.parse(r.actions) })) as Workflow[];
  return workflows.filter(w => w.trigger_type === 'event' && w.trigger_value === eventName);
}

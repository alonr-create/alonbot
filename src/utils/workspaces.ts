import { db } from './db.js';
import { LEAD_STATUS } from './lead-status.js';
import { createLogger } from './logger.js';

const log = createLogger('workspaces');

export interface Workspace {
  id: string;
  name: string;
  icon: string;
  color: string;
  welcome_msg: string | null;
  system_prompt: string | null;
  monday_board_id: string | null;
  monday_columns: string | null;
  calendar_id: string | null;
  zoom_link: string | null;
  website: string | null;
  default_lead_status: string;
  active: number;
  created_at: string;
}

export function getAllWorkspaces(): Workspace[] {
  return db.prepare('SELECT * FROM workspaces ORDER BY created_at ASC').all() as Workspace[];
}

export function getWorkspace(id: string): Workspace | null {
  return (db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Workspace) || null;
}

export function getWorkspaceForSource(source: string): Workspace | null {
  // Map legacy source values to workspace IDs
  const map: Record<string, string> = {
    'alon_dev_whatsapp': 'alon_dev',
    'alon_dev': 'alon_dev',
    'voice_agent': 'dekel',  // יעל = הסוכנת הדיגיטלית של דקל לפרישה
    'dekel': 'dekel',
  };
  const wsId = map[source] || source;
  return getWorkspace(wsId);
}

export function getDefaultWorkspace(): Workspace | null {
  return getWorkspace('alon_dev');
}

export function createWorkspace(ws: Partial<Workspace> & { id: string; name: string }): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, icon, color, welcome_msg, system_prompt, monday_board_id, monday_columns, calendar_id, zoom_link, website, default_lead_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ws.id, ws.name, ws.icon || '📱', ws.color || '#25D366',
    ws.welcome_msg || null, ws.system_prompt || null,
    ws.monday_board_id || null, ws.monday_columns || null,
    ws.calendar_id || null, ws.zoom_link || null, ws.website || null,
    ws.default_lead_status || LEAD_STATUS.NEW
  );
  log.info({ id: ws.id, name: ws.name }, 'workspace created');
}

export function updateWorkspace(id: string, updates: Partial<Workspace>): void {
  const fields: string[] = [];
  const values: any[] = [];
  const allowed = ['name', 'icon', 'color', 'welcome_msg', 'system_prompt', 'monday_board_id', 'monday_columns', 'calendar_id', 'zoom_link', 'website', 'default_lead_status', 'active'];
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.includes(k)) {
      fields.push(`${k} = ?`);
      values.push(v);
    }
  }
  if (!fields.length) return;
  values.push(id);
  db.prepare(`UPDATE workspaces SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  log.info({ id, fields: fields.length }, 'workspace updated');
}

export function deleteWorkspace(id: string): void {
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  log.info({ id }, 'workspace deleted');
}

/**
 * Build a sales prompt for a workspace + lead context.
 * If the workspace has a custom system_prompt, use template interpolation.
 * Otherwise, fall back to the built-in prompt builders.
 */
export function getWorkspacePrompt(ws: Workspace, lead: { phone: string; name: string | null; lead_status?: string | null; last_call_summary?: string | null; last_call_sentiment?: string | null; was_booked?: number }): string | null {
  if (!ws.system_prompt) return null; // use built-in fallback

  let prompt = ws.system_prompt;
  prompt = prompt.replace(/\{\{name\}\}/g, lead.name || 'לקוח חדש');
  prompt = prompt.replace(/\{\{phone\}\}/g, lead.phone);
  prompt = prompt.replace(/\{\{status\}\}/g, lead.lead_status || 'לא ידוע');
  prompt = prompt.replace(/\{\{summary\}\}/g, lead.last_call_summary || 'אין סיכום');
  prompt = prompt.replace(/\{\{sentiment\}\}/g, lead.last_call_sentiment || 'לא ידוע');
  prompt = prompt.replace(/\{\{booked\}\}/g, lead.was_booked === 1 ? 'כן' : 'לא');
  prompt = prompt.replace(/\{\{workspace_name\}\}/g, ws.name);
  prompt = prompt.replace(/\{\{zoom_link\}\}/g, ws.zoom_link || '');
  prompt = prompt.replace(/\{\{website\}\}/g, ws.website || '');
  prompt = prompt.replace(/\{\{board_id\}\}/g, ws.monday_board_id || '');
  return prompt;
}

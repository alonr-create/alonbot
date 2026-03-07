import { executeTool } from './registry.js';
import type { WorkflowAction } from '../agent/workflows.js';

export async function executeWorkflowActions(
  actions: WorkflowAction[],
  context: { channel: string; targetId: string }
): Promise<string[]> {
  const results: string[] = [];
  for (const action of actions) {
    try {
      switch (action.type) {
        case 'add_task':
        case 'send_email':
        case 'remember':
        case 'set_reminder': {
          results.push(await executeTool(action.type, action.params));
          break;
        }
        case 'send_message': {
          results.push(`Message: ${action.params.text || action.params.message}`);
          break;
        }
        default:
          results.push(`Unknown action type: ${action.type}`);
      }
    } catch (e: any) {
      results.push(`Action ${action.type} failed: ${e.message}`);
    }
  }
  return results;
}

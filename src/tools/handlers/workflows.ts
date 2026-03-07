import { addWorkflow, listWorkflows, deleteWorkflow, toggleWorkflow, type WorkflowAction } from '../../agent/workflows.js';
import type { ToolHandler } from '../types.js';

const handlers: ToolHandler[] = [
  {
    name: 'create_workflow',
    definition: {
      name: 'create_workflow',
      description: 'Create automated workflow (trigger → actions). Trigger types: keyword, cron, event. Action types: send_message, add_task, send_email, remember, set_reminder',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' },
          trigger_type: { type: 'string', enum: ['keyword', 'cron', 'event'] },
          trigger_value: { type: 'string', description: 'Keywords (comma-separated), cron expr, or event name' },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                params: { type: 'object' },
              },
              required: ['type', 'params'],
            },
          },
        },
        required: ['name', 'trigger_type', 'trigger_value', 'actions'],
      },
    },
    async execute(input) {
      try {
        const id = addWorkflow(input.name, input.trigger_type, input.trigger_value, input.actions);
        return `Workflow #${id} created: "${input.name}" (${input.trigger_type}: ${input.trigger_value}) → ${input.actions.length} actions`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
  },
  {
    name: 'list_workflows',
    definition: {
      name: 'list_workflows',
      description: 'List all automated workflows',
      input_schema: { type: 'object' as const, properties: {} },
    },
    async execute() {
      const workflows = listWorkflows();
      if (workflows.length === 0) return 'No workflows configured.';
      return workflows.map(w => {
        const status = w.enabled ? 'ON' : 'OFF';
        const actions = w.actions.map((a: WorkflowAction) => a.type).join(', ');
        return `#${w.id} [${status}] "${w.name}" — ${w.trigger_type}:${w.trigger_value} → ${actions}`;
      }).join('\n');
    },
  },
  {
    name: 'delete_workflow',
    definition: {
      name: 'delete_workflow',
      description: 'Delete a workflow',
      input_schema: {
        type: 'object' as const,
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
    async execute(input) {
      const success = deleteWorkflow(input.id);
      return success ? `Workflow #${input.id} deleted.` : `Workflow #${input.id} not found.`;
    },
  },
  {
    name: 'toggle_workflow',
    definition: {
      name: 'toggle_workflow',
      description: 'Enable/disable a workflow',
      input_schema: {
        type: 'object' as const,
        properties: {
          id: { type: 'number' },
          enabled: { type: 'boolean' },
        },
        required: ['id', 'enabled'],
      },
    },
    async execute(input) {
      const success = toggleWorkflow(input.id, input.enabled);
      return success ? `Workflow #${input.id} ${input.enabled ? 'enabled' : 'disabled'}.` : `Workflow #${input.id} not found.`;
    },
  },
];

export default handlers;

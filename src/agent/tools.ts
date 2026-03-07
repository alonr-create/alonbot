import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config.js';
import { db } from '../utils/db.js';
import { matchKeywordWorkflows, type WorkflowAction } from './workflows.js';
import { setCurrentRequestId, addPendingMedia, collectMedia } from '../tools/media.js';
import { LOCAL_ONLY_TOOLS } from '../utils/security.js';
import type { ToolHandler, ToolContext } from '../tools/types.js';

// --- Handler imports ---
import shellHandler from '../tools/handlers/shell.js';
import filesHandler from '../tools/handlers/files.js';
import screenshotHandler from '../tools/handlers/screenshot.js';
import webSearchHandler from '../tools/handlers/web-search.js';
import webResearchHandler from '../tools/handlers/web-research.js';
import browseUrlHandler from '../tools/handlers/browse-url.js';
import scrapeSiteHandler from '../tools/handlers/scrape-site.js';
import analyzeImageHandler from '../tools/handlers/analyze-image.js';
import generateImageHandler from '../tools/handlers/generate-image.js';
import sendVoiceHandler from '../tools/handlers/send-voice.js';
import sendEmailHandler from '../tools/handlers/send-email.js';
import remindersHandler from '../tools/handlers/reminders.js';
import tasksHandler from '../tools/handlers/tasks.js';
import rememberHandler from '../tools/handlers/remember.js';
import scheduleMessageHandler from '../tools/handlers/schedule-message.js';
import apiCostsHandler from '../tools/handlers/api-costs.js';
import mondayHandler from '../tools/handlers/monday.js';
import calendarHandler from '../tools/handlers/calendar.js';
import knowledgeHandler from '../tools/handlers/knowledge.js';
import workflowsHandler from '../tools/handlers/workflows.js';
import githubHandler from '../tools/handlers/github.js';
import deployHandler from '../tools/handlers/deploy.js';
import buildWebsiteHandler from '../tools/handlers/build-website.js';
import autoImproveHandler from '../tools/handlers/auto-improve.js';
import codeAgentHandler from '../tools/handlers/code-agent.js';
import cronScriptHandler from '../tools/handlers/cron-script.js';
import manageProjectHandler from '../tools/handlers/manage-project.js';

export { setCurrentRequestId, collectMedia };

// --- Build handler map from all imported handlers ---
const handlerMap = new Map<string, ToolHandler>();

function registerHandlers(handlers: ToolHandler | ToolHandler[]) {
  const arr = Array.isArray(handlers) ? handlers : [handlers];
  for (const h of arr) handlerMap.set(h.name, h);
}

registerHandlers(shellHandler);
registerHandlers(filesHandler);
registerHandlers(screenshotHandler);
registerHandlers(webSearchHandler);
registerHandlers(webResearchHandler);
registerHandlers(browseUrlHandler);
registerHandlers(scrapeSiteHandler);
registerHandlers(analyzeImageHandler);
registerHandlers(generateImageHandler);
registerHandlers(sendVoiceHandler);
registerHandlers(sendEmailHandler);
registerHandlers(remindersHandler);
registerHandlers(tasksHandler);
registerHandlers(rememberHandler);
registerHandlers(scheduleMessageHandler);
registerHandlers(apiCostsHandler);
registerHandlers(mondayHandler);
registerHandlers(calendarHandler);
registerHandlers(knowledgeHandler);
registerHandlers(workflowsHandler);
registerHandlers(githubHandler);
registerHandlers(deployHandler);
registerHandlers(buildWebsiteHandler);
registerHandlers(autoImproveHandler);
registerHandlers(codeAgentHandler);
registerHandlers(cronScriptHandler);
registerHandlers(manageProjectHandler);

// --- Tool definitions for Claude API ---
export const toolDefinitions: Anthropic.Tool[] = Array.from(handlerMap.values()).map(h => h.definition);

// --- Proxy local tools from cloud to Mac ---
async function proxyToLocal(name: string, input: Record<string, any>): Promise<{ result: string; media?: Array<{ type: string; data: string }> } | null> {
  if (!config.localApiUrl) return null;
  try {
    const res = await fetch(`${config.localApiUrl}/api/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.localApiSecret}`,
      },
      body: JSON.stringify({ name, input }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return await res.json() as any;
  } catch {
    return null;
  }
}

// --- Tool execution ---
export async function executeTool(name: string, input: Record<string, any>): Promise<string> {
  const handler = handlerMap.get(name);
  if (!handler) return `Unknown tool: ${name}`;

  // Validate tool parameters with Zod schemas
  if (handler.schema) {
    const result = handler.schema.safeParse(input);
    if (!result.success) {
      const errors = result.error.issues.map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return `Validation error: ${errors}`;
    }
    input = result.data;
  }

  // In cloud mode, proxy local-only tools to Mac
  if (config.mode === 'cloud' && LOCAL_ONLY_TOOLS.includes(name)) {
    const proxy = await proxyToLocal(name, input);
    if (!proxy) return 'Error: Mac is offline. This tool requires the local Mac to be running.';
    // Collect proxied media
    if (proxy.media) {
      for (const m of proxy.media) {
        addPendingMedia({ type: m.type as any, data: Buffer.from(m.data, 'base64') });
      }
    }
    return proxy.result;
  }

  const ctx: ToolContext = { config, db, addPendingMedia };
  return handler.execute(input, ctx);
}

// --- Workflow Execution (called from router) ---
export async function executeWorkflowActions(actions: WorkflowAction[], context: { channel: string; targetId: string }): Promise<string[]> {
  const results: string[] = [];
  for (const action of actions) {
    try {
      switch (action.type) {
        case 'add_task': {
          const r = await executeTool('add_task', action.params);
          results.push(r);
          break;
        }
        case 'send_email': {
          const r = await executeTool('send_email', action.params);
          results.push(r);
          break;
        }
        case 'remember': {
          const r = await executeTool('remember', action.params);
          results.push(r);
          break;
        }
        case 'set_reminder': {
          const r = await executeTool('set_reminder', action.params);
          results.push(r);
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

// src/agent/tools.ts
// Thin re-export wrapper — all logic lives in src/tools/
// This file exists to maintain backward compatibility with existing imports.

export { executeTool, getToolDefinitions } from '../tools/registry.js';
export { setCurrentRequestId, collectMedia, collectInteractive } from '../tools/media.js';
export { executeWorkflowActions } from '../tools/workflow-actions.js';

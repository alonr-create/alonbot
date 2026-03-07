import { z } from 'zod';
import { spawn } from 'child_process';
import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import type { ToolHandler } from '../types.js';

const codeAgentSchema = z.object({
  task: z.string().min(1).max(10000),
  max_budget: z.number().min(0.1).max(10).optional(),
  model: z.string().max(50).optional(),
  working_dir: z.string().max(200).optional(),
});

const handler: ToolHandler = {
  name: 'code_agent',
  definition: {
    name: 'code_agent',
    description: 'Launch Claude Code to build a real project with full dev loop (write, run, debug, fix, iterate). Use for programming tasks that need quality code.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task: { type: 'string', description: 'Detailed description of what to build' },
        working_dir: { type: 'string', description: 'Working directory name (default: auto-generated from task)' },
        max_budget: { type: 'number', description: 'Max USD to spend (default: 2)' },
        model: { type: 'string', enum: ['sonnet', 'opus'], description: 'Model (default: sonnet)' },
      },
      required: ['task'],
    },
  },
  schema: codeAgentSchema,
  async execute(input, ctx) {
    const task = input.task;
    const maxBudget = input.max_budget || 2;
    const model = input.model || 'sonnet';
    const dirName = input.working_dir || task.slice(0, 30).replace(/[^a-zA-Z0-9א-ת\s-]/g, '').replace(/\s+/g, '-').toLowerCase() || 'project';
    const workDir = `/app/workspace/${dirName}`;

    // Create working directory
    if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

    return new Promise<string>((resolveResult) => {
      const args = [
        '-p', task,
        '--output-format', 'stream-json',
        '--max-budget-usd', String(maxBudget),
        '--model', model,
        '--permission-mode', 'bypassPermissions',
        '--no-session-persistence',
      ];

      console.log(`[CodeAgent] Starting in ${workDir}: ${task.slice(0, 80)}`);

      const child = spawn('claude', args, {
        cwd: workDir,
        env: { ...process.env, ANTHROPIC_API_KEY: ctx.config.anthropicApiKey },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300000, // 5 minutes
      });

      let output = '';
      let lastResult = '';
      const toolActions: string[] = [];
      let totalCost = 0;

      child.stdout.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const event = JSON.parse(line);

            // Track tool usage for progress
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'tool_use') {
                  const toolInfo = block.name === 'Write' ? `Write: ${(block.input as any)?.file_path || ''}` :
                                   block.name === 'Edit' ? `Edit: ${(block.input as any)?.file_path || ''}` :
                                   block.name === 'Bash' ? `Run: ${((block.input as any)?.command || '').slice(0, 60)}` :
                                   block.name;
                  toolActions.push(toolInfo);
                  console.log(`[CodeAgent] ${toolInfo}`);
                }
                if (block.type === 'text') {
                  lastResult = block.text;
                }
              }
            }

            // Track result
            if (event.type === 'result') {
              lastResult = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
              if (event.cost_usd) totalCost = event.cost_usd;
            }
          } catch {
            // Non-JSON line, skip
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      child.on('close', (code) => {
        console.log(`[CodeAgent] Finished (exit ${code}), ${toolActions.length} tool calls, $${totalCost.toFixed(2)}`);

        // List files created
        let fileList = '';
        try {
          fileList = execSync(`find . -type f -not -path './.git/*' | head -30`, {
            cwd: workDir, encoding: 'utf-8', timeout: 5000,
          }).trim();
        } catch {}

        const summary = [
          `Claude Code finished (${model}, $${totalCost.toFixed(2)})`,
          '',
          `Actions (${toolActions.length}):`,
          ...toolActions.slice(-15).map(a => `  ${a}`),
          '',
          fileList ? `Files in ${workDir}:\n${fileList}` : 'No files created.',
          '',
          lastResult ? `Summary:\n${lastResult.slice(0, 2000)}` : '',
        ].join('\n');

        resolveResult(summary);
      });

      child.on('error', (err) => {
        console.error(`[CodeAgent] Error:`, err.message);
        resolveResult(`Error: Claude Code failed to start — ${err.message}\nMake sure @anthropic-ai/claude-code is installed globally.`);
      });

      // Safety timeout
      setTimeout(() => {
        try { child.kill(); } catch {}
        resolveResult('Error: Claude Code timed out after 5 minutes.');
      }, 300000);
    });
  },
};

export default handler;

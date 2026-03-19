import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type Database from 'better-sqlite3';

export interface ToolContext {
  config: typeof import('../utils/config.js').config;
  db: Database.Database;
  addPendingMedia: (item: { type: 'image' | 'voice' | 'document'; data: Buffer; filename?: string; mimetype?: string }) => void;
}

export interface ToolHandler {
  name: string;
  definition: Anthropic.Tool;
  schema?: z.ZodType<any>;
  localOnly?: boolean;
  execute(input: Record<string, any>, ctx: ToolContext): Promise<string>;
}

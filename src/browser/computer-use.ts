/**
 * Claude Computer Use agent loop.
 * Launches a headless Puppeteer browser, sends screenshots to Claude,
 * executes actions Claude requests, and returns the final result.
 */
import puppeteer from 'puppeteer';
import Anthropic from '@anthropic-ai/sdk';
import { Resolver } from 'node:dns/promises';
import { executeAction } from './puppeteer-actions.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('computer-use');

/** Resolve a hostname using Google DNS (8.8.8.8) as fallback. */
async function resolveHostname(hostname: string): Promise<string | null> {
  const resolver = new Resolver();
  resolver.setServers(['8.8.8.8', '8.8.4.4']);
  try {
    const addresses = await resolver.resolve4(hostname);
    return addresses[0] || null;
  } catch {
    return null;
  }
}

/** Ensure a URL resolves — try www. prefix and Google DNS as fallbacks. */
async function ensureResolvableUrl(url: string): Promise<{ url: string; hostRewriteRule?: string }> {
  const parsed = new URL(url);

  // Try resolving the hostname via Google DNS
  const ip = await resolveHostname(parsed.hostname);
  if (ip) {
    return {
      url,
      hostRewriteRule: `MAP ${parsed.hostname} ${ip}`,
    };
  }

  // Try with www. prefix
  if (!parsed.hostname.startsWith('www.')) {
    const wwwHost = `www.${parsed.hostname}`;
    const wwwIp = await resolveHostname(wwwHost);
    if (wwwIp) {
      const wwwUrl = `${parsed.protocol}//${wwwHost}${parsed.pathname}${parsed.search}`;
      log.info({ original: url, resolved: wwwUrl }, 'using www prefix (bare domain unresolvable)');
      return {
        url: wwwUrl,
        hostRewriteRule: `MAP ${wwwHost} ${wwwIp}`,
      };
    }
  }

  // Nothing resolved — let Puppeteer try (will fail with clear error)
  log.warn({ hostname: parsed.hostname }, 'could not resolve hostname via Google DNS');
  return { url };
}

const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 800;
const MODEL = 'claude-sonnet-4-20250514';

export interface BrowseResult {
  summary: string;
  screenshots: Buffer[];
  steps: number;
  tokensUsed: { input: number; output: number };
}

export interface BrowseOptions {
  task: string;
  startUrl?: string;
  maxSteps?: number;
  timeoutMs?: number;
  onScreenshot?: (screenshot: Buffer, description: string) => Promise<void>;
}

// Mutex: only one browse task at a time
let isBrowsing = false;

/** SSRF protection — block internal/private URLs. */
function validateUrl(url: string): void {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https URLs are allowed');
  }
  const blocked = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.0\.0\.0|::1|\[::1\])/i;
  if (blocked.test(parsed.hostname)) {
    throw new Error('Internal URLs are not allowed');
  }
}

/**
 * Run a Claude Computer Use session.
 * Opens a browser, lets Claude control it step by step, and returns results.
 */
export async function runComputerUse(options: BrowseOptions): Promise<BrowseResult> {
  if (isBrowsing) {
    throw new Error('A browse task is already running. Please wait.');
  }

  const {
    task,
    startUrl,
    maxSteps = 10,
    timeoutMs = 90_000,
    onScreenshot,
  } = options;

  // Validate start URL if provided
  if (startUrl) {
    validateUrl(startUrl);
  }

  isBrowsing = true;
  const startTime = Date.now();
  const screenshots: Buffer[] = [];
  let totalInput = 0;
  let totalOutput = 0;

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;

  // Pre-resolve DNS via Google DNS (Railway container DNS can be unreliable)
  let resolvedStartUrl = startUrl;
  let hostRewriteRule: string | undefined;
  if (startUrl) {
    const resolved = await ensureResolvableUrl(startUrl);
    resolvedStartUrl = resolved.url;
    hostRewriteRule = resolved.hostRewriteRule;
    log.info({ startUrl, resolvedUrl: resolvedStartUrl, hostRewriteRule }, 'DNS pre-resolved');
  }

  const chromiumArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--single-process',
    '--no-zygote',
  ];
  if (hostRewriteRule) {
    chromiumArgs.push(`--host-resolver-rules=${hostRewriteRule}`);
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: chromiumArgs,
    ...(execPath ? { executablePath: execPath } : {}),
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT });

    // Block dangerous navigations
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('file:') || url.startsWith('javascript:') || url.startsWith('data:')) {
        req.abort();
      } else {
        try {
          validateUrl(url);
          req.continue();
        } catch {
          req.abort();
        }
      }
    });
    await page.setRequestInterception(true);

    // Navigate to start URL or about:blank
    if (resolvedStartUrl) {
      await page.goto(resolvedStartUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Take initial screenshot
    const initialScreenshot = await page.screenshot({ type: 'png' });
    const initialBase64 = Buffer.from(initialScreenshot).toString('base64');

    // Build initial messages for Claude
    const messages: any[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Task: ${task}\n\nYou are controlling a browser. Complete the task described above. When done, provide a concise summary of what you found or accomplished. Keep responses in Hebrew when summarizing for the user.`,
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: initialBase64,
            },
          },
        ],
      },
    ];

    let step = 0;

    while (step < maxSteps) {
      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        log.warn({ step, elapsed: Date.now() - startTime }, 'browse timeout reached');
        break;
      }

      step++;

      // Call Claude with computer use tool
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 1024,
        tools: [
          {
            type: 'computer_20250124',
            name: 'computer',
            display_width_px: DISPLAY_WIDTH,
            display_height_px: DISPLAY_HEIGHT,
          },
        ],
        messages,
        betas: ['computer-use-2025-01-24'],
      });

      totalInput += response.usage.input_tokens;
      totalOutput += response.usage.output_tokens;

      // Add assistant response to history
      messages.push({ role: 'assistant', content: response.content });

      // Check if Claude wants to use any tools
      const toolUseBlocks = response.content.filter((b: any) => b.type === 'tool_use');

      if (toolUseBlocks.length === 0) {
        // No tool use — Claude is done, extract summary
        log.info({ step }, 'browse completed — no more tool calls');
        break;
      }

      // Execute each tool call
      const toolResults: any[] = [];

      for (const toolBlock of toolUseBlocks) {
        const { id, input } = toolBlock as any;
        const action = input.action;

        log.info({ step, action, coordinate: input.coordinate }, 'executing action');

        const result = await executeAction(page, action, input);

        if (result.screenshot) {
          const screenshotBuf = Buffer.from(result.screenshot, 'base64');
          screenshots.push(screenshotBuf);

          // Notify boss with progress screenshot
          if (onScreenshot) {
            try {
              await onScreenshot(screenshotBuf, `Step ${step}: ${action}`);
            } catch (err) {
              log.error({ err }, 'failed to send progress screenshot');
            }
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: result.screenshot,
                },
              },
            ],
          });
        } else if (result.error) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: result.error,
            is_error: true,
          });
        }
      }

      // Send tool results back to Claude
      messages.push({ role: 'user', content: toolResults });
    }

    // Extract final summary from Claude's last text response
    let summary = '';
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === 'assistant');
    if (lastAssistant?.content) {
      const textBlocks = Array.isArray(lastAssistant.content)
        ? lastAssistant.content.filter((b: any) => b.type === 'text')
        : [];
      summary = textBlocks.map((b: any) => b.text).join('\n');
    }

    if (!summary) {
      summary = 'המשימה הושלמה אבל לא הוחזר סיכום.';
    }

    log.info(
      { steps: step, screenshots: screenshots.length, totalInput, totalOutput },
      'browse session completed',
    );

    return {
      summary,
      screenshots: screenshots.slice(-3), // Keep last 3 screenshots
      steps: step,
      tokensUsed: { input: totalInput, output: totalOutput },
    };
  } finally {
    await browser.close();
    isBrowsing = false;
  }
}

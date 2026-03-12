/**
 * Maps Claude Computer Use tool actions to Puppeteer page calls.
 */
import type { Page } from 'puppeteer';
import { createLogger } from '../utils/logger.js';

const log = createLogger('puppeteer-actions');

export interface ActionResult {
  screenshot?: string; // base64 PNG
  error?: string;
}

/**
 * Execute a Claude Computer Use action on a Puppeteer page.
 * Returns a screenshot after the action (for most actions).
 */
export async function executeAction(
  page: Page,
  action: string,
  params: Record<string, any>,
): Promise<ActionResult> {
  try {
    switch (action) {
      case 'screenshot': {
        const buf = await page.screenshot({ type: 'png' });
        return { screenshot: Buffer.from(buf).toString('base64') };
      }

      case 'left_click': {
        const [x, y] = params.coordinate;
        await page.mouse.click(x, y);
        await settle(page);
        return takeScreenshot(page);
      }

      case 'double_click': {
        const [x, y] = params.coordinate;
        await page.mouse.click(x, y, { count: 2 });
        await settle(page);
        return takeScreenshot(page);
      }

      case 'right_click': {
        const [x, y] = params.coordinate;
        await page.mouse.click(x, y, { button: 'right' });
        await settle(page);
        return takeScreenshot(page);
      }

      case 'middle_click': {
        const [x, y] = params.coordinate;
        await page.mouse.click(x, y, { button: 'middle' });
        await settle(page);
        return takeScreenshot(page);
      }

      case 'triple_click': {
        const [x, y] = params.coordinate;
        await page.mouse.click(x, y, { count: 3 });
        await settle(page);
        return takeScreenshot(page);
      }

      case 'type': {
        await page.keyboard.type(params.text, { delay: 20 });
        await settle(page);
        return takeScreenshot(page);
      }

      case 'key': {
        const key = params.key as string;
        // Handle combos like "ctrl+a", "shift+enter"
        const parts = key.split('+').map((k) => k.trim());
        if (parts.length > 1) {
          const modifiers = parts.slice(0, -1);
          const mainKey = mapKey(parts[parts.length - 1]);
          for (const mod of modifiers) {
            await page.keyboard.down(mapKey(mod) as any);
          }
          await page.keyboard.press(mainKey as any);
          for (const mod of modifiers.reverse()) {
            await page.keyboard.up(mapKey(mod) as any);
          }
        } else {
          await page.keyboard.press(mapKey(parts[0]) as any);
        }
        await settle(page);
        return takeScreenshot(page);
      }

      case 'scroll': {
        const [sx, sy] = params.coordinate || [640, 400];
        const direction = params.scroll_direction || 'down';
        const amount = params.scroll_amount || 3;
        const deltaY = direction === 'up' ? -amount * 100 : amount * 100;
        const deltaX = direction === 'left' ? -amount * 100 : direction === 'right' ? amount * 100 : 0;
        await page.mouse.move(sx, sy);
        await page.mouse.wheel({ deltaX, deltaY });
        await settle(page);
        return takeScreenshot(page);
      }

      case 'mouse_move': {
        const [x, y] = params.coordinate;
        await page.mouse.move(x, y);
        return takeScreenshot(page);
      }

      case 'left_click_drag': {
        const [startX, startY] = params.start_coordinate;
        const [endX, endY] = params.coordinate;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(endX, endY, { steps: 10 });
        await page.mouse.up();
        await settle(page);
        return takeScreenshot(page);
      }

      case 'cursor_position': {
        // Can't get cursor position from Puppeteer, return screenshot
        return takeScreenshot(page);
      }

      case 'wait': {
        const ms = Math.min((params.duration || 2) * 1000, 5000);
        await new Promise((r) => setTimeout(r, ms));
        return takeScreenshot(page);
      }

      default:
        log.warn({ action }, 'unknown computer use action');
        return { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, action }, 'action execution failed');
    return { error: msg };
  }
}

/** Take a screenshot and return as base64. */
async function takeScreenshot(page: Page): Promise<ActionResult> {
  const buf = await page.screenshot({ type: 'png' });
  return { screenshot: Buffer.from(buf).toString('base64') };
}

/** Wait for page to settle after an action. */
async function settle(page: Page): Promise<void> {
  await new Promise((r) => setTimeout(r, 500));
  try {
    await page.waitForNetworkIdle({ timeout: 2000, idleTime: 500 });
  } catch {
    // timeout is fine — page may have long-polling
  }
}

/** Map Claude key names to Puppeteer key names. */
function mapKey(key: string): string {
  const map: Record<string, string> = {
    ctrl: 'Control',
    control: 'Control',
    alt: 'Alt',
    shift: 'Shift',
    super: 'Meta',
    meta: 'Meta',
    cmd: 'Meta',
    command: 'Meta',
    enter: 'Enter',
    return: 'Enter',
    tab: 'Tab',
    escape: 'Escape',
    esc: 'Escape',
    backspace: 'Backspace',
    delete: 'Delete',
    space: ' ',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    page_up: 'PageUp',
    page_down: 'PageDown',
  };
  return map[key.toLowerCase()] || key;
}

import pino from 'pino';
import { config } from '../config.js';

const level = config.nodeEnv === 'production' ? 'info' : 'debug';

const transport =
  config.nodeEnv !== 'production'
    ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
    : undefined;

export const log = pino({ level }, transport);

export function createLogger(module: string) {
  return log.child({ module });
}

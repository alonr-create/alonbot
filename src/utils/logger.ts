import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

export function createLogger(module: string) {
  return logger.child({ module });
}

export { logger };

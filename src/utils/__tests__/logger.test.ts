import { describe, it, expect } from 'vitest';
import { log, createLogger } from '../logger.js';

describe('Logger', () => {
  it('log is a pino instance with standard methods', () => {
    expect(typeof log.info).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.debug).toBe('function');
  });

  it('createLogger returns a child logger with module field', () => {
    const child = createLogger('test-module');
    expect(typeof child.info).toBe('function');
    expect(typeof child.error).toBe('function');

    // Pino child loggers have bindings that include the module
    const bindings = (child as any).bindings();
    expect(bindings).toHaveProperty('module', 'test-module');
  });

  it('log.info produces structured output (does not throw)', () => {
    expect(() => log.info('test message')).not.toThrow();
    expect(() => log.info({ key: 'value' }, 'test with object')).not.toThrow();
  });
});

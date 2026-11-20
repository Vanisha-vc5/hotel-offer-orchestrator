import type { LogLevel, LogMetadata, Logger as TemporalLogger } from '@temporalio/common';
import type { Logger as PinoLogger } from 'pino';

const LEVELS: Record<LogLevel, 'trace' | 'debug' | 'info' | 'warn' | 'error'> = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};

/**
 * Adapts pino to Temporal's Logger interface so that SDK, workflow (`log` from
 * @temporalio/workflow) and activity logs all end up as structured pino JSON.
 */
export class PinoTemporalLogger implements TemporalLogger {
  constructor(private readonly pino: PinoLogger) {}

  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    // taskToken is a long opaque blob that adds noise without diagnostic value.
    const { taskToken: _taskToken, ...rest } = meta ?? {};
    this.pino[LEVELS[level]](rest, message);
  }
  trace(message: string, meta?: LogMetadata): void {
    this.log('TRACE', message, meta);
  }
  debug(message: string, meta?: LogMetadata): void {
    this.log('DEBUG', message, meta);
  }
  info(message: string, meta?: LogMetadata): void {
    this.log('INFO', message, meta);
  }
  warn(message: string, meta?: LogMetadata): void {
    this.log('WARN', message, meta);
  }
  error(message: string, meta?: LogMetadata): void {
    this.log('ERROR', message, meta);
  }
  flush(): void {
    this.pino.flush();
  }
}

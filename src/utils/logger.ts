import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { createLogger, format, transports } from 'winston';

const logDirectory = path.resolve(process.cwd(), process.env.LOG_DIR ?? 'logs');
mkdirSync(logDirectory, { recursive: true });

const consoleFormat = format.combine(
  format.colorize(),
  format.timestamp(),
  format.printf(({ level, message, timestamp, ...meta }) => {
    const metaText = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}: ${message}${metaText}`;
  }),
);

const fileFormat = format.combine(format.timestamp(), format.json());

/**
 * Migration note:
 * Refactor console.log/error calls in sync, scraping, and AI flows to this logger
 * so background jobs emit structured console output and append to logs/app.log and logs/error.log.
 */
export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: format.combine(format.errors({ stack: true }), format.splat()),
  transports: [
    new transports.Console({
      format: consoleFormat,
    }),
    new transports.File({
      filename: path.join(logDirectory, 'app.log'),
      format: fileFormat,
    }),
    new transports.File({
      filename: path.join(logDirectory, 'error.log'),
      level: 'error',
      format: fileFormat,
    }),
  ],
});

import pino from 'pino';
import { loadEnv } from './env.js';

const env = loadEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } } }
    : {}),
});

export type Logger = typeof logger;

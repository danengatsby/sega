import net from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type RequestLogFilter = 'all' | 'non-2xx' | 'errors-only';

interface LogEntry {
  timestamp: string;
  service: string;
  environment: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

class LogstashTransport {
  private socket: net.Socket | null = null;
  private connected = false;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private queue: string[] = [];

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, env.LOGSTASH_RECONNECT_MS);
  }

  private onSocketClosed(): void {
    this.connected = false;
    this.connecting = false;
    this.socket = null;
    this.scheduleReconnect();
  }

  private flushQueue(): void {
    if (!this.socket || !this.connected) {
      return;
    }

    while (this.queue.length > 0) {
      const line = this.queue.shift();
      if (!line) {
        break;
      }

      const isWritable = this.socket.write(line);
      if (!isWritable) {
        this.queue.unshift(line);
        break;
      }
    }
  }

  private ensureConnected(): void {
    if (!env.LOGSTASH_ENABLED || this.connected || this.connecting) {
      return;
    }

    this.connecting = true;
    const socket = net.createConnection(
      {
        host: env.LOGSTASH_HOST,
        port: env.LOGSTASH_PORT,
      },
      () => {
        this.socket = socket;
        this.connected = true;
        this.connecting = false;
        this.flushQueue();
      },
    );

    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('close', () => {
      this.onSocketClosed();
    });
  }

  send(entry: LogEntry): void {
    if (!env.LOGSTASH_ENABLED) {
      return;
    }

    const line = `${JSON.stringify(entry)}\n`;
    if (this.connected && this.socket) {
      this.socket.write(line);
      return;
    }

    if (this.queue.length >= env.LOGSTASH_MAX_QUEUE) {
      this.queue.shift();
    }
    this.queue.push(line);
    this.ensureConnected();
  }
}

const transport = new LogstashTransport();
const excludedRequestPaths = new Set(
  env.LOG_REQUEST_EXCLUDE_PATHS.split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
);

function baseEntry(level: LogLevel, message: string): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    service: env.LOG_SERVICE_NAME,
    environment: env.NODE_ENV,
    level,
    message,
  };
}

function writeConsole(level: LogLevel, entry: LogEntry): void {
  const payload = JSON.stringify(entry);
  if (level === 'error') {
    console.error(payload);
    return;
  }
  if (level === 'warn') {
    console.warn(payload);
    return;
  }
  console.log(payload);
}

function log(level: LogLevel, message: string, details?: Record<string, unknown>): void {
  const entry: LogEntry = {
    ...baseEntry(level, message),
    ...(details ?? {}),
  };

  writeConsole(level, entry);
  transport.send(entry);
}

export const logger = {
  debug(message: string, details?: Record<string, unknown>): void {
    log('debug', message, details);
  },
  info(message: string, details?: Record<string, unknown>): void {
    log('info', message, details);
  },
  warn(message: string, details?: Record<string, unknown>): void {
    log('warn', message, details);
  },
  error(message: string, details?: Record<string, unknown>): void {
    log('error', message, details);
  },
};

function resolveRequestLogFilter(): RequestLogFilter {
  if (env.LOG_REQUEST_FILTER !== 'auto') {
    return env.LOG_REQUEST_FILTER;
  }

  return env.NODE_ENV === 'production' ? 'all' : 'non-2xx';
}

function requestLogLevel(statusCode: number): LogLevel {
  if (statusCode >= 500) {
    return 'error';
  }
  if (statusCode >= 400) {
    return 'warn';
  }
  return 'info';
}

function shouldLogRequest(path: string, statusCode: number): boolean {
  const pathname = path.split('?')[0] ?? path;
  if (excludedRequestPaths.has(pathname)) {
    return false;
  }

  const filter = resolveRequestLogFilter();
  if (filter === 'all') {
    return true;
  }
  if (filter === 'errors-only') {
    return statusCode >= 400;
  }

  return statusCode < 200 || statusCode >= 300;
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    if (!shouldLogRequest(req.originalUrl, res.statusCode)) {
      return;
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const level = requestLogLevel(res.statusCode);
    logger[level]('http_request', {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(3)),
      ip: req.ip,
      userAgent: req.get('user-agent') ?? null,
      userId: req.user?.id ?? null,
      companyId: req.user?.companyId ?? null,
    });
  });

  next();
}

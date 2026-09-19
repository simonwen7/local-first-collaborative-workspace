import { DEFAULT_DATABASE_PATH } from './operation-store.js';

export const PINO_LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export type PinoLogLevel = (typeof PINO_LOG_LEVELS)[number];

export class InvalidServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidServerConfigError';
  }
}

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly sqlitePath: string;
  readonly logLevel: PinoLogLevel;
  readonly wsMaxPayloadBytes: number;
  readonly wsAllowedOrigins: readonly string[];
  readonly wsHeartbeatIntervalMs: number;
  readonly shutdownTimeoutMs: number;
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  host: '127.0.0.1',
  port: 3001,
  sqlitePath: DEFAULT_DATABASE_PATH,
  logLevel: 'info',
  wsMaxPayloadBytes: 262_144,
  wsAllowedOrigins: [],
  wsHeartbeatIntervalMs: 30_000,
  shutdownTimeoutMs: 10_000,
};

export function parseServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  return {
    host: readString(env.HOST, DEFAULT_SERVER_CONFIG.host),
    port: readPort(env.PORT),
    sqlitePath: readString(env.SQLITE_PATH, DEFAULT_SERVER_CONFIG.sqlitePath),
    logLevel: readLogLevel(env.LOG_LEVEL),
    wsMaxPayloadBytes: readPositiveSafeInteger(
      env.WS_MAX_PAYLOAD_BYTES,
      DEFAULT_SERVER_CONFIG.wsMaxPayloadBytes,
      'WS_MAX_PAYLOAD_BYTES',
    ),
    wsAllowedOrigins: parseAllowedOrigins(env.WS_ALLOWED_ORIGINS),
    wsHeartbeatIntervalMs: readPositiveSafeInteger(
      env.WS_HEARTBEAT_INTERVAL_MS,
      DEFAULT_SERVER_CONFIG.wsHeartbeatIntervalMs,
      'WS_HEARTBEAT_INTERVAL_MS',
    ),
    shutdownTimeoutMs: readPositiveSafeInteger(
      env.SHUTDOWN_TIMEOUT_MS,
      DEFAULT_SERVER_CONFIG.shutdownTimeoutMs,
      'SHUTDOWN_TIMEOUT_MS',
    ),
  };
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const origins: string[] = [];

  for (const part of raw.split(',')) {
    const origin = part.trim();

    if (origin.length === 0 || seen.has(origin)) {
      continue;
    }

    seen.add(origin);
    origins.push(origin);
  }

  return origins;
}

function readString(raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  return raw.trim();
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_SERVER_CONFIG.port;
  }

  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new InvalidServerConfigError(
      `PORT must be an integer between 1 and 65535, received "${raw}".`,
    );
  }

  const port = Number(raw.trim());

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidServerConfigError(
      `PORT must be an integer between 1 and 65535, received "${raw}".`,
    );
  }

  return port;
}

function readLogLevel(raw: string | undefined): PinoLogLevel {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_SERVER_CONFIG.logLevel;
  }

  const level = raw.trim().toLowerCase();

  if ((PINO_LOG_LEVELS as readonly string[]).includes(level)) {
    return level as PinoLogLevel;
  }

  throw new InvalidServerConfigError(
    `LOG_LEVEL must be one of ${PINO_LOG_LEVELS.join(', ')}, received "${raw}".`,
  );
}

function readPositiveSafeInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new InvalidServerConfigError(
      `${name} must be a positive safe integer, received "${raw}".`,
    );
  }

  const value = Number(raw.trim());

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidServerConfigError(
      `${name} must be a positive safe integer, received "${raw}".`,
    );
  }

  return value;
}

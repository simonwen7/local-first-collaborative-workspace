import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVER_CONFIG,
  InvalidServerConfigError,
  parseAllowedOrigins,
  parseServerConfig,
} from '../src/config.js';
import { DEFAULT_DATABASE_PATH } from '../src/operation-store.js';

describe('parseServerConfig', () => {
  it('uses conservative developer defaults', () => {
    expect(parseServerConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3001,
      sqlitePath: DEFAULT_DATABASE_PATH,
      logLevel: 'info',
      wsMaxPayloadBytes: 262_144,
      wsAllowedOrigins: [],
      wsHeartbeatIntervalMs: 30_000,
      shutdownTimeoutMs: 10_000,
    });
    expect(DEFAULT_SERVER_CONFIG.host).toBe('127.0.0.1');
  });

  it('accepts valid overrides', () => {
    expect(
      parseServerConfig({
        HOST: '0.0.0.0',
        PORT: '8080',
        SQLITE_PATH: '/data/lfcw.sqlite',
        LOG_LEVEL: 'debug',
        WS_MAX_PAYLOAD_BYTES: '1024',
        WS_ALLOWED_ORIGINS: ' https://workspace.example.com, https://app.example.com ',
        WS_HEARTBEAT_INTERVAL_MS: '15000',
        SHUTDOWN_TIMEOUT_MS: '2500',
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 8080,
      sqlitePath: '/data/lfcw.sqlite',
      logLevel: 'debug',
      wsMaxPayloadBytes: 1024,
      wsAllowedOrigins: ['https://workspace.example.com', 'https://app.example.com'],
      wsHeartbeatIntervalMs: 15_000,
      shutdownTimeoutMs: 2500,
    });
  });

  it('rejects a non-integer PORT instead of coercing it to NaN', () => {
    expect(() => parseServerConfig({ PORT: 'abc' })).toThrow(InvalidServerConfigError);
    expect(() => parseServerConfig({ PORT: '3001.5' })).toThrow(/PORT must be an integer/);
    expect(() => parseServerConfig({ PORT: '0x10' })).toThrow(InvalidServerConfigError);
  });

  it('rejects PORT values outside 1..65535', () => {
    expect(() => parseServerConfig({ PORT: '0' })).toThrow(InvalidServerConfigError);
    expect(() => parseServerConfig({ PORT: '65536' })).toThrow(InvalidServerConfigError);
    expect(() => parseServerConfig({ PORT: '-1' })).toThrow(InvalidServerConfigError);
  });

  it('rejects an invalid log level', () => {
    expect(() => parseServerConfig({ LOG_LEVEL: 'verbose' })).toThrow(InvalidServerConfigError);
  });

  it('accepts normal Fastify/Pino log levels', () => {
    expect(parseServerConfig({ LOG_LEVEL: 'WARN' }).logLevel).toBe('warn');
    expect(parseServerConfig({ LOG_LEVEL: 'silent' }).logLevel).toBe('silent');
  });

  it('rejects invalid max payload, heartbeat, and shutdown values', () => {
    expect(() => parseServerConfig({ WS_MAX_PAYLOAD_BYTES: '0' })).toThrow(
      InvalidServerConfigError,
    );
    expect(() => parseServerConfig({ WS_MAX_PAYLOAD_BYTES: 'nope' })).toThrow(
      InvalidServerConfigError,
    );
    expect(() => parseServerConfig({ WS_HEARTBEAT_INTERVAL_MS: '0' })).toThrow(
      InvalidServerConfigError,
    );
    expect(() => parseServerConfig({ WS_HEARTBEAT_INTERVAL_MS: '1.5' })).toThrow(
      InvalidServerConfigError,
    );
    expect(() => parseServerConfig({ SHUTDOWN_TIMEOUT_MS: '0' })).toThrow(InvalidServerConfigError);
    expect(() => parseServerConfig({ SHUTDOWN_TIMEOUT_MS: '-10' })).toThrow(
      InvalidServerConfigError,
    );
  });

  it('does not read or mutate the real process.env object', () => {
    const env = { PORT: '4000' };
    expect(parseServerConfig(env).port).toBe(4000);
    expect(env).toEqual({ PORT: '4000' });
  });
});

describe('parseAllowedOrigins', () => {
  it('treats empty or whitespace input as filtering disabled', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('   ')).toEqual([]);
  });

  it('trims and deduplicates comma-separated exact origins', () => {
    expect(
      parseAllowedOrigins(
        'https://a.example, https://b.example,https://a.example, , https://c.example',
      ),
    ).toEqual(['https://a.example', 'https://b.example', 'https://c.example']);
  });
});

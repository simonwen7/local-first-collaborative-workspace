import { describe, expect, it } from 'vitest';
import { DEFAULT_DEV_SYNC_URL, InvalidSyncUrlError, resolveSyncUrl } from '../src/sync/sync-url';

describe('resolveSyncUrl', () => {
  it('uses a valid VITE_SYNC_URL override', () => {
    expect(
      resolveSyncUrl({
        configured: 'wss://sync.example.com/sync',
        isDev: false,
        location: { protocol: 'https:', host: 'workspace.example.com' },
      }),
    ).toBe('wss://sync.example.com/sync');
  });

  it('rejects a configured URL that is not ws: or wss:', () => {
    expect(() =>
      resolveSyncUrl({
        configured: 'https://sync.example.com/sync',
        isDev: true,
      }),
    ).toThrow(InvalidSyncUrlError);

    expect(() =>
      resolveSyncUrl({
        configured: 'not a url',
        isDev: false,
      }),
    ).toThrow(/ws: or wss:/);
  });

  it('preserves the local development default when unconfigured', () => {
    expect(resolveSyncUrl({ isDev: true })).toBe(DEFAULT_DEV_SYNC_URL);
  });

  it('derives a same-origin production URL', () => {
    expect(
      resolveSyncUrl({
        isDev: false,
        location: { protocol: 'https:', host: 'workspace.example.com' },
      }),
    ).toBe('wss://workspace.example.com/sync');

    expect(
      resolveSyncUrl({
        isDev: false,
        location: { protocol: 'http:', host: '127.0.0.1:4173' },
      }),
    ).toBe('ws://127.0.0.1:4173/sync');
  });
});

import { describe, expect, it } from 'vitest';
import { deriveNetworkControl } from '../src/sync/network-control';

describe('deriveNetworkControl', () => {
  it('offers Go Offline only while the socket is online', () => {
    const view = deriveNetworkControl({
      suspended: false,
      status: 'online',
      unreachable: false,
    });

    expect(view.statusLabel).toBe('Sync: Online');
    expect(view.actionKind).toBe('go-offline');
    expect(view.actionLabel).toBe('Go Offline');
    expect(view.actionEnabled).toBe(true);
  });

  it('treats operator suspend as intentional offline with Reconnect', () => {
    const view = deriveNetworkControl({
      suspended: true,
      status: 'offline',
      unreachable: false,
    });

    expect(view.statusLabel).toBe('Sync: Offline');
    expect(view.actionKind).toBe('reconnect');
    expect(view.actionLabel).toBe('Reconnect');
    expect(view.intentionallyOffline).toBe(true);
  });

  it('never offers Go Offline while suspended, even if status is stale', () => {
    for (const status of ['offline', 'connecting', 'syncing', 'error', 'online'] as const) {
      const view = deriveNetworkControl({
        suspended: true,
        status,
        unreachable: false,
      });

      expect(view.actionKind).not.toBe('go-offline');
      expect(view.actionLabel).not.toBe('Go Offline');
      expect(view.statusLabel).toBe('Sync: Offline');
    }
  });

  it('shows reconnecting and catching-up as disabled wait states', () => {
    const reconnecting = deriveNetworkControl({
      suspended: false,
      status: 'connecting',
      unreachable: false,
    });
    expect(reconnecting.statusLabel).toBe('Sync: Reconnecting');
    expect(reconnecting.actionEnabled).toBe(false);
    expect(reconnecting.actionKind).toBe('idle');
    expect(reconnecting.actionLabel).not.toBe('Go Offline');

    const catchingUp = deriveNetworkControl({
      suspended: false,
      status: 'syncing',
      unreachable: false,
    });
    expect(catchingUp.statusLabel).toBe('Sync: Catching up');
    expect(catchingUp.actionEnabled).toBe(false);
    expect(catchingUp.actionLabel).not.toBe('Go Offline');
  });

  it('treats an unexpected drop as Retry Connection, not Go Offline', () => {
    const disconnected = deriveNetworkControl({
      suspended: false,
      status: 'offline',
      unreachable: false,
    });
    expect(disconnected.statusLabel).toBe('Sync: Disconnected');
    expect(disconnected.actionKind).toBe('retry');
    expect(disconnected.actionLabel).toBe('Retry Connection');
    expect(disconnected.intentionallyOffline).toBe(false);

    const unreachable = deriveNetworkControl({
      suspended: false,
      status: 'offline',
      unreachable: true,
    });
    expect(unreachable.statusLabel).toBe('Sync: Unreachable');
    expect(unreachable.actionKind).toBe('retry');
    expect(unreachable.actionLabel).toBe('Retry Connection');

    const errored = deriveNetworkControl({
      suspended: false,
      status: 'error',
      unreachable: false,
    });
    expect(errored.actionKind).toBe('retry');
    expect(errored.actionLabel).toBe('Retry Connection');
    expect(errored.actionLabel).not.toBe('Go Offline');
  });
});

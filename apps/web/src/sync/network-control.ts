import type { SyncStatus } from './document-sync-client';

/**
 * The network *action* is derived from two independent facts:
 *
 *   1. `suspended` — the operator asked this replica to stay offline
 *   2. `status`    — what the WebSocket is actually doing
 *
 * Those two used to drive different parts of the chrome independently, which
 * is how "Sync: Offline" could sit next to a button that still said
 * "Go Offline". The rule below is the invariant the UI must keep:
 *
 *   Go Offline is offered only while the socket is online.
 */
export type NetworkActionKind = 'go-offline' | 'reconnect' | 'retry' | 'idle';

export type NetworkStatusTone = 'ok' | 'busy' | 'idle' | 'bad';

export interface NetworkControlInput {
  readonly suspended: boolean;
  readonly status: SyncStatus;
  readonly unreachable: boolean;
}

export interface NetworkControlView {
  readonly statusLabel: string;
  readonly statusTone: NetworkStatusTone;
  readonly actionKind: NetworkActionKind;
  readonly actionLabel: string;
  readonly actionEnabled: boolean;
  readonly intentionallyOffline: boolean;
  readonly disconnected: boolean;
  readonly catchingUp: boolean;
}

export function deriveNetworkControl(input: NetworkControlInput): NetworkControlView {
  if (input.suspended) {
    return {
      statusLabel: 'Sync: Offline',
      statusTone: 'idle',
      actionKind: 'reconnect',
      actionLabel: 'Reconnect',
      actionEnabled: true,
      intentionallyOffline: true,
      disconnected: true,
      catchingUp: false,
    };
  }

  switch (input.status) {
    case 'online':
      return {
        statusLabel: 'Sync: Online',
        statusTone: 'ok',
        actionKind: 'go-offline',
        actionLabel: 'Go Offline',
        actionEnabled: true,
        intentionallyOffline: false,
        disconnected: false,
        catchingUp: false,
      };
    case 'syncing':
      return {
        statusLabel: 'Sync: Catching up',
        statusTone: 'busy',
        actionKind: 'idle',
        actionLabel: 'Reconnect',
        actionEnabled: false,
        intentionallyOffline: false,
        disconnected: false,
        catchingUp: true,
      };
    case 'connecting':
      return {
        statusLabel: 'Sync: Reconnecting',
        statusTone: 'busy',
        actionKind: 'idle',
        actionLabel: 'Reconnect',
        actionEnabled: false,
        intentionallyOffline: false,
        disconnected: true,
        catchingUp: true,
      };
    case 'error':
    case 'offline':
      return {
        statusLabel: input.unreachable ? 'Sync: Unreachable' : 'Sync: Disconnected',
        statusTone: input.unreachable ? 'bad' : 'idle',
        actionKind: 'retry',
        actionLabel: 'Retry Connection',
        actionEnabled: true,
        intentionallyOffline: false,
        disconnected: true,
        catchingUp: false,
      };
  }
}

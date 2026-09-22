import type { PresenceParticipant } from '@lfcw/protocol';
import type { NetworkControlView } from '../sync/network-control';
import { Icon } from '../ui/Icon';

export type SaveState = 'loading' | 'saved' | 'saving' | 'error';

interface TopbarProps {
  readonly saveState: SaveState;
  readonly network: NetworkControlView;
  readonly pendingCount: number;
  readonly participants: readonly PresenceParticipant[];
  readonly selfClientId: string | null;
  readonly busy: boolean;
  readonly inspectorOpen: boolean;
  readonly demoActive: boolean;
  readonly onNetworkAction: () => void;
  readonly onShare: () => void;
  readonly onLaunchDemo: () => void;
  readonly onToggleInspector: () => void;
}

export function Topbar({
  saveState,
  network,
  pendingCount,
  participants,
  selfClientId,
  busy,
  inspectorOpen,
  demoActive,
  onNetworkAction,
  onShare,
  onLaunchDemo,
  onToggleInspector,
}: TopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar__lead">
        <div className={`pill ${saveTone(saveState)}`} aria-live="polite">
          <span className="pill__dot" aria-hidden="true" />
          <span className="pill__label">{saveStateLabel(saveState)}</span>
        </div>

        <div className={`pill ${syncTone(network.statusTone)}`} aria-live="polite">
          <span className="pill__dot" aria-hidden="true" />
          {/* The label is its own node so the status string stays exact even
              when the queued-operation badge is present. */}
          <span className="pill__label">{network.statusLabel}</span>
          {pendingCount > 0 ? (
            <span className="pill__count" title="Operations queued in the durable outbox">
              {pendingCount}
            </span>
          ) : null}
        </div>
      </div>

      <Presence participants={participants} selfClientId={selfClientId} />

      <span className="topbar__divider" aria-hidden="true" />

      <div className="topbar__group">
        <button
          type="button"
          className={network.actionKind === 'go-offline' ? 'btn' : 'btn btn--primary'}
          disabled={busy || !network.actionEnabled}
          onClick={onNetworkAction}
        >
          <Icon name={network.actionKind === 'go-offline' ? 'offline' : 'online'} size={14} />
          {network.actionLabel}
        </button>

        <button type="button" className="btn" disabled={busy} onClick={onShare}>
          <Icon name="link" size={14} />
          Share Link
        </button>

        {demoActive ? null : (
          <button type="button" className="btn btn--primary" disabled={busy} onClick={onLaunchDemo}>
            <Icon name="play" size={13} />
            Launch Demo
          </button>
        )}

        <button
          type="button"
          className="btn btn--ghost btn--icon"
          aria-pressed={inspectorOpen}
          aria-label={inspectorOpen ? 'Hide Live Sync panel' : 'Show Live Sync panel'}
          title="Live Sync"
          onClick={onToggleInspector}
        >
          <Icon name="activity" size={15} />
        </button>
      </div>
    </header>
  );
}

function Presence({
  participants,
  selfClientId,
}: {
  readonly participants: readonly PresenceParticipant[];
  readonly selfClientId: string | null;
}) {
  if (participants.length === 0) {
    return null;
  }

  return (
    <div className="presence" title="Ephemeral room presence (never persisted)">
      <div className="presence__stack">
        {participants.slice(0, 4).map((participant) => (
          <span
            key={participant.clientId}
            className="presence__avatar"
            style={{ background: avatarColor(participant.clientId) }}
            title={
              participant.clientId === selfClientId
                ? `${participant.displayName} (you)`
                : participant.displayName
            }
          >
            {initials(participant.displayName)}
          </span>
        ))}
      </div>
      <span className="presence__label">
        {participants.length === 1 ? '1 replica online' : `${participants.length} replicas online`}
      </span>
    </div>
  );
}

export function initials(displayName: string): string {
  const words = displayName
    .replace(/[()]/g, '')
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word));

  if (words.length === 0) {
    return '??';
  }

  if (words.length === 1) {
    return (words[0] ?? '').slice(0, 2).toUpperCase();
  }

  return `${(words[0] ?? '').charAt(0)}${(words[1] ?? '').charAt(0)}`.toUpperCase();
}

export function avatarColor(seed: string): string {
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 360;
  }

  return `hsl(${String(hash)} 62% 68%)`;
}

export function saveStateLabel(state: SaveState): string {
  switch (state) {
    case 'loading':
      return 'Local: Loading…';
    case 'saving':
      return 'Local: Saving';
    case 'saved':
      return 'Local: Saved';
    case 'error':
      return 'Local: Error';
  }
}

function saveTone(state: SaveState): string {
  switch (state) {
    case 'saved':
      return 'pill--ok';
    case 'saving':
    case 'loading':
      return 'pill--busy';
    case 'error':
      return 'pill--bad';
  }
}

function syncTone(tone: NetworkControlView['statusTone']): string {
  switch (tone) {
    case 'ok':
      return 'pill--ok';
    case 'busy':
      return 'pill--busy';
    case 'bad':
      return 'pill--bad';
    case 'idle':
      return 'pill--idle';
  }
}

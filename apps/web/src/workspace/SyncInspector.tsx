import { useEffect, useState } from 'react';
import type { PresenceParticipant } from '@lfcw/protocol';
import {
  PIPELINE_STAGES,
  PIPELINE_STAGE_DETAILS,
  PIPELINE_STAGE_LABELS,
} from '../telemetry/sync-telemetry';
import type { PipelineStage, SyncTelemetryEvent } from '../telemetry/sync-telemetry';
import type { SyncStatus } from '../sync/document-sync-client';
import type { NetworkControlView } from '../sync/network-control';
import { Icon } from '../ui/Icon';
import { shortId } from './WorkspaceSidebar';

/** How long a stage keeps its "just fired" treatment after a real event. */
const ACTIVE_WINDOW_MS = 1100;

interface SyncInspectorProps {
  readonly syncStatus: SyncStatus;
  readonly network: NetworkControlView;
  readonly pendingCount: number;
  readonly lastServerSeq: number;
  readonly documentId: string | null;
  readonly clientId: string | null;
  readonly knownOperationCount: number;
  readonly participants: readonly PresenceParticipant[];
  readonly events: readonly SyncTelemetryEvent[];
  readonly onClose: () => void;
}

export function SyncInspector({
  syncStatus,
  network,
  pendingCount,
  lastServerSeq,
  documentId,
  clientId,
  knownOperationCount,
  participants,
  events,
  onClose,
}: SyncInspectorProps) {
  const activeStages = useActiveStages(events);
  const reachedStages = new Set(events.map((event) => event.stage));
  const converged = pendingCount === 0 && syncStatus === 'online';
  const latest = events.at(0);

  return (
    <aside className="inspector" aria-label="Live Sync">
      <div className="inspector__head">
        <h2 className="inspector__heading">
          <span
            className="inspector__live"
            style={converged ? undefined : { background: 'var(--warn)', boxShadow: 'none' }}
            aria-hidden="true"
          />
          Live Sync
        </h2>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          aria-label="Hide Live Sync panel"
          onClick={onClose}
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="inspector__body">
        <section className="inspector__block">
          <div className="stats">
            <div className="stat">
              <div className="stat__key">Local</div>
              <div className="stat__value stat__value--ok">Saved</div>
            </div>
            <div className="stat">
              <div className="stat__key">Network</div>
              <div className={`stat__value ${inspectorTone(network)}`}>
                {inspectorNetworkLabel(network)}
              </div>
            </div>
            <div className="stat">
              <div className="stat__key">Pending ops</div>
              <div
                className={`stat__value ${pendingCount > 0 ? 'stat__value--busy' : 'stat__value--ok'}`}
              >
                {pendingCount}
              </div>
            </div>
            <div className="stat">
              <div className="stat__key">Server seq</div>
              <div className="stat__value">{lastServerSeq}</div>
            </div>
            <div className="stat stat--wide">
              <div className="stat__key">Known operations in replica</div>
              <div className="stat__value">{knownOperationCount.toLocaleString()}</div>
            </div>
            <div className="stat stat--wide">
              <div className="stat__key">Identity</div>
              <div className="stat__mono">
                {clientId ? shortId(clientId) : '—'} · {documentId ? shortId(documentId) : '—'}
              </div>
            </div>
          </div>
        </section>

        <section className="inspector__block">
          <div className="inspector__block-head">
            <p className="eyebrow">Pipeline</p>
            <span className="sidebar__count">
              {latest ? formatClock(latest.at) : 'awaiting activity'}
            </span>
          </div>

          <div className="pipeline">
            {PIPELINE_STAGES.map((stage, index) => (
              <Stage
                key={stage}
                stage={stage}
                last={index === PIPELINE_STAGES.length - 1}
                reached={reachedStages.has(stage)}
                active={activeStages.has(stage)}
                settled={stage === 'converged' && converged}
                meta={stageMeta(stage, {
                  pendingCount,
                  lastServerSeq,
                  knownOperationCount,
                })}
              />
            ))}
          </div>
        </section>

        <section className="inspector__block">
          <div className="inspector__block-head">
            <p className="eyebrow">Participants</p>
            <span className="sidebar__count">{participants.length}</span>
          </div>

          {participants.length === 0 ? (
            <p className="inspector__empty">
              No room presence. Presence is ephemeral and requires an open socket.
            </p>
          ) : (
            <div className="events">
              {participants.map((participant) => (
                <div key={participant.clientId} className="event">
                  <span className="event__time" aria-hidden="true">
                    <Icon name="users" size={11} />
                  </span>
                  <div className="event__body">
                    <div className="event__stage">
                      {participant.displayName}
                      {participant.clientId === clientId ? (
                        <span className="event__self">you</span>
                      ) : null}
                    </div>
                    <div className="event__message mono">{shortId(participant.clientId)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="inspector__block">
          <div className="inspector__block-head">
            <p className="eyebrow">Recent activity</p>
            <span className="sidebar__count">{events.length}</span>
          </div>

          {events.length === 0 ? (
            <p className="inspector__empty">
              Start typing. Every entry here is emitted by the real persistence and synchronization
              layers.
            </p>
          ) : (
            <div className="events">
              {events.map((event) => (
                <div key={event.id} className="event">
                  <span className="event__time">{formatClock(event.at)}</span>
                  <div className="event__body">
                    <div className="event__stage">{PIPELINE_STAGE_LABELS[event.stage]}</div>
                    <div className="event__message">{event.message}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function Stage({
  stage,
  last,
  reached,
  active,
  settled,
  meta,
}: {
  readonly stage: PipelineStage;
  readonly last: boolean;
  readonly reached: boolean;
  readonly active: boolean;
  readonly settled: boolean;
  readonly meta: string | null;
}) {
  const classes = ['stage'];

  if (reached) {
    classes.push('stage--reached');
  }

  if (active) {
    classes.push('stage--active');
  }

  if (settled) {
    classes.push('stage--settled');
  }

  return (
    <div className={classes.join(' ')}>
      <div className="stage__rail">
        <span className="stage__node" aria-hidden="true">
          <span className="stage__node-dot" />
        </span>
        {last ? null : <span className="stage__line" aria-hidden="true" />}
      </div>
      <div className="stage__text">
        <div className="stage__head">
          <span className="stage__label">{PIPELINE_STAGE_LABELS[stage]}</span>
          {meta ? <span className="stage__meta">{meta}</span> : null}
        </div>
        <p className="stage__detail">{PIPELINE_STAGE_DETAILS[stage]}</p>
      </div>
    </div>
  );
}

/**
 * Track which stages fired recently. Driven entirely by real telemetry events;
 * the timer only controls how long the highlight lingers.
 */
function useActiveStages(events: readonly SyncTelemetryEvent[]): Set<PipelineStage> {
  const latest = events.at(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!latest) {
      return;
    }

    const timer = setTimeout(() => {
      setTick((value) => value + 1);
    }, ACTIVE_WINDOW_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [latest]);

  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  const active = new Set<PipelineStage>();

  for (const event of events) {
    if (event.at < cutoff) {
      break;
    }

    active.add(event.stage);
  }

  return active;
}

function stageMeta(
  stage: PipelineStage,
  values: {
    readonly pendingCount: number;
    readonly lastServerSeq: number;
    readonly knownOperationCount: number;
  },
): string | null {
  switch (stage) {
    case 'indexeddb':
      return `${values.knownOperationCount.toLocaleString()} ops`;
    case 'outbox':
      return `${String(values.pendingCount)} queued`;
    case 'server-log':
      return `seq ${String(values.lastServerSeq)}`;
    default:
      return null;
  }
}

function inspectorNetworkLabel(network: NetworkControlView): string {
  if (network.intentionallyOffline) {
    return 'Offline';
  }

  if (network.catchingUp) {
    return network.statusLabel.replace(/^Sync: /, '');
  }

  if (network.disconnected) {
    return network.statusLabel.replace(/^Sync: /, '');
  }

  return 'Online';
}

function inspectorTone(network: NetworkControlView): string {
  switch (network.statusTone) {
    case 'ok':
      return 'stat__value--ok';
    case 'busy':
      return 'stat__value--busy';
    case 'bad':
      return 'stat__value--bad';
    case 'idle':
      return '';
  }
}

function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

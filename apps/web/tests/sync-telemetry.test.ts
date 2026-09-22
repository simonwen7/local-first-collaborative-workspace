import { describe, expect, it, vi } from 'vitest';
import {
  PIPELINE_STAGES,
  PIPELINE_STAGE_DETAILS,
  PIPELINE_STAGE_LABELS,
  SyncTelemetry,
} from '../src/telemetry/sync-telemetry';

describe('SyncTelemetry', () => {
  it('delivers events with monotonically increasing ids to every subscriber', () => {
    const telemetry = new SyncTelemetry();
    const first = vi.fn();
    const second = vi.fn();

    telemetry.subscribe(first);
    telemetry.subscribe(second);

    telemetry.emit({ stage: 'local-edit', documentId: 'doc', message: 'one', count: 2 });
    telemetry.emit({ stage: 'ack', documentId: 'doc', message: 'two', serverSeq: 7 });

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);

    const [firstEvent] = first.mock.calls[0] ?? [];
    const [secondEvent] = first.mock.calls[1] ?? [];

    expect(firstEvent).toMatchObject({ id: 1, stage: 'local-edit', count: 2 });
    expect(secondEvent).toMatchObject({ id: 2, stage: 'ack', serverSeq: 7 });
    expect(firstEvent).not.toHaveProperty('serverSeq');
  });

  it('stops delivering after unsubscribe', () => {
    const telemetry = new SyncTelemetry();
    const listener = vi.fn();
    const unsubscribe = telemetry.subscribe(listener);

    telemetry.emit({ stage: 'outbox', documentId: 'doc', message: 'queued' });
    unsubscribe();
    telemetry.emit({ stage: 'outbox', documentId: 'doc', message: 'queued again' });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('tolerates a subscriber unsubscribing during delivery', () => {
    const telemetry = new SyncTelemetry();
    const later = vi.fn();
    const unsubscribeSelf = telemetry.subscribe(() => {
      unsubscribeSelf();
    });
    telemetry.subscribe(later);

    expect(() => {
      telemetry.emit({ stage: 'converged', documentId: 'doc', message: 'done' });
    }).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('labels and describes every pipeline stage', () => {
    for (const stage of PIPELINE_STAGES) {
      expect(PIPELINE_STAGE_LABELS[stage]).toBeTruthy();
      expect(PIPELINE_STAGE_DETAILS[stage]).toBeTruthy();
    }

    expect(PIPELINE_STAGES.at(0)).toBe('local-edit');
    expect(PIPELINE_STAGES.at(-1)).toBe('converged');
  });
});

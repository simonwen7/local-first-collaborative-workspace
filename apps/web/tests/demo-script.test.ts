import { describe, expect, it } from 'vitest';
import {
  DEMO_STEPS,
  demoReconnectPhase,
  findDemoStep,
  isDemoActionPending,
  isDemoStepSatisfied,
  nextDemoStep,
} from '../src/demo/demo-script';
import type { DemoProgressInput } from '../src/demo/demo-script';

const base: DemoProgressInput = {
  step: 'local',
  localEditCount: 0,
  offlineEditCount: 0,
  pendingCount: 0,
  syncStatus: 'online',
  suspended: false,
  unreachable: false,
  collaboratorStarted: false,
  collaboratorDone: false,
};

describe('guided demo progression', () => {
  it('walks every step exactly once and terminates', () => {
    const visited: string[] = [];
    let step = DEMO_STEPS[0]?.id;

    while (step) {
      visited.push(step);
      step = nextDemoStep(step) ?? undefined;
    }

    expect(visited).toEqual(DEMO_STEPS.map((candidate) => candidate.id));
    expect(nextDemoStep('done')).toBeNull();
  });

  it('exposes a label and hint for every step', () => {
    for (const step of DEMO_STEPS) {
      expect(findDemoStep(step.id)).toBe(step);
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.hint.length).toBeGreaterThan(0);
    }

    expect(findDemoStep('reconnect').action).toBe('Reconnect & Continue');
    expect(() => findDemoStep('nope' as never)).toThrow();
  });

  it('gates the local step on real local edits', () => {
    expect(isDemoStepSatisfied({ ...base, step: 'local', localEditCount: 2 })).toBe(false);
    expect(isDemoStepSatisfied({ ...base, step: 'local', localEditCount: 3 })).toBe(true);
  });

  it('requires intentional suspend plus an offline edit for step 2', () => {
    expect(
      isDemoStepSatisfied({ ...base, step: 'offline', suspended: false, offlineEditCount: 1 }),
    ).toBe(false);
    expect(
      isDemoStepSatisfied({ ...base, step: 'offline', suspended: true, offlineEditCount: 0 }),
    ).toBe(false);
    expect(
      isDemoStepSatisfied({ ...base, step: 'offline', suspended: true, offlineEditCount: 1 }),
    ).toBe(true);
    expect(isDemoActionPending({ ...base, step: 'offline', suspended: false })).toBe(true);
    expect(isDemoActionPending({ ...base, step: 'offline', suspended: true })).toBe(false);
  });

  it('gates reconnect on a genuinely drained outbox after leaving suspend', () => {
    expect(
      isDemoStepSatisfied({
        ...base,
        step: 'reconnect',
        pendingCount: 2,
        syncStatus: 'syncing',
        suspended: false,
      }),
    ).toBe(false);
    expect(
      isDemoStepSatisfied({
        ...base,
        step: 'reconnect',
        pendingCount: 0,
        syncStatus: 'syncing',
        suspended: false,
      }),
    ).toBe(false);
    expect(
      isDemoStepSatisfied({
        ...base,
        step: 'reconnect',
        pendingCount: 0,
        syncStatus: 'online',
        suspended: true,
      }),
    ).toBe(false);
    expect(
      isDemoStepSatisfied({
        ...base,
        step: 'reconnect',
        pendingCount: 0,
        syncStatus: 'online',
        suspended: false,
      }),
    ).toBe(true);
  });

  it('keeps the reconnect action pending only while still suspended', () => {
    expect(isDemoActionPending({ ...base, step: 'reconnect', suspended: true })).toBe(true);
    expect(isDemoActionPending({ ...base, step: 'reconnect', suspended: false })).toBe(false);
  });

  it('does not treat a failed reconnect as convergence', () => {
    const failed: DemoProgressInput = {
      ...base,
      step: 'reconnect',
      pendingCount: 345,
      syncStatus: 'offline',
      suspended: false,
      unreachable: true,
    };

    expect(isDemoStepSatisfied(failed)).toBe(false);
    expect(demoReconnectPhase(failed)).toBe('failed');
    expect(isDemoActionPending(failed)).toBe(false);
  });

  it('shows catching-up while the outbox is draining', () => {
    expect(
      demoReconnectPhase({
        ...base,
        step: 'reconnect',
        pendingCount: 12,
        syncStatus: 'syncing',
        suspended: false,
      }),
    ).toBe('catching-up');
    expect(
      demoReconnectPhase({
        ...base,
        step: 'reconnect',
        pendingCount: 0,
        syncStatus: 'online',
        suspended: false,
      }),
    ).toBe('converged');
    expect(
      demoReconnectPhase({
        ...base,
        step: 'reconnect',
        suspended: true,
        syncStatus: 'offline',
        pendingCount: 12,
      }),
    ).toBe('action');
  });

  it('gates the collaboration step on the second replica finishing', () => {
    expect(isDemoActionPending({ ...base, step: 'collaborate', collaboratorStarted: false })).toBe(
      true,
    );
    expect(isDemoStepSatisfied({ ...base, step: 'collaborate', collaboratorDone: false })).toBe(
      false,
    );
    expect(isDemoStepSatisfied({ ...base, step: 'collaborate', collaboratorDone: true })).toBe(
      true,
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEMO_STEPS,
  findDemoStep,
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

    expect(() => findDemoStep('nope' as never)).toThrow();
  });

  it('gates the local step on real local edits', () => {
    expect(isDemoStepSatisfied({ ...base, step: 'local', localEditCount: 2 })).toBe(false);
    expect(isDemoStepSatisfied({ ...base, step: 'local', localEditCount: 3 })).toBe(true);
  });

  it('gates the offline step on an edit made while disconnected', () => {
    expect(isDemoStepSatisfied({ ...base, step: 'offline', offlineEditCount: 0 })).toBe(false);
    expect(isDemoStepSatisfied({ ...base, step: 'offline', offlineEditCount: 1 })).toBe(true);
  });

  it('gates the reconnect step on a genuinely drained outbox', () => {
    expect(
      isDemoStepSatisfied({ ...base, step: 'reconnect', pendingCount: 2, syncStatus: 'syncing' }),
    ).toBe(false);
    expect(
      isDemoStepSatisfied({ ...base, step: 'reconnect', pendingCount: 0, syncStatus: 'syncing' }),
    ).toBe(false);
    expect(
      isDemoStepSatisfied({ ...base, step: 'reconnect', pendingCount: 0, syncStatus: 'online' }),
    ).toBe(true);
  });

  it('gates the collaboration step on the second replica finishing', () => {
    expect(isDemoStepSatisfied({ ...base, step: 'collaborate', collaboratorDone: false })).toBe(
      false,
    );
    expect(isDemoStepSatisfied({ ...base, step: 'collaborate', collaboratorDone: true })).toBe(
      true,
    );
  });
});

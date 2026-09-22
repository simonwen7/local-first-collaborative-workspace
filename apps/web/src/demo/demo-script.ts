import type { SyncStatus } from '../sync/document-sync-client';

export type DemoStepId = 'intro' | 'local' | 'offline' | 'reconnect' | 'collaborate' | 'done';

export interface DemoStep {
  readonly id: DemoStepId;
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  /** Label for the primary button, or null when the step advances on its own. */
  readonly action: string | null;
  readonly hint: string;
}

export const DEMO_STEPS: readonly DemoStep[] = [
  {
    id: 'intro',
    eyebrow: 'Guided tour · 60 seconds',
    title: 'Edit anywhere. Even offline.',
    body: 'Every keystroke becomes a CRDT operation that is written to IndexedDB before the network is ever involved. This tour uses the real system: real storage, a real socket, a real server log.',
    action: 'Start the tour',
    hint: 'Nothing here is simulated.',
  },
  {
    id: 'local',
    eyebrow: 'Step 1 of 4 · Local first',
    title: 'Type something in the editor',
    body: 'Watch the pipeline on the right. Your keystrokes are diffed into grapheme-level operations, committed to IndexedDB, and only then queued for the server.',
    action: null,
    hint: 'Type at least a few characters to continue.',
  },
  {
    id: 'offline',
    eyebrow: 'Step 2 of 4 · Partition',
    title: 'Now cut the network',
    body: 'This closes the actual WebSocket. Keep typing: edits still commit durably and pile up in the outbox instead of being lost.',
    action: 'Go offline',
    hint: 'Then type a sentence while disconnected.',
  },
  {
    id: 'reconnect',
    eyebrow: 'Step 3 of 4 · Convergence',
    title: 'Bring the network back',
    body: 'The client reconnects, replays the durable outbox, and the server assigns each operation a monotonic sequence. Watch pending operations drain to zero.',
    action: 'Reconnect',
    hint: 'Submissions are idempotent, so replays are safe.',
  },
  {
    id: 'collaborate',
    eyebrow: 'Step 4 of 4 · Collaboration',
    title: 'Add a second replica',
    body: 'This starts an independent client with its own identity and Lamport clock. It joins over /sync and types real operations that converge into your document.',
    action: 'Add demo collaborator',
    hint: 'No second browser window required.',
  },
  {
    id: 'done',
    eyebrow: 'Tour complete',
    title: 'Two replicas, one convergent document',
    body: 'Concurrent edits from independent replicas converged without a central lock, without last-write-wins, and without losing offline work.',
    action: 'Finish',
    hint: 'Open the Live Sync panel any time to keep watching.',
  },
];

export function findDemoStep(id: DemoStepId): DemoStep {
  const step = DEMO_STEPS.find((candidate) => candidate.id === id);

  if (!step) {
    throw new Error(`Unknown demo step "${id}".`);
  }

  return step;
}

export interface DemoProgressInput {
  readonly step: DemoStepId;
  readonly localEditCount: number;
  readonly offlineEditCount: number;
  readonly pendingCount: number;
  readonly syncStatus: SyncStatus;
  readonly collaboratorDone: boolean;
}

/**
 * Demo progression is derived from observed system state, not from timers. A
 * step only completes once the underlying condition is genuinely true.
 */
export function isDemoStepSatisfied(input: DemoProgressInput): boolean {
  switch (input.step) {
    case 'intro':
      return true;
    case 'local':
      return input.localEditCount >= 3;
    case 'offline':
      return input.offlineEditCount >= 1;
    case 'reconnect':
      return input.pendingCount === 0 && input.syncStatus === 'online';
    case 'collaborate':
      return input.collaboratorDone;
    case 'done':
      return true;
    default:
      return false;
  }
}

export function nextDemoStep(step: DemoStepId): DemoStepId | null {
  const index = DEMO_STEPS.findIndex((candidate) => candidate.id === step);

  if (index < 0 || index === DEMO_STEPS.length - 1) {
    return null;
  }

  return DEMO_STEPS[index + 1]?.id ?? null;
}

import {
  DEMO_CONVERGENCE_HOLD_MS,
  DEMO_STEPS,
  demoReconnectPhase,
  isDemoActionPending,
  isDemoStepSatisfied,
} from './demo-script';
import type { DemoProgressInput, DemoStep } from './demo-script';
import { Icon } from '../ui/Icon';

interface DemoTourProps {
  readonly step: DemoStep;
  readonly progress: DemoProgressInput;
  readonly onAdvance: () => void;
  readonly onRetry: () => void;
  readonly onExit: () => void;
}

export function DemoTour({ step, progress, onAdvance, onRetry, onExit }: DemoTourProps) {
  const index = DEMO_STEPS.findIndex((candidate) => candidate.id === step.id);
  const fill = (index / (DEMO_STEPS.length - 1)) * 100;
  const actionPending = isDemoActionPending(progress);
  const satisfied = isDemoStepSatisfied(progress);
  const reconnectPhase = demoReconnectPhase(progress);
  const waiting = !actionPending && !satisfied && reconnectPhase !== 'failed';

  return (
    <div className="tour" role="region" aria-label="Guided demo">
      <div className={reconnectPhase === 'failed' ? 'tour__card tour__card--alert' : 'tour__card'}>
        <div className="tour__progress" aria-hidden="true">
          <div
            className="tour__progress-fill"
            style={{ width: `${String(Math.min(100, Math.max(0, fill)))}%` }}
          />
        </div>

        <p className="eyebrow">{step.eyebrow}</p>
        <h2 className="tour__title">{titleFor(step, reconnectPhase)}</h2>
        <p className="tour__body">{bodyFor(step, reconnectPhase, progress.pendingCount)}</p>

        <div className="tour__foot">
          <span className="tour__hint">
            {waiting ? <span className="tour__spinner" aria-hidden="true" /> : null}
            {hintFor(step, reconnectPhase, progress.pendingCount, satisfied)}
          </span>

          <button type="button" className="btn btn--ghost" onClick={onExit}>
            Exit tour
          </button>

          {reconnectPhase === 'failed' ? (
            <button type="button" className="btn btn--primary" onClick={onRetry}>
              Retry Connection
              <Icon name="online" size={12} />
            </button>
          ) : reconnectPhase === 'catching-up' ? (
            <button type="button" className="btn" disabled>
              Catching up
            </button>
          ) : reconnectPhase === 'converged' ? (
            <button type="button" className="btn btn--primary" onClick={onAdvance}>
              Continue
            </button>
          ) : actionPending && step.action !== null ? (
            <button type="button" className="btn btn--primary" onClick={onAdvance}>
              {step.action}
              <Icon name="play" size={12} />
            </button>
          ) : (
            <button
              type="button"
              className={satisfied ? 'btn btn--primary' : 'btn'}
              disabled={!satisfied}
              onClick={onAdvance}
            >
              Continue
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function titleFor(step: DemoStep, phase: ReturnType<typeof demoReconnectPhase>): string {
  if (phase === 'converged') {
    return 'Converged ✓';
  }

  if (phase === 'failed') {
    return 'Unable to reach the sync server';
  }

  if (phase === 'catching-up') {
    return 'Replaying the durable outbox';
  }

  return step.title;
}

function bodyFor(
  step: DemoStep,
  phase: ReturnType<typeof demoReconnectPhase>,
  pendingCount: number,
): string {
  if (phase === 'converged') {
    return 'The outbox is empty and this replica matches the server log. That signal came from real sync state, not a timer.';
  }

  if (phase === 'failed') {
    return 'The WebSocket could not be established. This is not an intentional offline session. Start the sync server and retry.';
  }

  if (phase === 'catching-up') {
    return pendingCount > 0
      ? `${String(pendingCount)} queued ${pendingCount === 1 ? 'operation is' : 'operations are'} draining through the real outbox.`
      : 'Catching up with the server log.';
  }

  return step.body;
}

function hintFor(
  step: DemoStep,
  phase: ReturnType<typeof demoReconnectPhase>,
  pendingCount: number,
  satisfied: boolean,
): string {
  if (phase === 'converged') {
    return satisfied
      ? `Continuing in ${String(DEMO_CONVERGENCE_HOLD_MS / 1000)}s.`
      : 'Outbox drained.';
  }

  if (phase === 'failed') {
    return 'Run npm run dev:server, then retry.';
  }

  if (phase === 'catching-up' && pendingCount > 0) {
    return `${String(pendingCount)} pending`;
  }

  return step.hint;
}

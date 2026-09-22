import { DEMO_STEPS } from './demo-script';
import type { DemoStep } from './demo-script';
import { Icon } from '../ui/Icon';

interface DemoTourProps {
  readonly step: DemoStep;
  readonly satisfied: boolean;
  /** True while the step's own action button is still the next thing to press. */
  readonly actionPending: boolean;
  readonly onAdvance: () => void;
  readonly onExit: () => void;
}

export function DemoTour({ step, satisfied, actionPending, onAdvance, onExit }: DemoTourProps) {
  const index = DEMO_STEPS.findIndex((candidate) => candidate.id === step.id);
  const progress = (index / (DEMO_STEPS.length - 1)) * 100;
  const waiting = !actionPending && !satisfied;

  return (
    <div className="tour" role="region" aria-label="Guided demo">
      <div className="tour__card">
        <div className="tour__progress" aria-hidden="true">
          <div
            className="tour__progress-fill"
            style={{ width: `${String(Math.min(100, Math.max(0, progress)))}%` }}
          />
        </div>

        <p className="eyebrow">{step.eyebrow}</p>
        <h2 className="tour__title">{step.title}</h2>
        <p className="tour__body">{step.body}</p>

        <div className="tour__foot">
          <span className="tour__hint">
            {waiting ? <span className="tour__spinner" aria-hidden="true" /> : null}
            {step.hint}
          </span>

          <button type="button" className="btn btn--ghost" onClick={onExit}>
            Exit tour
          </button>

          {actionPending && step.action !== null ? (
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

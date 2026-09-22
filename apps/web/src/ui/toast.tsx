import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastTone = 'info' | 'ok' | 'warn' | 'bad';

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: ToastTone;
}

const TOAST_TTL_MS = 3200;
const MAX_VISIBLE = 3;

export interface ToastController {
  readonly toasts: readonly Toast[];
  readonly push: (message: string, tone?: ToastTone) => void;
}

export function useToasts(): ToastController {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(
    () => () => {
      for (const timer of timers.current) {
        clearTimeout(timer);
      }

      timers.current.clear();
    },
    [],
  );

  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = nextId.current;
    nextId.current += 1;

    setToasts((current) => [...current, { id, message, tone }].slice(-MAX_VISIBLE));

    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_TTL_MS);

    timers.current.add(timer);
  }, []);

  return { toasts, push };
}

export function Toaster({ toasts }: { readonly toasts: readonly Toast[] }) {
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`}>
          <span className="toast__dot" aria-hidden="true" />
          {toast.message}
        </div>
      ))}
    </div>
  );
}

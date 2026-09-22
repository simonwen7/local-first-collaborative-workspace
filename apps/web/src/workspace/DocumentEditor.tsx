import type { ChangeEvent, FormEvent, RefObject } from 'react';
import { Icon } from '../ui/Icon';
import type { SaveState } from './Topbar';

interface DocumentEditorProps {
  readonly editorRef: RefObject<HTMLTextAreaElement | null>;
  readonly title: string;
  readonly titleDraft: string;
  readonly text: string;
  readonly saveState: SaveState;
  readonly switching: boolean;
  readonly offlineMode: boolean;
  readonly pendingCount: number;
  readonly knownOperationCount: number;
  readonly errorMessage: string | null;
  readonly showHero: boolean;
  readonly onTitleDraftChange: (value: string) => void;
  readonly onRename: () => void;
  readonly onLaunchDemo: () => void;
  readonly onDismissHero: () => void;
  readonly onTextChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onCompositionStart: () => void;
  readonly onCompositionEnd: (value: string) => void;
}

export function DocumentEditor({
  editorRef,
  title,
  titleDraft,
  text,
  saveState,
  switching,
  offlineMode,
  pendingCount,
  knownOperationCount,
  errorMessage,
  showHero,
  onTitleDraftChange,
  onRename,
  onLaunchDemo,
  onDismissHero,
  onTextChange,
  onCompositionStart,
  onCompositionEnd,
}: DocumentEditorProps) {
  const loading = switching || saveState === 'loading';

  const submitTitle = (event: FormEvent) => {
    event.preventDefault();
    onRename();
  };

  return (
    <div className="editor-pane">
      <div className="editor-pane__inner" key={title}>
        {showHero ? (
          <section className="hero">
            <button
              type="button"
              className="btn btn--ghost btn--icon hero__dismiss"
              aria-label="Dismiss introduction"
              onClick={onDismissHero}
            >
              <Icon name="close" size={13} />
            </button>
            <p className="eyebrow">Local-first collaborative editing</p>
            <h2 className="hero__title">Edit anywhere. Even offline.</h2>
            <p className="hero__body">
              Changes persist to this browser before they touch the network, then converge
              automatically when connectivity returns. No central lock, no lost offline work, no
              last-write-wins.
            </p>
            <div className="hero__actions">
              <button type="button" className="btn btn--primary" onClick={onLaunchDemo}>
                <Icon name="play" size={13} />
                Launch the 60-second demo
              </button>
            </div>
            <div className="hero__chips">
              <span className="chip">Operation-based sequence CRDT</span>
              <span className="chip">Durable outbox</span>
              <span className="chip">Idempotent replay</span>
              <span className="chip">Snapshot bootstrap</span>
            </div>
          </section>
        ) : null}

        <form onSubmit={submitTitle}>
          <label className="sr-only" htmlFor="document-title">
            Document title
          </label>
          <input
            id="document-title"
            className="doc-title"
            value={titleDraft}
            disabled={switching}
            maxLength={240}
            placeholder="Untitled Document"
            onChange={(event) => onTitleDraftChange(event.currentTarget.value)}
            onBlur={onRename}
            aria-label="Rename document"
          />
        </form>

        <p className="doc-subline">
          <span>{knownOperationCount.toLocaleString()} operations in this replica</span>
          <span className="doc-subline__sep" aria-hidden="true">
            ·
          </span>
          <span>
            {offlineMode
              ? pendingCount > 0
                ? `Offline — ${String(pendingCount)} ${pendingCount === 1 ? 'change' : 'changes'} safely queued locally`
                : 'Offline — edits stay durable on this device'
              : 'Saved locally before every network attempt'}
          </span>
        </p>

        <div className="editor-surface">
          <label className="sr-only" htmlFor="document-editor">
            Document text
          </label>

          {loading ? (
            <div className="skeleton" aria-hidden="true">
              <span className="skeleton__line" style={{ width: '92%' }} />
              <span className="skeleton__line" style={{ width: '78%' }} />
              <span className="skeleton__line" style={{ width: '85%' }} />
              <span className="skeleton__line" style={{ width: '54%' }} />
            </div>
          ) : null}

          <textarea
            ref={editorRef}
            id="document-editor"
            className="document-editor"
            value={loading ? '' : text}
            disabled={loading}
            spellCheck
            rows={14}
            style={loading ? { display: 'none' } : undefined}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={(event) => onCompositionEnd(event.currentTarget.value)}
            onChange={onTextChange}
            placeholder="Start writing. Every keystroke becomes a CRDT operation stored in this browser."
          />
        </div>

        {errorMessage ? (
          <section className="banner" role="alert">
            <strong>Local save failed.</strong>
            <span>{errorMessage}</span>
          </section>
        ) : null}
      </div>
    </div>
  );
}

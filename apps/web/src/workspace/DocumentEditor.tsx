import type { FormEvent } from 'react';
import type { SyncStatus } from '../sync/document-sync-client';

type SaveState = 'loading' | 'saved' | 'saving' | 'error';

interface DocumentEditorProps {
  readonly title: string;
  readonly titleDraft: string;
  readonly text: string;
  readonly saveState: SaveState;
  readonly syncStatus: SyncStatus;
  readonly switching: boolean;
  readonly shareStatus: string | null;
  readonly errorMessage: string | null;
  readonly onTitleDraftChange: (value: string) => void;
  readonly onRename: () => void;
  readonly onShare: () => void;
  readonly onTextChange: (value: string) => void;
  readonly onCompositionStart: () => void;
  readonly onCompositionEnd: (value: string) => void;
}

export function DocumentEditor({
  title,
  titleDraft,
  text,
  saveState,
  syncStatus,
  switching,
  shareStatus,
  errorMessage,
  onTitleDraftChange,
  onRename,
  onShare,
  onTextChange,
  onCompositionStart,
  onCompositionEnd,
}: DocumentEditorProps) {
  const editorDisabled = switching || saveState === 'loading';

  const submitTitle = (event: FormEvent) => {
    event.preventDefault();
    onRename();
  };

  return (
    <section className="workspace-main">
      <header className="workspace-header">
        <form className="workspace-title-form" onSubmit={submitTitle}>
          <label className="sr-only" htmlFor="document-title">
            Document title
          </label>
          <input
            id="document-title"
            className="workspace-title-input"
            value={titleDraft}
            disabled={switching}
            maxLength={240}
            onChange={(event) => onTitleDraftChange(event.currentTarget.value)}
            onBlur={onRename}
            aria-label="Rename document"
          />
          <p className="workspace-title-hint">Local title only · {title}</p>
        </form>

        <div className="workspace-actions">
          <button type="button" className="workspace-share" disabled={switching} onClick={onShare}>
            Share Link
          </button>
          {shareStatus ? <span className="workspace-share-status">{shareStatus}</span> : null}

          <div className="status-group">
            <div className={`save-state save-state--${saveState}`} aria-live="polite">
              <span className="save-state__dot" aria-hidden="true" />
              {saveStateLabel(saveState)}
            </div>
            <div className={`sync-state sync-state--${syncStatus}`} aria-live="polite">
              <span className="save-state__dot" aria-hidden="true" />
              {syncStatusLabel(syncStatus)}
            </div>
          </div>
        </div>
      </header>

      <section className="editor-card">
        <div className="editor-toolbar">
          <span>{switching ? 'Opening document' : 'Local document'}</span>
          <span>Editing continues if the server is unavailable</span>
        </div>

        <label className="sr-only" htmlFor="document-editor">
          Document text
        </label>

        <textarea
          id="document-editor"
          className="document-editor"
          value={editorDisabled ? '' : text}
          disabled={editorDisabled}
          spellCheck
          onCompositionStart={onCompositionStart}
          onCompositionEnd={(event) => onCompositionEnd(event.currentTarget.value)}
          onChange={(event) => onTextChange(event.currentTarget.value)}
          placeholder={
            editorDisabled
              ? 'Opening document…'
              : 'Start writing. Every change is stored locally in this browser.'
          }
        />

        <footer className="editor-footer">
          <span>Offline-capable local persistence</span>
          <span>Reconnect sync is durable and incremental</span>
        </footer>
      </section>

      {errorMessage ? (
        <section className="error-banner" role="alert">
          <strong>Local save failed.</strong>
          <span>{errorMessage}</span>
        </section>
      ) : null}
    </section>
  );
}

function saveStateLabel(state: SaveState): string {
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

function syncStatusLabel(status: SyncStatus): string {
  switch (status) {
    case 'connecting':
      return 'Sync: Connecting';
    case 'syncing':
      return 'Sync: Syncing';
    case 'online':
      return 'Sync: Online';
    case 'offline':
      return 'Sync: Offline';
    case 'error':
      return 'Sync: Error';
  }
}

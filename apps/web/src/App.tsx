import { useEffect, useRef, useState } from 'react';
import { CompositionGate } from './editor/composition-gate';
import { LocalDocumentController } from './replica/local-document-controller';
import { DocumentSyncClient } from './sync/document-sync-client';
import type { SyncStatus } from './sync/document-sync-client';

type SaveState = 'loading' | 'saved' | 'saving' | 'error';

export function App() {
  const controllerRef = useRef<LocalDocumentController | null>(null);
  const syncClientRef = useRef<DocumentSyncClient | null>(null);
  const composingRef = useRef(false);
  const compositionGateRef = useRef(new CompositionGate());
  const requestVersionRef = useRef(0);

  const [title, setTitle] = useState('Local Document');
  const [text, setText] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let controller: LocalDocumentController | null = null;
    let syncClient: DocumentSyncClient | null = null;
    const compositionGate = compositionGateRef.current;

    void LocalDocumentController.create()
      .then((createdController) => {
        controller = createdController;

        if (disposed) {
          createdController.close();
          return;
        }

        controllerRef.current = createdController;

        const snapshot = createdController.getSnapshot();
        const identity = createdController.getIdentity();

        syncClient = new DocumentSyncClient({
          documentId: identity.documentId,
          clientId: identity.clientId,
          onRemoteOperations: async (operations) => {
            const activeController = controllerRef.current;

            if (!activeController) {
              return;
            }

            if (compositionGate.isHolding()) {
              await compositionGate.waitUntilLocalCommitComplete();
            }

            if (disposed || controllerRef.current !== activeController) {
              return;
            }

            const remoteSnapshot = await activeController.applyRemoteOperations(operations);

            if (disposed) {
              return;
            }

            setText(remoteSnapshot.text);
          },
          onStatusChange: (status) => {
            if (!disposed) {
              setSyncStatus(status);
            }
          },
        });

        syncClientRef.current = syncClient;
        setTitle(snapshot.title);
        setText(snapshot.text);
        setSaveState('saved');
        setSyncStatus(syncClient.getStatus());
        syncClient.connect();
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }

        setSaveState('error');
        setErrorMessage(toErrorMessage(error));
        setSyncStatus('offline');
      });

    return () => {
      disposed = true;
      compositionGate.release();

      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }

      if (syncClientRef.current === syncClient) {
        syncClientRef.current = null;
      }

      syncClient?.close();
      controller?.close();
    };
  }, []);

  const commitText = (nextText: string): Promise<void> => {
    const controller = controllerRef.current;

    setText(nextText);

    if (!controller) {
      return Promise.resolve();
    }

    setSaveState('saving');
    setErrorMessage(null);

    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;

    return controller
      .replaceText(nextText)
      .then((result) => {
        syncClientRef.current?.submitOperations(result.operations);

        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setText(result.snapshot.text);
        setSaveState('saved');
      })
      .catch((error: unknown) => {
        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setText(controller.getSnapshot().text);
        setSaveState('error');
        setErrorMessage(toErrorMessage(error));
      });
  };

  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Milestone 2 · Local-first</p>
          <h1>{title}</h1>
        </div>

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
      </header>

      <section className="editor-card">
        <div className="editor-toolbar">
          <span>Local document</span>
          <span>Editing continues if the server is unavailable</span>
        </div>

        <label className="sr-only" htmlFor="document-editor">
          Document text
        </label>

        <textarea
          id="document-editor"
          className="document-editor"
          value={text}
          disabled={saveState === 'loading'}
          spellCheck
          onCompositionStart={() => {
            composingRef.current = true;
            compositionGateRef.current.begin();
          }}
          onCompositionEnd={(event) => {
            const composedValue = event.currentTarget.value;
            composingRef.current = false;

            void commitText(composedValue).finally(() => {
              compositionGateRef.current.release();
            });
          }}
          onChange={(event) => {
            const nextText = event.currentTarget.value;

            if (composingRef.current || compositionGateRef.current.isHolding()) {
              setText(nextText);
              return;
            }

            commitText(nextText);
          }}
          placeholder="Start writing. Every change is stored locally in this browser."
        />

        <footer className="editor-footer">
          <span>Offline-capable local persistence</span>
          <span>Realtime sync is best-effort in M2</span>
        </footer>
      </section>

      {errorMessage ? (
        <section className="error-banner" role="alert">
          <strong>Local save failed.</strong>
          <span>{errorMessage}</span>
        </section>
      ) : null}
    </main>
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
    case 'online':
      return 'Sync: Online';
    case 'offline':
      return 'Sync: Offline';
    case 'error':
      return 'Sync: Error';
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown local persistence error.';
}

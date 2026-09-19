import { useEffect, useRef, useState } from 'react';
import { LocalDocumentController } from './replica/local-document-controller';

type SaveState = 'loading' | 'saved' | 'saving' | 'error';

export function App() {
  const controllerRef = useRef<LocalDocumentController | null>(null);
  const composingRef = useRef(false);
  const requestVersionRef = useRef(0);

  const [title, setTitle] = useState('Local Document');
  const [text, setText] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let controller: LocalDocumentController | null = null;

    void LocalDocumentController.create()
      .then((createdController) => {
        controller = createdController;

        if (disposed) {
          createdController.close();
          return;
        }

        controllerRef.current = createdController;

        const snapshot = createdController.getSnapshot();

        setTitle(snapshot.title);
        setText(snapshot.text);
        setSaveState('saved');
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }

        setSaveState('error');
        setErrorMessage(toErrorMessage(error));
      });

    return () => {
      disposed = true;

      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }

      controller?.close();
    };
  }, []);

  const commitText = (nextText: string) => {
    const controller = controllerRef.current;

    setText(nextText);

    if (!controller) {
      return;
    }

    setSaveState('saving');
    setErrorMessage(null);

    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;

    void controller
      .replaceText(nextText)
      .then((snapshot) => {
        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        setText(snapshot.text);
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
          <p className="eyebrow">Milestone 1 · Local-first</p>
          <h1>{title}</h1>
        </div>

        <div className={`save-state save-state--${saveState}`} aria-live="polite">
          <span className="save-state__dot" aria-hidden="true" />
          {saveStateLabel(saveState)}
        </div>
      </header>

      <section className="editor-card">
        <div className="editor-toolbar">
          <span>Local document</span>
          <span>Server not required</span>
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
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            commitText(event.currentTarget.value);
          }}
          onChange={(event) => {
            const nextText = event.currentTarget.value;

            if (composingRef.current) {
              setText(nextText);
              return;
            }

            commitText(nextText);
          }}
          placeholder="Start writing. Every change is stored locally in this browser."
        />

        <footer className="editor-footer">
          <span>Offline-capable local persistence</span>
          <span>Unicode grapheme-aware operations</span>
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
      return 'Loading local document…';
    case 'saving':
      return 'Saving locally…';
    case 'saved':
      return 'Saved locally';
    case 'error':
      return 'Local save error';
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown local persistence error.';
}

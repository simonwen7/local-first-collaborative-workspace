import { useEffect, useRef, useState } from 'react';
import { CompositionGate } from './editor/composition-gate';
import type { DocumentRecord } from './persistence/database';
import { DEFAULT_DOCUMENT_ID } from './persistence/local-document-store';
import { LocalWorkspaceCatalog, defaultTitleFor } from './persistence/local-workspace-catalog';
import { LocalDocumentController } from './replica/local-document-controller';
import { DocumentSyncClient } from './sync/document-sync-client';
import type { SyncStatus } from './sync/document-sync-client';
import { DocumentEditor } from './workspace/DocumentEditor';
import { WorkspaceSidebar } from './workspace/WorkspaceSidebar';
import {
  buildDocumentUrl,
  isValidWorkspaceDocumentId,
  readDocumentIdFromSearch,
} from './workspace/document-route';
import { SessionTransitionQueue } from './workspace/session-transition';

type SaveState = 'loading' | 'saved' | 'saving' | 'error';

interface ActiveSession {
  readonly documentId: string;
  readonly generation: number;
  readonly controller: LocalDocumentController;
  readonly syncClient: DocumentSyncClient;
  readonly compositionGate: CompositionGate;
}

export function App() {
  const catalogRef = useRef<LocalWorkspaceCatalog | null>(null);
  const sessionRef = useRef<ActiveSession | null>(null);
  const transitionsRef = useRef(new SessionTransitionQueue());
  const openSessionRef = useRef<(documentId: string, generation: number) => Promise<void>>(
    async () => undefined,
  );
  const composingRef = useRef(false);
  const requestVersionRef = useRef(0);
  const navLockVersionRef = useRef(0);
  const unmountedRef = useRef(false);

  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [text, setText] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('offline');
  const [transitionPending, setTransitionPending] = useState(false);
  const [switching, setSwitching] = useState(true);
  const [invalidRoute, setInvalidRoute] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);

  const navigationLocked = transitionPending || switching;

  const requestSession = (documentId: string) => {
    navLockVersionRef.current += 1;
    const lockVersion = navLockVersionRef.current;
    setTransitionPending(true);
    const transitions = transitionsRef.current;
    transitions.request(
      documentId,
      (target, generation) => openSessionRef.current(target, generation),
      async () => {
        const session = sessionRef.current;

        if (session?.compositionGate.isHolding()) {
          await session.compositionGate.waitUntilLocalCommitComplete();
        }
      },
    );
    void transitions.whenIdle().then(() => {
      if (!unmountedRef.current && lockVersion === navLockVersionRef.current) {
        setTransitionPending(false);
      }
    });
  };

  useEffect(() => {
    unmountedRef.current = false;
    const catalog = new LocalWorkspaceCatalog();
    catalogRef.current = catalog;
    const transitions = transitionsRef.current;

    const teardownSession = async () => {
      const previous = sessionRef.current;

      if (!previous) {
        return;
      }

      if (previous.compositionGate.isHolding()) {
        await previous.compositionGate.waitUntilLocalCommitComplete();
      }

      sessionRef.current = null;
      previous.syncClient.close();
      await previous.controller.whenIdle();
      await previous.controller.close();
      previous.compositionGate.release();
    };

    openSessionRef.current = async (documentId: string, generation: number) => {
      if (unmountedRef.current || !transitions.isCurrent(generation)) {
        return;
      }

      setSwitching(true);
      setInvalidRoute(false);
      setErrorMessage(null);
      setShareStatus(null);
      setText('');
      setSaveState('loading');
      setSyncStatus('connecting');

      try {
        await teardownSession();

        if (unmountedRef.current || !transitions.isCurrent(generation)) {
          return;
        }

        await catalog.ensureDocument(documentId, defaultTitleFor(documentId));
        const listed = await catalog.listDocuments();
        const record = listed.find((item) => item.id === documentId);
        const controller = await LocalDocumentController.create({
          documentId,
          defaultTitle: defaultTitleFor(documentId),
        });

        if (unmountedRef.current || !transitions.isCurrent(generation)) {
          await controller.close();
          return;
        }

        const compositionGate = new CompositionGate();
        const identity = controller.getIdentity();
        const snapshot = controller.getSnapshot();
        const syncClient = new DocumentSyncClient({
          documentId: identity.documentId,
          clientId: identity.clientId,
          getLastServerSeq: () => controller.getLastServerSeq(),
          loadPendingOperations: () => controller.loadPendingOperations(),
          onServerOperations: async (sequencedOperations, confirmedThroughServerSeq) => {
            if (
              !transitions.isCurrent(generation) ||
              sessionRef.current?.controller !== controller
            ) {
              return;
            }

            if (compositionGate.isHolding()) {
              await compositionGate.waitUntilLocalCommitComplete();
            }

            if (
              !transitions.isCurrent(generation) ||
              sessionRef.current?.controller !== controller
            ) {
              return;
            }

            const remoteSnapshot = await controller.applyServerOperations(
              sequencedOperations,
              confirmedThroughServerSeq,
            );

            if (!transitions.isCurrent(generation) || unmountedRef.current) {
              return;
            }

            setText(remoteSnapshot.text);
          },
          onStatusChange: (status) => {
            if (!transitions.isCurrent(generation) || unmountedRef.current) {
              return;
            }

            setSyncStatus(status);
          },
        });

        sessionRef.current = {
          documentId,
          generation,
          controller,
          syncClient,
          compositionGate,
        };

        setDocuments(listed);
        setActiveDocumentId(documentId);
        setTitle(record?.title ?? snapshot.title);
        setTitleDraft(record?.title ?? snapshot.title);
        setText(snapshot.text);
        setSaveState('saved');
        setSyncStatus(syncClient.getStatus());
        setSwitching(false);
        syncClient.connect();
      } catch (error: unknown) {
        if (unmountedRef.current || !transitions.isCurrent(generation)) {
          return;
        }

        setActiveDocumentId(null);
        setText('');
        setSaveState('error');
        setSwitching(false);
        setErrorMessage(toErrorMessage(error));
      }
    };

    const handlePopState = () => {
      const routed = readDocumentIdFromSearch(window.location.search);

      if (routed.status === 'invalid') {
        setInvalidRoute(true);
        setSwitching(false);
        setActiveDocumentId(null);
        setText('');
        void teardownSession();
        return;
      }

      requestSession(routed.status === 'valid' ? routed.documentId : DEFAULT_DOCUMENT_ID);
    };

    const boot = async () => {
      await catalog.ensureDocument(DEFAULT_DOCUMENT_ID);

      if (unmountedRef.current) {
        return;
      }

      setDocuments(await catalog.listDocuments());

      const routed = readDocumentIdFromSearch(window.location.search);

      if (routed.status === 'invalid') {
        setInvalidRoute(true);
        setSwitching(false);
        return;
      }

      const documentId = routed.status === 'valid' ? routed.documentId : DEFAULT_DOCUMENT_ID;

      if (routed.status === 'missing') {
        window.history.replaceState(
          { documentId },
          '',
          buildDocumentUrl(documentId, window.location.href),
        );
      }

      requestSession(documentId);
    };

    window.addEventListener('popstate', handlePopState);
    void boot();

    return () => {
      unmountedRef.current = true;
      window.removeEventListener('popstate', handlePopState);
      const session = sessionRef.current;
      sessionRef.current = null;
      session?.syncClient.close();
      session?.compositionGate.release();
      void session?.controller.close();
      catalog.close();
      catalogRef.current = null;
    };
  }, []);

  const navigateToDocument = (documentId: string, mode: 'push' | 'replace') => {
    if (!isValidWorkspaceDocumentId(documentId)) {
      setInvalidRoute(true);
      setSwitching(false);
      return;
    }

    if (documentId === activeDocumentId && !navigationLocked && !invalidRoute) {
      return;
    }

    const nextUrl = buildDocumentUrl(documentId, window.location.href);

    if (mode === 'push') {
      window.history.pushState({ documentId }, '', nextUrl);
    } else {
      window.history.replaceState({ documentId }, '', nextUrl);
    }

    requestSession(documentId);
  };

  const createDocument = async () => {
    const catalog = catalogRef.current;

    if (!catalog || navigationLocked) {
      return;
    }

    const documentId = crypto.randomUUID();
    await catalog.createDocument(documentId, defaultTitleFor(documentId));
    setDocuments(await catalog.listDocuments());
    navigateToDocument(documentId, 'push');
  };

  const commitText = (nextText: string): Promise<void> => {
    const session = sessionRef.current;
    setText(nextText);

    if (!session) {
      return Promise.resolve();
    }

    setSaveState('saving');
    setErrorMessage(null);
    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;
    const generation = session.generation;

    return session.controller
      .replaceText(nextText)
      .then((result) => {
        if (sessionRef.current?.syncClient === session.syncClient) {
          session.syncClient.submitOperations(result.operations);
        }

        if (
          requestVersion !== requestVersionRef.current ||
          !transitionsRef.current.isCurrent(generation)
        ) {
          return;
        }

        setText(result.snapshot.text);
        setSaveState('saved');
      })
      .catch((error: unknown) => {
        if (
          requestVersion !== requestVersionRef.current ||
          !transitionsRef.current.isCurrent(generation)
        ) {
          return;
        }

        setText(session.controller.getSnapshot().text);
        setSaveState('error');
        setErrorMessage(toErrorMessage(error));
      });
  };

  const renameActive = async () => {
    const catalog = catalogRef.current;
    const documentId = activeDocumentId;

    if (!catalog || !documentId || navigationLocked) {
      return;
    }

    try {
      const renamed = await catalog.renameDocument(documentId, titleDraft);
      setTitle(renamed.title);
      setTitleDraft(renamed.title);
      setDocuments(await catalog.listDocuments());
    } catch {
      setTitleDraft(title);
    }
  };

  const shareActive = async () => {
    if (!activeDocumentId) {
      return;
    }

    const url = new URL(
      buildDocumentUrl(activeDocumentId, window.location.href),
      window.location.origin,
    );

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url.toString());
        setShareStatus('Link copied');
      } else {
        setShareStatus('Copy unavailable');
      }
    } catch {
      setShareStatus('Copy failed');
    }
  };

  if (invalidRoute) {
    return (
      <main className="workspace-invalid">
        <p className="eyebrow">Workspace</p>
        <h1>Invalid document link</h1>
        <p>That address is not a valid workspace document.</p>
        <button
          type="button"
          className="workspace-new-document"
          onClick={() => navigateToDocument(DEFAULT_DOCUMENT_ID, 'replace')}
        >
          Open Workspace
        </button>
      </main>
    );
  }

  return (
    <main className="workspace-app">
      <WorkspaceSidebar
        documents={documents}
        activeDocumentId={activeDocumentId}
        switching={navigationLocked}
        onCreateDocument={() => {
          void createDocument();
        }}
        onSelectDocument={(documentId) => navigateToDocument(documentId, 'push')}
      />
      <DocumentEditor
        title={title}
        titleDraft={titleDraft}
        text={text}
        saveState={saveState}
        syncStatus={syncStatus}
        switching={switching}
        shareStatus={shareStatus}
        errorMessage={errorMessage}
        onTitleDraftChange={setTitleDraft}
        onRename={() => {
          void renameActive();
        }}
        onShare={() => {
          void shareActive();
        }}
        onTextChange={(value) => {
          const session = sessionRef.current;

          if (composingRef.current || session?.compositionGate.isHolding()) {
            setText(value);
            return;
          }

          void commitText(value);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
          sessionRef.current?.compositionGate.begin();
        }}
        onCompositionEnd={(value) => {
          composingRef.current = false;
          const session = sessionRef.current;
          void commitText(value).finally(() => {
            session?.compositionGate.release();
          });
        }}
      />
    </main>
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown local persistence error.';
}

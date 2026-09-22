import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PresenceParticipant } from '@lfcw/protocol';
import { CompositionGate } from './editor/composition-gate';
import { captureSelectionAnchor, resolveSelectionAnchor } from './editor/selection-anchor';
import type { SelectionAnchor, SelectionOffsets } from './editor/selection-anchor';
import type { DocumentRecord } from './persistence/database';
import { DEFAULT_DOCUMENT_ID } from './persistence/local-document-store';
import { LocalWorkspaceCatalog, defaultTitleFor } from './persistence/local-workspace-catalog';
import { LocalDocumentController } from './replica/local-document-controller';
import { DocumentSyncClient } from './sync/document-sync-client';
import type { SyncStatus } from './sync/document-sync-client';
import { SyncTelemetry } from './telemetry/sync-telemetry';
import type { SyncTelemetryEvent } from './telemetry/sync-telemetry';
import { DemoCollaborator } from './demo/demo-collaborator';
import { DemoTour } from './demo/DemoTour';
import { findDemoStep, isDemoStepSatisfied, nextDemoStep } from './demo/demo-script';
import type { DemoStepId } from './demo/demo-script';
import { Icon } from './ui/Icon';
import { Toaster, useToasts } from './ui/toast';
import { DocumentEditor } from './workspace/DocumentEditor';
import { SyncInspector } from './workspace/SyncInspector';
import { Topbar } from './workspace/Topbar';
import type { SaveState } from './workspace/Topbar';
import { WorkspaceSidebar } from './workspace/WorkspaceSidebar';
import {
  buildDocumentUrl,
  isValidWorkspaceDocumentId,
  readDocumentIdFromSearch,
} from './workspace/document-route';
import { SessionTransitionQueue } from './workspace/session-transition';

const MAX_EVENT_LOG = 40;
const HERO_DISMISSED_KEY = 'lfcw.hero-dismissed';

/**
 * A caret restore that is only valid for one exact materialized string.
 *
 * A sender echo usually produces text identical to what is already rendered,
 * so React skips the re-render and the layout effect never fires. Pinning the
 * restore to `forText` means a restore that was never consumed is discarded on
 * the next render instead of being applied to unrelated content.
 */
interface PendingSelection extends SelectionOffsets {
  readonly forText: string;
}

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
  const telemetryRef = useRef(new SyncTelemetry());
  const openSessionRef = useRef<(documentId: string, generation: number) => Promise<void>>(
    async () => undefined,
  );
  const composingRef = useRef(false);
  const requestVersionRef = useRef(0);
  const navLockVersionRef = useRef(0);
  const unmountedRef = useRef(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingSelectionRef = useRef<PendingSelection | null>(null);
  const offlineModeRef = useRef(false);
  const collaboratorRef = useRef<DemoCollaborator | null>(null);
  const previousPendingRef = useRef(0);

  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [text, setText] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('offline');
  const [transitionPending, setTransitionPending] = useState(false);
  const [switching, setSwitching] = useState(true);
  const [invalidRoute, setInvalidRoute] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [offlineMode, setOfflineMode] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastServerSeq, setLastServerSeq] = useState(0);
  const [knownOperationCount, setKnownOperationCount] = useState(0);
  const [participants, setParticipants] = useState<readonly PresenceParticipant[]>([]);
  const [events, setEvents] = useState<readonly SyncTelemetryEvent[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [heroDismissed, setHeroDismissed] = useState(readHeroDismissed);

  const [demoStep, setDemoStep] = useState<DemoStepId | null>(null);
  const [demoActionDone, setDemoActionDone] = useState(false);
  const [localEditCount, setLocalEditCount] = useState(0);
  const [offlineEditCount, setOfflineEditCount] = useState(0);
  const [collaboratorDone, setCollaboratorDone] = useState(false);

  const { toasts, push: pushToast } = useToasts();
  const navigationLocked = transitionPending || switching;

  useEffect(() => {
    const telemetry = telemetryRef.current;

    return telemetry.subscribe((event) => {
      if (unmountedRef.current) {
        return;
      }

      setEvents((current) => [event, ...current].slice(0, MAX_EVENT_LOG));
    });
  }, []);

  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current;

    if (!pending) {
      return;
    }

    pendingSelectionRef.current = null;
    const editor = editorRef.current;

    if (!editor || pending.forText !== text) {
      return;
    }

    editor.setSelectionRange(pending.start, pending.end);
  }, [text]);

  useEffect(() => {
    if (pendingCount === 0 && previousPendingRef.current > 0 && syncStatus === 'online') {
      pushToast('Synced ✓ — durable outbox drained', 'ok');
    }

    previousPendingRef.current = pendingCount;
  }, [pendingCount, syncStatus, pushToast]);

  const refreshStats = (session: ActiveSession): void => {
    void (async () => {
      try {
        const pending = await session.controller.countPendingOperations();
        const seq = await session.controller.getLastServerSeq();

        if (unmountedRef.current || sessionRef.current !== session) {
          return;
        }

        setPendingCount(pending);
        setLastServerSeq(seq);
        setKnownOperationCount(session.controller.getKnownOperationCount());
      } catch {
        // Statistics are advisory; a read failure must not disturb editing.
      }
    })();
  };

  /**
   * Snapshot the caret in CRDT identity space before a remote apply mutates the
   * materialized text, so it can be restored to the same logical position.
   */
  const captureAnchor = (controller: LocalDocumentController): SelectionAnchor | null => {
    const editor = editorRef.current;

    if (!editor || document.activeElement !== editor) {
      return null;
    }

    return captureSelectionAnchor(
      controller.getSnapshot().visibleElements,
      editor.selectionStart,
      editor.selectionEnd,
      editor.selectionDirection,
    );
  };

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
    // Scoped to this effect run specifically. `unmountedRef` is shared, so it
    // cannot distinguish a stale run's late rejection from the live run.
    const scope = { disposed: false };
    const catalog = new LocalWorkspaceCatalog();
    catalogRef.current = catalog;
    const transitions = transitionsRef.current;
    const telemetry = telemetryRef.current;

    const disposeCollaborator = () => {
      collaboratorRef.current?.dispose();
      collaboratorRef.current = null;
    };

    const teardownSession = async () => {
      const previous = sessionRef.current;
      disposeCollaborator();

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
      setText('');
      setSaveState('loading');
      setSyncStatus('connecting');
      setParticipants([]);
      setPendingCount(0);
      setLastServerSeq(0);
      setKnownOperationCount(0);
      setEvents([]);
      setCollaboratorDone(false);

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
          telemetry,
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
          displayName: `Replica ${identity.clientId.slice(0, 4).toUpperCase()}`,
          telemetry,
          getLastServerSeq: () => controller.getLastServerSeq(),
          loadPendingOperations: () => controller.loadPendingOperations(),
          isSnapshotBootstrapEligible: () => controller.isSnapshotBootstrapEligible(),
          onSnapshotBootstrap: async (
            bootstrap,
            sequencedOperations,
            confirmedThroughServerSeq,
          ) => {
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

            const remoteSnapshot = await controller.installServerSnapshot(
              bootstrap,
              sequencedOperations,
              confirmedThroughServerSeq,
            );

            if (!transitions.isCurrent(generation) || unmountedRef.current) {
              return;
            }

            setText(remoteSnapshot.text);
            const session = sessionRef.current;

            if (session) {
              refreshStats(session);
            }
          },
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

            // Let queued local writes land first. The caret anchor must be
            // read from replica state that matches what the textarea is
            // currently showing, otherwise offsets map onto stale elements
            // and the caret lands in the wrong place.
            await controller.whenIdle();

            if (
              !transitions.isCurrent(generation) ||
              sessionRef.current?.controller !== controller
            ) {
              return;
            }

            const anchor = captureAnchor(controller);
            const editVersion = requestVersionRef.current;
            const remoteSnapshot = await controller.applyServerOperations(
              sequencedOperations,
              confirmedThroughServerSeq,
            );

            if (!transitions.isCurrent(generation) || unmountedRef.current) {
              return;
            }

            const session = sessionRef.current;

            if (session) {
              refreshStats(session);
            }

            // A keystroke landed while the remote apply was in flight. Its own
            // commit already sees these operations and will render the merged
            // snapshot; rendering this older text first would reassign the
            // textarea value and throw the caret to the end.
            if (requestVersionRef.current !== editVersion) {
              return;
            }

            const restored = anchor
              ? resolveSelectionAnchor(remoteSnapshot.visibleElements, anchor)
              : null;

            pendingSelectionRef.current = restored
              ? { ...restored, forText: remoteSnapshot.text }
              : null;

            setText(remoteSnapshot.text);
          },
          onStatusChange: (status) => {
            if (!transitions.isCurrent(generation) || unmountedRef.current) {
              return;
            }

            setSyncStatus(status);
            const session = sessionRef.current;

            if (session) {
              refreshStats(session);
            }
          },
          onPresence: (roster) => {
            if (!transitions.isCurrent(generation) || unmountedRef.current) {
              return;
            }

            setParticipants(roster);
          },
          onServerSeqChange: (seq) => {
            if (!transitions.isCurrent(generation) || unmountedRef.current) {
              return;
            }

            setLastServerSeq(seq);
          },
        });

        const session: ActiveSession = {
          documentId,
          generation,
          controller,
          syncClient,
          compositionGate,
        };
        sessionRef.current = session;

        setDocuments(listed);
        setActiveDocumentId(documentId);
        setClientId(identity.clientId);
        setTitle(record?.title ?? snapshot.title);
        setTitleDraft(record?.title ?? snapshot.title);
        setText(snapshot.text);
        setSaveState('saved');
        setSyncStatus(syncClient.getStatus());
        setSwitching(false);
        refreshStats(session);

        if (offlineModeRef.current) {
          syncClient.suspend();
        } else {
          syncClient.connect();
        }
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

    // Boot races teardown: an unmount (or React's development double-mount)
    // closes the catalog while the first boot is still awaiting IndexedDB.
    // Swallow only that case and surface every other failure.
    void boot().catch((error: unknown) => {
      if (scope.disposed || unmountedRef.current) {
        return;
      }

      setSwitching(false);
      setSaveState('error');
      setErrorMessage(toErrorMessage(error));
    });

    return () => {
      scope.disposed = true;
      unmountedRef.current = true;
      window.removeEventListener('popstate', handlePopState);
      disposeCollaborator();
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
    setLocalEditCount((count) => count + 1);

    if (offlineModeRef.current) {
      setOfflineEditCount((count) => count + 1);
    }

    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;
    const generation = session.generation;

    return session.controller
      .replaceText(nextText)
      .then((result) => {
        if (sessionRef.current?.syncClient === session.syncClient) {
          session.syncClient.submitOperations(result.operations);
        }

        refreshStats(session);

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
        pushToast('Link copied', 'ok');
      } else {
        pushToast('Copy unavailable', 'warn');
      }
    } catch {
      pushToast('Copy failed', 'bad');
    }
  };

  const goOffline = () => {
    const session = sessionRef.current;
    offlineModeRef.current = true;
    setOfflineMode(true);
    collaboratorRef.current?.dispose();
    collaboratorRef.current = null;
    session?.syncClient.suspend();
    pushToast('Offline. Edits keep committing to IndexedDB.', 'warn');

    if (session) {
      refreshStats(session);
    }
  };

  const goOnline = () => {
    const session = sessionRef.current;
    offlineModeRef.current = false;
    setOfflineMode(false);
    session?.syncClient.resume();
    pushToast('Reconnecting and replaying the outbox…', 'info');
  };

  const addDemoCollaborator = () => {
    const session = sessionRef.current;

    if (!session || collaboratorRef.current) {
      return;
    }

    if (offlineModeRef.current) {
      pushToast('Reconnect first so the second replica can converge.', 'warn');
      return;
    }

    const collaborator = new DemoCollaborator({
      documentId: session.documentId,
      onStateChange: (state) => {
        if (unmountedRef.current) {
          return;
        }

        if (state === 'joined') {
          pushToast('Alex (demo) joined as a second replica', 'ok');
        }

        if (state === 'done') {
          setCollaboratorDone(true);
          pushToast('Remote operations converged into your replica', 'ok');
        }

        if (state === 'error') {
          pushToast('Demo collaborator could not reach the server', 'bad');
        }
      },
    });

    collaboratorRef.current = collaborator;
    collaborator.start();
  };

  const currentStep = demoStep === null ? null : findDemoStep(demoStep);
  const stepSatisfied =
    demoStep === null
      ? false
      : isDemoStepSatisfied({
          step: demoStep,
          localEditCount,
          offlineEditCount,
          pendingCount,
          syncStatus,
          collaboratorDone,
        });

  const launchDemo = () => {
    setDemoStep('intro');
    setDemoActionDone(false);
    setLocalEditCount(0);
    setOfflineEditCount(0);
    setCollaboratorDone(false);
    setInspectorOpen(true);
    setHeroDismissed(true);
    persistHeroDismissed();
  };

  const advanceDemo = () => {
    if (!currentStep || demoStep === null) {
      return;
    }

    if (demoStep === 'done') {
      exitDemo();
      return;
    }

    if (currentStep.action !== null && !demoActionDone && demoStep !== 'intro') {
      runDemoAction(demoStep);
      setDemoActionDone(true);
      return;
    }

    const next = nextDemoStep(demoStep);
    setDemoActionDone(false);

    if (next) {
      setDemoStep(next);
      focusEditor(next);
    }
  };

  const runDemoAction = (step: DemoStepId) => {
    if (step === 'offline') {
      goOffline();
      return;
    }

    if (step === 'reconnect') {
      goOnline();
      return;
    }

    if (step === 'collaborate') {
      addDemoCollaborator();
    }
  };

  const focusEditor = (step: DemoStepId) => {
    if (step !== 'local' && step !== 'offline') {
      return;
    }

    const editor = editorRef.current;

    if (!editor) {
      return;
    }

    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  };

  const exitDemo = () => {
    setDemoStep(null);
    setDemoActionDone(false);
  };

  if (invalidRoute) {
    return (
      <main className="route-error">
        <div className="route-error__card">
          <p className="eyebrow">Workspace</p>
          <h1>Invalid document link</h1>
          <p>That address is not a valid workspace document.</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => navigateToDocument(DEFAULT_DOCUMENT_ID, 'replace')}
          >
            <Icon name="layers" size={14} />
            Open Workspace
          </button>
        </div>
      </main>
    );
  }

  return (
    <>
      <main className={inspectorOpen ? 'shell' : 'shell shell--inspector-hidden'}>
        <WorkspaceSidebar
          documents={documents}
          activeDocumentId={activeDocumentId}
          switching={navigationLocked}
          clientId={clientId}
          lastServerSeq={lastServerSeq}
          onCreateDocument={() => {
            void createDocument();
          }}
          onSelectDocument={(documentId) => navigateToDocument(documentId, 'push')}
        />

        <div className="workspace">
          <Topbar
            saveState={saveState}
            syncStatus={syncStatus}
            offlineMode={offlineMode}
            pendingCount={pendingCount}
            participants={participants}
            selfClientId={clientId}
            busy={switching}
            inspectorOpen={inspectorOpen}
            demoActive={demoStep !== null}
            onToggleOffline={offlineMode ? goOnline : goOffline}
            onShare={() => {
              void shareActive();
            }}
            onLaunchDemo={launchDemo}
            onToggleInspector={() => setInspectorOpen((open) => !open)}
          />

          <DocumentEditor
            editorRef={editorRef}
            title={title}
            titleDraft={titleDraft}
            text={text}
            saveState={saveState}
            switching={switching}
            offlineMode={offlineMode}
            pendingCount={pendingCount}
            knownOperationCount={knownOperationCount}
            errorMessage={errorMessage}
            showHero={!heroDismissed && demoStep === null}
            onTitleDraftChange={setTitleDraft}
            onRename={() => {
              void renameActive();
            }}
            onLaunchDemo={launchDemo}
            onDismissHero={() => {
              setHeroDismissed(true);
              persistHeroDismissed();
            }}
            onTextChange={(event) => {
              const value = event.currentTarget.value;
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
        </div>

        {inspectorOpen ? (
          <SyncInspector
            syncStatus={syncStatus}
            offlineMode={offlineMode}
            pendingCount={pendingCount}
            lastServerSeq={lastServerSeq}
            documentId={activeDocumentId}
            clientId={clientId}
            knownOperationCount={knownOperationCount}
            participants={participants}
            events={events}
            onClose={() => setInspectorOpen(false)}
          />
        ) : null}
      </main>

      {currentStep ? (
        <DemoTour
          step={currentStep}
          satisfied={stepSatisfied}
          actionPending={currentStep.action !== null && !demoActionDone}
          onAdvance={advanceDemo}
          onExit={exitDemo}
        />
      ) : null}

      <Toaster toasts={toasts} />
    </>
  );
}

function readHeroDismissed(): boolean {
  try {
    return window.localStorage.getItem(HERO_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function persistHeroDismissed(): void {
  try {
    window.localStorage.setItem(HERO_DISMISSED_KEY, '1');
  } catch {
    // Preference persistence is optional.
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown local persistence error.';
}

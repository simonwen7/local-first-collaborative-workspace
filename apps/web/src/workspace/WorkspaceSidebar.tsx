import type { DocumentRecord } from '../persistence/database';

interface WorkspaceSidebarProps {
  readonly documents: readonly DocumentRecord[];
  readonly activeDocumentId: string | null;
  readonly switching: boolean;
  readonly onCreateDocument: () => void;
  readonly onSelectDocument: (documentId: string) => void;
}

export function WorkspaceSidebar({
  documents,
  activeDocumentId,
  switching,
  onCreateDocument,
  onSelectDocument,
}: WorkspaceSidebarProps) {
  return (
    <aside className="workspace-sidebar">
      <div className="workspace-brand">
        <p className="eyebrow">Local-first workspace</p>
        <h1>Documents</h1>
      </div>

      <button
        type="button"
        className="workspace-new-document"
        disabled={switching}
        onClick={onCreateDocument}
      >
        New Document
      </button>

      <nav className="workspace-document-list" aria-label="Local documents">
        {documents.length === 0 ? (
          <p className="workspace-empty-list">No local documents yet.</p>
        ) : (
          documents.map((document) => {
            const selected = document.id === activeDocumentId;

            return (
              <button
                key={document.id}
                type="button"
                className={
                  selected
                    ? 'workspace-document-item workspace-document-item--selected'
                    : 'workspace-document-item'
                }
                disabled={switching}
                aria-current={selected ? 'page' : undefined}
                onClick={() => onSelectDocument(document.id)}
              >
                <span className="workspace-document-title">{document.title}</span>
              </button>
            );
          })
        )}
      </nav>
    </aside>
  );
}

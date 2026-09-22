import type { DocumentRecord } from '../persistence/database';
import { Icon } from '../ui/Icon';

interface WorkspaceSidebarProps {
  readonly documents: readonly DocumentRecord[];
  readonly activeDocumentId: string | null;
  readonly switching: boolean;
  readonly clientId: string | null;
  readonly lastServerSeq: number;
  readonly onCreateDocument: () => void;
  readonly onSelectDocument: (documentId: string) => void;
}

export function WorkspaceSidebar({
  documents,
  activeDocumentId,
  switching,
  clientId,
  lastServerSeq,
  onCreateDocument,
  onSelectDocument,
}: WorkspaceSidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__mark" aria-hidden="true">
          <Icon name="layers" size={15} />
        </span>
        <div className="sidebar__names">
          <h1 className="sidebar__title">Local-First Workspace</h1>
          <p className="sidebar__subtitle">CRDT document replica</p>
        </div>
      </div>

      <div className="sidebar__section">
        <p className="eyebrow">Documents</p>
        <span className="sidebar__count">{documents.length}</span>
      </div>

      <div className="sidebar__actions">
        <button
          type="button"
          className="btn btn--wide"
          disabled={switching}
          onClick={onCreateDocument}
        >
          <Icon name="plus" size={14} />
          New Document
        </button>
      </div>

      <nav className="doc-list" aria-label="Local documents">
        {documents.length === 0 ? (
          <p className="sidebar__empty">
            No local documents yet.
            <br />
            Create one to start a replica.
          </p>
        ) : (
          documents.map((document) => {
            const selected = document.id === activeDocumentId;

            return (
              <button
                key={document.id}
                type="button"
                className={selected ? 'doc-item doc-item--active' : 'doc-item'}
                disabled={switching}
                aria-current={selected ? 'page' : undefined}
                onClick={() => onSelectDocument(document.id)}
              >
                <span className="doc-item__glyph" aria-hidden="true">
                  <Icon name="file" size={14} />
                </span>
                <span className="doc-item__title">{document.title}</span>
              </button>
            );
          })
        )}
      </nav>

      <div className="sidebar__footer">
        <p className="eyebrow" style={{ marginBottom: 7 }}>
          This replica
        </p>
        <div className="meta-row">
          <span className="meta-row__key">Client</span>
          <span className="meta-row__value">{clientId ? shortId(clientId) : '—'}</span>
        </div>
        <div className="meta-row">
          <span className="meta-row__key">Document</span>
          <span className="meta-row__value">
            {activeDocumentId ? shortId(activeDocumentId) : '—'}
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-row__key">Server seq</span>
          <span className="meta-row__value">{lastServerSeq}</span>
        </div>
      </div>
    </aside>
  );
}

export function shortId(value: string): string {
  if (value.length <= 14) {
    return value;
  }

  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

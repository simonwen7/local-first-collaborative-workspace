import { describe, expect, it } from 'vitest';
import { ServerMetrics } from '../src/observability/server-metrics.js';

describe('ServerMetrics', () => {
  it('tracks connection, room, join, sync, and append aggregates without labels', () => {
    const metrics = new ServerMetrics();

    metrics.recordConnectionOpened();
    metrics.recordConnectionOpened();
    metrics.recordJoin();
    metrics.setActiveRooms(1);
    metrics.recordSync(3, 12);
    metrics.recordSubmit();
    metrics.recordInsert();
    metrics.recordAppendDuration(4);
    metrics.recordConnectionClosed();
    metrics.setActiveRooms(0);

    const snapshot = metrics.snapshot();
    expect(snapshot.wsConnections).toBe(1);
    expect(snapshot.wsConnectionsTotal).toBe(2);
    expect(snapshot.activeRooms).toBe(0);
    expect(snapshot.joinTotal).toBe(1);
    expect(snapshot.syncTotal).toBe(1);
    expect(snapshot.syncOperationsSentTotal).toBe(3);
    expect(snapshot.syncQueryDurationCount).toBe(1);
    expect(snapshot.syncQueryDurationMsTotal).toBeGreaterThanOrEqual(0);
    expect(snapshot.insertedOperationsTotal).toBe(1);
    expect(snapshot.appendOperationDurationCount).toBe(1);
  });

  it('renders Prometheus text with HELP/TYPE lines and expected names', () => {
    const metrics = new ServerMetrics();
    metrics.recordProtocolError();
    metrics.recordInternalError();
    metrics.recordIdentityConflict();
    metrics.recordDuplicate();
    metrics.recordSnapshotBuild();
    metrics.recordSnapshotBuildFailure();
    metrics.recordSnapshotBootstrap(128, 4);

    const body = metrics.renderPrometheus();

    expect(body).toContain('# HELP lfcw_ws_connections');
    expect(body).toContain('# TYPE lfcw_ws_connections gauge');
    expect(body).toContain('# TYPE lfcw_join_total counter');
    expect(body).toMatch(/lfcw_protocol_errors_total 1/);
    expect(body).toMatch(/lfcw_internal_errors_total 1/);
    expect(body).toMatch(/lfcw_identity_conflicts_total 1/);
    expect(body).toMatch(/lfcw_duplicate_operations_total 1/);
    expect(body).toMatch(/lfcw_snapshot_build_total 1/);
    expect(body).toMatch(/lfcw_snapshot_build_failures_total 1/);
    expect(body).toMatch(/lfcw_snapshot_bootstrap_total 1/);
    expect(body).toMatch(/lfcw_snapshot_bytes_sent_total 128/);
    expect(body).toMatch(/lfcw_snapshot_suffix_operations_sent_total 4/);
    expect(body).not.toContain('documentId');
    expect(body).not.toContain('clientId');
  });
});

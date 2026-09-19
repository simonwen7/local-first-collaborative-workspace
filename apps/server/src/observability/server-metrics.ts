export interface ServerMetricSnapshot {
  readonly wsConnections: number;
  readonly activeRooms: number;
  readonly wsConnectionsTotal: number;
  readonly joinTotal: number;
  readonly syncTotal: number;
  readonly syncOperationsSentTotal: number;
  readonly submitOperationsTotal: number;
  readonly insertedOperationsTotal: number;
  readonly duplicateOperationsTotal: number;
  readonly identityConflictsTotal: number;
  readonly protocolErrorsTotal: number;
  readonly internalErrorsTotal: number;
  readonly syncQueryDurationMsTotal: number;
  readonly syncQueryDurationCount: number;
  readonly appendOperationDurationMsTotal: number;
  readonly appendOperationDurationCount: number;
}

export class ServerMetrics {
  private wsConnections = 0;
  private activeRooms = 0;
  private wsConnectionsTotal = 0;
  private joinTotal = 0;
  private syncTotal = 0;
  private syncOperationsSentTotal = 0;
  private submitOperationsTotal = 0;
  private insertedOperationsTotal = 0;
  private duplicateOperationsTotal = 0;
  private identityConflictsTotal = 0;
  private protocolErrorsTotal = 0;
  private internalErrorsTotal = 0;
  private syncQueryDurationMsTotal = 0;
  private syncQueryDurationCount = 0;
  private appendOperationDurationMsTotal = 0;
  private appendOperationDurationCount = 0;

  recordConnectionOpened(): void {
    this.wsConnections += 1;
    this.wsConnectionsTotal += 1;
  }

  recordConnectionClosed(): void {
    this.wsConnections = Math.max(0, this.wsConnections - 1);
  }

  setActiveRooms(count: number): void {
    this.activeRooms = count;
  }

  recordJoin(): void {
    this.joinTotal += 1;
  }

  recordSync(operationCount: number, durationMs: number): void {
    this.syncTotal += 1;
    this.syncOperationsSentTotal += operationCount;
    this.syncQueryDurationCount += 1;
    this.syncQueryDurationMsTotal += durationMs;
  }

  recordSubmit(): void {
    this.submitOperationsTotal += 1;
  }

  recordInsert(): void {
    this.insertedOperationsTotal += 1;
  }

  recordDuplicate(): void {
    this.duplicateOperationsTotal += 1;
  }

  recordIdentityConflict(): void {
    this.identityConflictsTotal += 1;
  }

  recordProtocolError(): void {
    this.protocolErrorsTotal += 1;
  }

  recordInternalError(): void {
    this.internalErrorsTotal += 1;
  }

  recordAppendDuration(durationMs: number): void {
    this.appendOperationDurationCount += 1;
    this.appendOperationDurationMsTotal += durationMs;
  }

  snapshot(): ServerMetricSnapshot {
    return {
      wsConnections: this.wsConnections,
      activeRooms: this.activeRooms,
      wsConnectionsTotal: this.wsConnectionsTotal,
      joinTotal: this.joinTotal,
      syncTotal: this.syncTotal,
      syncOperationsSentTotal: this.syncOperationsSentTotal,
      submitOperationsTotal: this.submitOperationsTotal,
      insertedOperationsTotal: this.insertedOperationsTotal,
      duplicateOperationsTotal: this.duplicateOperationsTotal,
      identityConflictsTotal: this.identityConflictsTotal,
      protocolErrorsTotal: this.protocolErrorsTotal,
      internalErrorsTotal: this.internalErrorsTotal,
      syncQueryDurationMsTotal: this.syncQueryDurationMsTotal,
      syncQueryDurationCount: this.syncQueryDurationCount,
      appendOperationDurationMsTotal: this.appendOperationDurationMsTotal,
      appendOperationDurationCount: this.appendOperationDurationCount,
    };
  }

  renderPrometheus(): string {
    const s = this.snapshot();

    return [
      metric('lfcw_ws_connections', 'gauge', 'Current WebSocket connections', s.wsConnections),
      metric('lfcw_active_rooms', 'gauge', 'Current non-empty document rooms', s.activeRooms),
      metric(
        'lfcw_ws_connections_total',
        'counter',
        'Accepted WebSocket connections',
        s.wsConnectionsTotal,
      ),
      metric('lfcw_join_total', 'counter', 'Successful document joins', s.joinTotal),
      metric('lfcw_sync_total', 'counter', 'Successful catch-up sync responses', s.syncTotal),
      metric(
        'lfcw_sync_operations_sent_total',
        'counter',
        'Operations included in sync responses',
        s.syncOperationsSentTotal,
      ),
      metric(
        'lfcw_submit_operations_total',
        'counter',
        'Inbound submit-operation messages',
        s.submitOperationsTotal,
      ),
      metric(
        'lfcw_inserted_operations_total',
        'counter',
        'Newly inserted SQLite operations',
        s.insertedOperationsTotal,
      ),
      metric(
        'lfcw_duplicate_operations_total',
        'counter',
        'Duplicate submitted operations',
        s.duplicateOperationsTotal,
      ),
      metric(
        'lfcw_identity_conflicts_total',
        'counter',
        'Operation identity conflicts',
        s.identityConflictsTotal,
      ),
      metric(
        'lfcw_protocol_errors_total',
        'counter',
        'Malformed or invalid client protocol messages',
        s.protocolErrorsTotal,
      ),
      metric(
        'lfcw_internal_errors_total',
        'counter',
        'Unexpected WebSocket processing or send failures',
        s.internalErrorsTotal,
      ),
      metric(
        'lfcw_sync_query_duration_ms_total',
        'counter',
        'Total milliseconds spent loading sync history',
        s.syncQueryDurationMsTotal,
      ),
      metric(
        'lfcw_sync_query_duration_count',
        'counter',
        'Sync history query count',
        s.syncQueryDurationCount,
      ),
      metric(
        'lfcw_append_operation_duration_ms_total',
        'counter',
        'Total milliseconds spent appending operations',
        s.appendOperationDurationMsTotal,
      ),
      metric(
        'lfcw_append_operation_duration_count',
        'counter',
        'Append-operation attempts',
        s.appendOperationDurationCount,
      ),
    ].join('');
  }
}

function metric(name: string, type: 'gauge' | 'counter', help: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}\n`;
}

export class SessionTransitionQueue {
  private inFlight = false;
  private pendingTarget: string | null = null;
  private generation = 0;
  private drain: Promise<void> = Promise.resolve();
  private switchTo: ((documentId: string, generation: number) => Promise<void>) | null = null;
  private prepare: (() => Promise<void>) | null = null;

  getGeneration(): number {
    return this.generation;
  }

  isInFlight(): boolean {
    return this.inFlight;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  request(
    documentId: string,
    switchTo: (documentId: string, generation: number) => Promise<void>,
    prepare?: () => Promise<void>,
  ): void {
    this.pendingTarget = documentId;
    this.switchTo = switchTo;

    if (prepare) {
      this.prepare = prepare;
    }

    this.drain = this.drain.then(
      () => this.flush(),
      () => this.flush(),
    );
  }

  whenIdle(): Promise<void> {
    return this.drain;
  }

  private async flush(): Promise<void> {
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;

    try {
      while (this.pendingTarget !== null && this.switchTo) {
        if (this.prepare) {
          await this.prepare();
        }

        const target = this.pendingTarget;
        const switchTo = this.switchTo;

        if (target === null || !switchTo) {
          break;
        }

        this.pendingTarget = null;
        this.generation += 1;
        await switchTo(target, this.generation);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

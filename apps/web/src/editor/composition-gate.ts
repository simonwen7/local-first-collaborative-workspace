export class CompositionGate {
  private commitComplete: Promise<void> | null = null;
  private resolveCommit: (() => void) | null = null;

  isHolding(): boolean {
    return this.commitComplete !== null;
  }

  begin(): void {
    if (this.commitComplete !== null) {
      return;
    }

    this.commitComplete = new Promise((resolve) => {
      this.resolveCommit = resolve;
    });
  }

  async waitUntilLocalCommitComplete(): Promise<void> {
    if (this.commitComplete === null) {
      return;
    }

    await this.commitComplete;
  }

  release(): void {
    const resolve = this.resolveCommit;
    this.resolveCommit = null;
    this.commitComplete = null;
    resolve?.();
  }
}

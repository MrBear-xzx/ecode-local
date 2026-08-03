export class ManifestCheckpoint {
  private pendingChanges = 0;

  constructor(
    private readonly save: () => Promise<void>,
    private readonly threshold = 25,
  ) {}

  async markDirty(): Promise<void> {
    this.pendingChanges++;
    if (this.pendingChanges >= this.threshold) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.pendingChanges === 0) {
      return;
    }
    await this.save();
    this.pendingChanges = 0;
  }
}

// Session-bound APIs must never escape into watcher continuations. Keep the
// continuation queued across reload and run it synchronously with the bound API.
// One instance serves the whole pi process, so every binding is keyed by the
// session that owns it: a child's completion drains only through its owning
// session's API, never through a sibling session bound later (TASK-462).
type Entry<T> = { run: (api: T) => void; resolve: () => void; reject: (error: unknown) => void };
type Slot<T> = { api: T | undefined; stopped: boolean; pending: Entry<T>[] };

export class CompletionDelivery<T> {
  private slots = new Map<string, Slot<T>>();

  enqueue(run: (api: T) => void, owner = ""): Promise<void> {
    const slot = this.slot(owner);
    if (slot.stopped) return Promise.resolve();
    return new Promise((resolve, reject) => {
      slot.pending.push({ run, resolve, reject });
      this.drain(slot);
    });
  }

  bind(api: T, owner = ""): void {
    const slot = this.slot(owner);
    slot.stopped = false;
    slot.api = api;
    this.drain(slot);
  }

  detach(preserve: boolean, owner = ""): void {
    const slot = this.slot(owner);
    slot.api = undefined;
    slot.stopped = !preserve;
    if (!preserve) {
      // Terminal/session-switch teardown suppresses delivery, like active watchers.
      for (const entry of slot.pending.splice(0)) entry.resolve();
    }
  }

  private slot(owner: string): Slot<T> {
    let slot = this.slots.get(owner);
    if (!slot) this.slots.set(owner, slot = { api: undefined, stopped: false, pending: [] });
    return slot;
  }

  private drain(slot: Slot<T>): void {
    while (slot.api !== undefined && slot.pending.length > 0) {
      const entry = slot.pending.shift()!;
      try {
        entry.run(slot.api);
        entry.resolve();
      } catch (error) {
        entry.reject(error);
      }
    }
  }
}

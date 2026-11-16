const RECOVERY_KEY = "cyrene:live2d-context-recovery";
const RECOVERY_WINDOW_MS = 5 * 60_000;
const MAX_RECOVERIES = 2;

export interface ContextRecoveryOptions {
  pause: () => void;
  reload: () => void;
  storage: Pick<Storage, "getItem" | "setItem">;
  report: (event: "context_lost" | "reloading" | "recovery_blocked") => void;
  now?: () => number;
}

/** Rebuild both PIXI and Cubism resources after a context loss.
 * Reload only the pet renderer, with a persistent guard against driver failure loops.
 */
export class Live2DContextRecovery {
  private lost = false;
  private attempted = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly canvas: EventTarget, private readonly options: ContextRecoveryOptions) {
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
  }

  private onLost = (event: Event): void => {
    event.preventDefault();
    if (this.disposed || this.lost) return;
    this.lost = true;
    this.options.pause();
    this.options.report("context_lost");
    // Some drivers never dispatch restored. Do not leave the pet broken indefinitely.
    this.timer = setTimeout(() => this.recover(), 5_000);
  };

  private onRestored = (): void => {
    if (this.lost) this.recover();
  };

  private recover(): void {
    if (this.disposed || this.attempted) return;
    this.attempted = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    const now = (this.options.now ?? Date.now)();
    try {
      const raw: unknown = JSON.parse(this.options.storage.getItem(RECOVERY_KEY) ?? "[]");
      const recent = Array.isArray(raw) ? raw.filter((at): at is number => typeof at === "number" && Number.isFinite(at) && at <= now && now - at < RECOVERY_WINDOW_MS) : [];
      if (recent.length >= MAX_RECOVERIES) {
        this.options.report("recovery_blocked");
        return;
      }
      this.options.storage.setItem(RECOVERY_KEY, JSON.stringify([...recent, now]));
    } catch {
      // Without a persisted guard, reloading could loop forever on a broken driver.
      this.options.report("recovery_blocked");
      return;
    }
    this.options.report("reloading");
    this.options.reload();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
  }
}

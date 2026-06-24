import { UPDATE_PRIORITY, type Ticker } from "pixi.js";

type LiveUpdateTask = () => void;

/**
 * Coalesces imperative scene work at Pixi's update boundary.
 *
 * Tasks run before the Application render listener (registered at LOW
 * priority), so render-texture updates and the final stage submission land in
 * the same visual frame without calling Application.render() from pointer
 * handlers.
 */
export class PixiLiveUpdateScheduler {
  private readonly ticker: Ticker;
  private readonly pendingTasks = new Map<string, LiveUpdateTask>();
  private disposed = false;

  constructor(ticker: Ticker) {
    this.ticker = ticker;
    this.ticker.add(this.flush, this, UPDATE_PRIORITY.HIGH);
  }

  public schedule(key: string, task: LiveUpdateTask): void {
    if (this.disposed) {
      return;
    }
    this.pendingTasks.set(key, task);
  }

  public flush = (): void => {
    if (this.disposed || this.pendingTasks.size === 0) {
      return;
    }

    const tasks = [...this.pendingTasks.values()];
    this.pendingTasks.clear();
    tasks.forEach((task) => task());
  };

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.pendingTasks.clear();
    this.ticker.remove(this.flush, this);
  }
}

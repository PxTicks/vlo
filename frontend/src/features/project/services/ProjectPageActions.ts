import type { ShellDisposable } from "../../../core/shell/hostMenuCatalog";

/** Bridges shell commands to the currently mounted projects-page UI. */
class ProjectPageActions {
  private createHandler: (() => void | Promise<void>) | null = null;

  setCreateHandler(handler: () => void | Promise<void>): ShellDisposable {
    this.createHandler = handler;
    return Object.freeze({
      dispose: () => {
        if (this.createHandler === handler) this.createHandler = null;
      },
    });
  }

  requestCreate(): boolean {
    if (!this.createHandler) return false;
    void this.createHandler();
    return true;
  }
}

export const projectPageActions = new ProjectPageActions();

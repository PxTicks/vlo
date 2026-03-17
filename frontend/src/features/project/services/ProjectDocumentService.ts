import {
  applyPatches,
  enablePatches,
  produce,
  type Patch,
  type Draft,
} from "../../../lib/immerLite";
import { fileSystemService } from "./FileSystemService";
import type { ProjectDocument } from "../types/ProjectDocument";

enablePatches();

type ProjectDocumentMutator = (draft: Draft<ProjectDocument>) => void;

const PROJECT_JSON_PATH = ".vloproject/project.json";

export class ProjectDocumentService {
  private queue: Promise<void> = Promise.resolve();
  private cachedDocument: ProjectDocument | null = null;

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadProjectDocument(): Promise<ProjectDocument> {
    if (this.cachedDocument) {
      return structuredClone(this.cachedDocument);
    }

    try {
      const file = await fileSystemService.readFile(PROJECT_JSON_PATH);
      if (!file || typeof file.text !== "function") {
        this.cachedDocument = {};
        return {};
      }

      const text = await file.text();
      if (!text.trim()) {
        this.cachedDocument = {};
        return {};
      }

      const parsed = JSON.parse(text) as ProjectDocument;
      if (parsed && typeof parsed === "object") {
        this.cachedDocument = parsed;
        return structuredClone(parsed);
      }
    } catch (error) {
      console.warn(
        "[ProjectDocumentService] Could not read project.json; using default document.",
        error,
      );
    }

    this.cachedDocument = {};
    return {};
  }

  private async persistProjectDocument(
    document: ProjectDocument,
  ): Promise<ProjectDocument> {
    const toPersist = produce(document, (draft) => {
      draft.last_modified = Date.now();
    });

    await fileSystemService.writeFile(
      PROJECT_JSON_PATH,
      JSON.stringify(toPersist, null, 2),
    );
    this.cachedDocument = toPersist;
    return structuredClone(toPersist);
  }

  async readProjectDocument(): Promise<ProjectDocument> {
    return this.enqueue(async () => this.loadProjectDocument());
  }

  async updateProjectDocument(
    mutator: ProjectDocumentMutator,
  ): Promise<ProjectDocument> {
    return this.enqueue(async () => {
      const current = await this.loadProjectDocument();
      const next = produce(current, (draft) => {
        mutator(draft);
      });
      return this.persistProjectDocument(next);
    });
  }

  async applyProjectDocumentPatches(
    patches: Patch[],
    fallbackMutator?: ProjectDocumentMutator,
  ): Promise<ProjectDocument> {
    return this.enqueue(async () => {
      const current = await this.loadProjectDocument();

      let next: ProjectDocument;
      try {
        next = applyPatches(current, patches) as ProjectDocument;
      } catch (error) {
        if (!fallbackMutator) {
          throw error;
        }
        next = produce(current, (draft) => {
          fallbackMutator(draft);
        });
      }

      return this.persistProjectDocument(next);
    });
  }

  resetProjectDocumentCache() {
    this.cachedDocument = null;
  }
}

export const projectDocumentService = new ProjectDocumentService();

export type { Patch, ProjectDocumentMutator };

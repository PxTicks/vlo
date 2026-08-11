import type { JsonValue } from "@vlo/extension-sdk";
import type { ReactNode } from "react";
import type {
  DockRegion,
  EditorStage,
  EditorStageSurfaces,
  ShellLayoutDocumentV2,
} from "../layout/layoutTypes";

export interface WorkspaceSurfaceSlot {
  readonly surfaceId: string;
  /** Missing optional surfaces fall back to the stage's normal surface. */
  readonly required?: boolean;
}

export interface WorkspacePanelSlot {
  readonly viewId: string;
  /** Missing optional panels do not prevent the workspace from opening. */
  readonly required?: boolean;
}

export type WorkspaceDockSlot =
  | { readonly mode: "inherit" }
  | {
      readonly mode: "augment" | "replace";
      readonly panels: readonly WorkspacePanelSlot[];
      readonly selectedViewId?: string | null;
    };

/** Owner-neutral, already-normalized composition consumed by the layout store. */
export interface WorkspaceComposition {
  readonly stages?: Readonly<
    Partial<Record<EditorStage, WorkspaceSurfaceSlot>>
  >;
  readonly docks?: Readonly<Partial<Record<DockRegion, WorkspaceDockSlot>>>;
}

export type WorkspaceFocusTarget =
  | { readonly kind: "stage"; readonly stage: EditorStage }
  | { readonly kind: "dock"; readonly region: DockRegion };

export interface FiniteJsonSchema {
  readonly validate: (subject: JsonValue) => boolean;
}

export interface DedicatedWorkspaceContext {
  readonly workspaceId: string;
  readonly signal: AbortSignal;
  /** Feature-owned invalidation can ask the shell to close safely. */
  readonly requestClose: () => Promise<boolean>;
}

export interface DedicatedWorkspaceSession {
  readonly dirty?: boolean;
  readonly requestClose?: () => Promise<"close" | "cancel">;
  readonly dispose: () => void | Promise<void>;
}

export interface DedicatedWorkspaceDefinition<TSubject> {
  readonly id: string;
  readonly title: string;
  readonly ownerId: string;
  readonly icon?: () => ReactNode;
  readonly subjectSchema: FiniteJsonSchema;
  readonly describeSubject: (subject: TSubject) => string;
  readonly composition: WorkspaceComposition;
  readonly initialFocus?: WorkspaceFocusTarget;
  readonly createSession: (
    subject: TSubject,
    context: DedicatedWorkspaceContext,
  ) => DedicatedWorkspaceSession | Promise<DedicatedWorkspaceSession>;
}

/** Type-erased, frozen registry entry used by the controller. */
export interface DedicatedWorkspaceEntry {
  readonly id: string;
  readonly title: string;
  readonly ownerId: string;
  readonly icon?: () => ReactNode;
  readonly composition: WorkspaceComposition;
  readonly initialFocus?: WorkspaceFocusTarget;
  readonly validateSubject: (subject: JsonValue) => boolean;
  readonly describeSubject: (subject: JsonValue) => string;
  readonly createSession: (
    subject: JsonValue,
    context: DedicatedWorkspaceContext,
  ) => DedicatedWorkspaceSession | Promise<DedicatedWorkspaceSession>;
}

export interface ActiveDedicatedWorkspace {
  readonly id: string;
  readonly title: string;
  readonly ownerId: string;
  readonly subject: JsonValue;
  readonly subjectLabel: string;
}

export interface ActiveWorkspaceLayout {
  readonly workspaceId: string;
  readonly composition: WorkspaceComposition;
  readonly document: ShellLayoutDocumentV2;
  /** Session composition that was active before the workspace opened. */
  readonly restoreStageSurfaces: EditorStageSurfaces;
}

export type WorkspaceActivationResult =
  | { readonly status: "opened" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: Error };

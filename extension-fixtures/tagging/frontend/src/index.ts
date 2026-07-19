import type {
  ExtensionAssetApi,
  ExtensionBackendApi,
  ExtensionKeyValueStore,
  ExtensionModule,
  ExtensionReactRuntime,
  ExtensionStorageApi,
  JsonValue,
  VloExtensionApi,
} from "@vlo/extension-sdk";

const TAG_INDEX_KEY = "tag-index";

export interface TagIndex {
  readonly schemaVersion: 1;
  readonly tagsByAsset: Readonly<Record<string, readonly string[]>>;
}

export interface TaggingApi {
  readonly assets: Pick<ExtensionAssetApi, "list">;
  readonly backend: Pick<
    ExtensionBackendApi,
    "listJobs" | "submitJob" | "waitForJob"
  >;
  readonly storage: ExtensionStorageApi;
}

interface ReactHooksRuntime extends ExtensionReactRuntime {
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void;
  useState<T>(initial: T): [T, (next: T | ((current: T) => T)) => void];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTagIndex(value: unknown): TagIndex {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Tag index must use schemaVersion 1.");
  }
  if (!isRecord(value.tagsByAsset)) {
    throw new Error("Tag index must contain tagsByAsset.");
  }
  const tagsByAsset: Record<string, readonly string[]> = {};
  for (const [assetId, tags] of Object.entries(value.tagsByAsset)) {
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
      throw new Error(`Tags for '${assetId}' must be strings.`);
    }
    tagsByAsset[assetId] = Object.freeze([...tags]);
  }
  return Object.freeze({
    schemaVersion: 1,
    tagsByAsset: Object.freeze(tagsByAsset),
  });
}

export async function readTagIndex(
  storage: ExtensionKeyValueStore,
): Promise<TagIndex | null> {
  const stored = await storage.get(TAG_INDEX_KEY);
  return stored === undefined ? null : parseTagIndex(stored);
}

export async function refreshTagIndex(api: TaggingApi): Promise<TagIndex> {
  const projectStorage = api.storage.project;
  if (!projectStorage) throw new Error("Open a project before tagging assets.");
  const jobType = (await api.backend.listJobs()).find(
    (candidate) => candidate.id === "tag-assets",
  );
  if (!jobType) throw new Error("Tagging backend job is unavailable.");
  if (!jobType.readiness.ready) throw new Error(jobType.readiness.message);

  const submitted = await api.backend.submitJob("tag-assets", {
    schemaVersion: 1,
    assets: api.assets.list().map((asset) => ({
      id: asset.id,
      name: asset.name,
      type: asset.type,
    })),
  });
  const completed = await api.backend.waitForJob(submitted.jobId);
  if (completed.status !== "succeeded") {
    throw new Error(completed.error ?? `Tagging ${completed.status}.`);
  }
  const index = parseTagIndex(completed.result);
  await projectStorage.set(TAG_INDEX_KEY, index as unknown as JsonValue);
  return index;
}

function createTaggingPanel(api: VloExtensionApi, React: ReactHooksRuntime) {
  return function TaggingPanel(): unknown {
    const storage = api.storage.project;
    const [index, setIndex] = React.useState<TagIndex | null>(null);
    const [status, setStatus] = React.useState(
      storage ? "Ready to tag assets" : "Open a project to tag assets",
    );

    React.useEffect(() => {
      if (!storage) return undefined;
      let active = true;
      const pull = async () => {
        try {
          const next = await readTagIndex(storage);
          if (active) setIndex(next);
        } catch (error) {
          if (active) setStatus(error instanceof Error ? error.message : String(error));
        }
      };
      void pull();
      const unsubscribe = storage.subscribe(() => void pull());
      return () => {
        active = false;
        unsubscribe();
      };
    }, [storage]);

    const refresh = async () => {
      setStatus("Tagging…");
      try {
        const next = await refreshTagIndex(api);
        setIndex(next);
        setStatus("Tag index stored in this project.");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    };

    return React.createElement(
      "section",
      { "data-extension": "example.tagging" },
      React.createElement("strong", null, "Tagging storage fixture"),
      React.createElement("p", null, status),
      React.createElement(
        "p",
        null,
        `${Object.keys(index?.tagsByAsset ?? {}).length} assets tagged`,
      ),
      React.createElement(
        "button",
        { type: "button", disabled: !storage, onClick: () => void refresh() },
        "Refresh tags",
      ),
    );
  };
}

export const activate: ExtensionModule["activate"] = (context) => {
  const React = context.api.runtime.react as ReactHooksRuntime;
  context.api.ui.registerComponent({
    id: "tagging-storage-panel",
    apiVersion: 1,
    slot: "timeline.toolbar",
    kind: "trusted-react",
    component: createTaggingPanel(context.api, React),
  });
  context.logger.info("Tagging storage conformance frontend activated.");
};

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionGenerationSubmissionContributorRegistry } from "../ExtensionGenerationSubmissionContributors";
import { generationSubmissionContributors } from "../../../generation/services/generationSubmissionContributors";
import { generationSessionService } from "../../../generation/services/GenerationSessionService";
import { resetGenerationSessionProjectionCache } from "../generationSessionProjection";
import { mountGenerationSession } from "../../../../testUtils/generationSession";
import type {
  ExtensionApiScope,
  ExtensionGenerationGraphEffect,
  ExtensionResource,
} from "../../types";
import type { GenerationNodeSnapshot } from "../../../generation/services/generationSessionTypes";

/**
 * The adapter half of E2: whose contribution this is, what it may return, and
 * what happens to it when the activation ends. What a contribution *means* to
 * a submission is the generation domain's and is covered beside it.
 */

const nodes: readonly GenerationNodeSnapshot[] = [
  {
    id: "10",
    classType: "LoraLoader",
    title: "Load LoRA",
    mode: 0,
    widgets: [
      {
        nodeId: "10",
        param: "lora_name",
        valueType: "enum",
        value: "sharp.safetensors",
        defaultValue: "sharp.safetensors",
        options: ["sharp.safetensors", "soft.safetensors"],
        min: null,
        max: null,
        step: null,
        linked: false,
        controlAfterGenerate: false,
      },
    ],
  },
];

function createScope(
  extensionId = "example.lora-policy",
  report: ExtensionApiScope["report"] = vi.fn(),
): {
  scope: ExtensionApiScope;
  controller: AbortController;
  resources: ExtensionResource[];
  report: ExtensionApiScope["report"];
} {
  const controller = new AbortController();
  const resources: ExtensionResource[] = [];
  return {
    controller,
    resources,
    report,
    scope: {
      extension: { id: extensionId, version: "1.0.0" },
      signal: controller.signal,
      own: <TResource extends ExtensionResource>(resource: TResource) => {
        resources.push(resource);
        return resource;
      },
      report,
    },
  };
}

function disposeAll(resources: ExtensionResource[]): void {
  for (const resource of resources) {
    if (typeof resource === "function") void resource();
    else void resource.dispose();
  }
}

let registry: ExtensionGenerationSubmissionContributorRegistry;
let session: ReturnType<typeof mountGenerationSession> | null = null;
const registered: { dispose(): void }[] = [];

function contributorDefinition(
  id: string,
  contribute: () => readonly ExtensionGenerationGraphEffect[],
) {
  return { id, apiVersion: 1 as const, contribute };
}

beforeEach(() => {
  resetGenerationSessionProjectionCache();
  registry = new ExtensionGenerationSubmissionContributorRegistry();
  session = mountGenerationSession({ nodes });
});

afterEach(() => {
  for (const registration of registered.splice(0)) registration.dispose();
  session?.unmount();
  session = null;
});

/** What the store does at submission time, on the same path. */
function collect() {
  return generationSubmissionContributors.collect(
    generationSessionService.getSnapshot(),
  );
}

describe("ExtensionGenerationSubmissionContributorRegistry", () => {
  it("qualifies the contribution id with its owner", () => {
    const { scope } = createScope();
    const registration = registry.bind(scope)(
      contributorDefinition("loader-policy", () => []),
    );
    registered.push(registration);

    expect(registration.id).toBe("example.lora-policy/loader-policy");
    expect(collect()[0].source).toBe(
      "extension:example.lora-policy/loader-policy",
    );
  });

  it("hands the callback a detached session and forwards its effects", () => {
    const { scope } = createScope();
    let seenTitle: string | undefined;
    let frozen = false;
    registered.push(
      registry.bind(scope)({
        id: "loader-policy",
        apiVersion: 1,
        contribute: (context) => {
          seenTitle = context.session.workflow.nodes[0].title;
          frozen = Object.isFrozen(context.session);
          return [
            {
              kind: "set-widget",
              target: { nodeId: "10", widget: "lora_name" },
              value: "soft.safetensors",
            },
          ];
        },
      }),
    );

    const [group] = collect();
    // The SDK snapshot, not the host's: a contributor plans from the same
    // projection `getSession` hands out.
    expect(seenTitle).toBe("Load LoRA");
    expect(frozen).toBe(true);
    expect(group.widgetOverrides).toEqual([
      { node_id: "10", widget: "lora_name", value: "soft.safetensors" },
    ]);
  });

  it("refuses a duplicate id from one owner without leaving a registration behind", () => {
    const { scope } = createScope();
    const register = registry.bind(scope);
    registered.push(register(contributorDefinition("loader-policy", () => [])));

    expect(() =>
      register(contributorDefinition("loader-policy", () => [])),
    ).toThrow();
    expect(generationSubmissionContributors.size()).toBe(1);
  });

  it("lets two owners register the same local id", () => {
    const first = createScope("example.one");
    const second = createScope("example.two");
    registered.push(
      registry.bind(first.scope)(contributorDefinition("policy", () => [])),
      registry.bind(second.scope)(contributorDefinition("policy", () => [])),
    );

    expect(collect().map((group) => group.source)).toEqual([
      "extension:example.one/policy",
      "extension:example.two/policy",
    ]);
  });

  it("removes the contribution when the activation ends", () => {
    const { scope, resources } = createScope();
    registry.bind(scope)(contributorDefinition("loader-policy", () => []));
    expect(generationSubmissionContributors.size()).toBe(1);

    disposeAll(resources);
    expect(generationSubmissionContributors.size()).toBe(0);
  });

  it("contributes nothing once the activation is aborted", () => {
    const { scope, controller } = createScope();
    const contribute = vi.fn(() => []);
    registered.push(
      registry.bind(scope)(contributorDefinition("loader-policy", contribute)),
    );

    controller.abort();
    const [group] = collect();
    expect(contribute).not.toHaveBeenCalled();
    expect(group.diagnostics).toEqual([]);
    expect(group.widgetOverrides).toEqual([]);
  });

  it("reports a throwing callback on its owner and fails the submission", () => {
    const report = vi.fn();
    const { scope } = createScope("example.lora-policy", report);
    registered.push(
      registry.bind(scope)(
        contributorDefinition("loader-policy", () => {
          throw new Error("extension bug");
        }),
      ),
    );

    const [group] = collect();
    expect(report).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("example.lora-policy/loader-policy"),
      expect.any(Error),
    );
    expect(group.diagnostics[0]).toMatchObject({ code: "contributor-failed" });
    // The public failure says nothing about host internals.
    expect(group.diagnostics[0].message).not.toContain("extension bug");
  });

  it("rejects effects that break the published bounds", () => {
    const cases: readonly [string, unknown][] = [
      ["not an array", "nope"],
      ["unknown kind", [{ kind: "delete-node", nodeIds: ["10"] }]],
      ["missing node ids", [{ kind: "bypass-nodes" }]],
      [
        "oversized value",
        [
          {
            kind: "set-widget",
            target: { nodeId: "10", widget: "lora_name" },
            value: "x".repeat(200_000),
          },
        ],
      ],
      [
        "non-finite value",
        [
          {
            kind: "set-widget",
            target: { nodeId: "10", widget: "lora_name" },
            value: Number.POSITIVE_INFINITY,
          },
        ],
      ],
      [
        "empty target",
        [{ kind: "set-widget", target: { nodeId: "", widget: "" }, value: 1 }],
      ],
      [
        "too many effects",
        Array.from({ length: 65 }, () => ({
          kind: "bypass-nodes",
          nodeIds: ["10"],
        })),
      ],
    ];

    cases.forEach(([name, returned], index) => {
      const { scope } = createScope(`example.case-${index}`);
      const registration = registry.bind(scope)({
        id: "policy",
        apiVersion: 1,
        contribute: () =>
          returned as readonly ExtensionGenerationGraphEffect[],
      });

      const [group] = collect();
      // Refused whole, not partially applied: half a policy is a result
      // nobody asked for.
      expect(group.diagnostics[0], name).toMatchObject({
        code: "contributor-failed",
      });
      expect(group.widgetOverrides, name).toEqual([]);
      expect(group.bypassNodeIds, name).toEqual([]);
      registration.dispose();
    });
  });

  it("requires apiVersion 1 and a callback", () => {
    const { scope } = createScope();
    const register = registry.bind(scope);
    expect(() =>
      register({
        id: "policy",
        apiVersion: 2 as unknown as 1,
        contribute: () => [],
      }),
    ).toThrow(/apiVersion 1/);
    expect(() =>
      register({
        id: "policy",
        apiVersion: 1,
        contribute: undefined as unknown as () => [],
      }),
    ).toThrow(/contribute/);
    expect(generationSubmissionContributors.size()).toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  ExtensionActivationCancelledError,
  ExtensionActivationError,
  ExtensionActivationTimeoutError,
  ExtensionContributionRegistry,
  ExtensionDeactivationError,
  ExtensionHost,
  ExtensionLifecycleStateError,
  InvalidExtensionResourceError,
  type ExtensionApiScope,
  type ExtensionContext,
  type ExtensionContributionDefinition,
  type ExtensionDiagnostic,
  type ExtensionDisposable,
} from "..";

interface TestContribution extends ExtensionContributionDefinition {
  value: string;
}

interface TestApi {
  register(definition: TestContribution): void;
}

interface HarnessOptions {
  activationTimeoutMs?: number | null;
  maxDiagnostics?: number;
  onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void;
}

function createHarness(options: HarnessOptions = {}) {
  const registry = new ExtensionContributionRegistry<TestContribution>(
    "test.registry",
  );
  const scopes: ExtensionApiScope[] = [];
  let timestamp = 100;
  const host = new ExtensionHost<TestApi>({
    sdkVersion: "1.0.0",
    now: () => timestamp++,
    ...options,
    createApi: (scope) => {
      scopes.push(scope);
      const registrar = registry.bind(scope);
      return {
        register: (definition) => {
          registrar.register(definition);
        },
      };
    },
  });

  return { host, registry, scopes };
}

describe("ExtensionHost", () => {
  it("supplies identity, SDK version, logging, and owner-scoped APIs", async () => {
    const { host, registry, scopes } = createHarness();
    let receivedContext: ExtensionContext<TestApi> | undefined;

    await host.activate(
      { id: "example.extension", version: "2.3.4" },
      {
        activate: (context) => {
          receivedContext = context;
          context.api.register({
            id: "feature",
            apiVersion: 1,
            value: "registered",
          });
          context.logger.info("Extension says hello.", { answer: 42 });
        },
      },
    );

    expect(receivedContext?.extension).toEqual({
      id: "example.extension",
      version: "2.3.4",
    });
    expect(receivedContext?.sdkVersion).toBe("1.0.0");
    expect(scopes[0]?.extension.id).toBe("example.extension");
    expect(registry.get("example.extension/feature")?.definition.value).toBe(
      "registered",
    );
    expect(host.getState("example.extension")?.status).toBe("active");
    expect(
      host
        .getDiagnostics("example.extension")
        .some((diagnostic) => diagnostic.message === "Extension says hello."),
    ).toBe(true);
  });

  it("rolls back owned registrations and resources when activation fails", async () => {
    const { host, registry, scopes } = createHarness();
    const cleanup = vi.fn();

    await expect(
      host.activate(
        { id: "example.failure", version: "1.0.0" },
        {
          activate: (context) => {
            context.api.register({
              id: "partial",
              apiVersion: 1,
              value: "must disappear",
            });
            context.onDispose(cleanup);
            throw new Error("Activation exploded");
          },
        },
      ),
    ).rejects.toBeInstanceOf(ExtensionActivationError);

    expect(scopes[0]?.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(registry.list()).toHaveLength(0);
    expect(host.getState("example.failure")?.status).toBe("failed");
  });

  it("disposes resources in reverse order and aborts before cleanup", async () => {
    const { host, registry } = createHarness();
    const events: string[] = [];

    await host.activate(
      { id: "example.cleanup", version: "1.0.0" },
      {
        activate: (context) => {
          context.api.register({
            id: "owned",
            apiVersion: 1,
            value: "temporary",
          });
          context.onDispose(() => {
            events.push(`first:${context.signal.aborted}`);
          });
          context.onDispose(() => {
            events.push(`second:${context.signal.aborted}`);
          });
          return () => {
            events.push(`returned:${context.signal.aborted}`);
          };
        },
      },
    );

    await expect(host.deactivate("example.cleanup")).resolves.toBe(true);

    expect(events).toEqual(["returned:true", "second:true", "first:true"]);
    expect(registry.list()).toHaveLength(0);
    expect(host.getState("example.cleanup")?.status).toBe("inactive");
  });

  it("does not dispose the same resource twice when it is also returned", async () => {
    const { host } = createHarness();
    const cleanup = vi.fn();

    await host.activate(
      { id: "example.deduplicate", version: "1.0.0" },
      {
        activate: (context) => {
          context.onDispose(cleanup);
          return cleanup;
        },
      },
    );
    await host.deactivate("example.deduplicate");

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("rejects concurrent activation for the same extension", async () => {
    const { host } = createHarness();
    let releaseActivation: (() => void) | undefined;
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });

    const firstActivation = host.activate(
      { id: "example.concurrent", version: "1.0.0" },
      { activate: () => activationGate },
    );

    await expect(
      host.activate(
        { id: "example.concurrent", version: "1.0.0" },
        { activate: () => undefined },
      ),
    ).rejects.toBeInstanceOf(ExtensionLifecycleStateError);

    releaseActivation?.();
    await firstActivation;
  });

  it("can deactivate an in-flight activation through its abort signal", async () => {
    const { host } = createHarness();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const activation = host.activate(
      { id: "example.in-flight", version: "1.0.0" },
      {
        activate: (context) =>
          new Promise<void>((_resolve, reject) => {
            markStarted?.();
            if (context.signal.aborted) {
              reject(new Error("Aborted before activation started"));
              return;
            }
            context.signal.addEventListener(
              "abort",
              () => reject(new Error("Activation observed abort")),
              { once: true },
            );
          }),
      },
    );
    const activationResult = expect(activation).rejects.toBeInstanceOf(
      ExtensionActivationCancelledError,
    );

    await started;
    await expect(host.deactivate("example.in-flight")).resolves.toBe(true);
    await activationResult;

    expect(host.getState("example.in-flight")?.status).toBe("inactive");
  });

  it("times out an activation that does not settle", async () => {
    vi.useFakeTimers();
    try {
      const { host } = createHarness({ activationTimeoutMs: 50 });
      const activation = host.activate(
        { id: "example.timeout", version: "1.0.0" },
        { activate: () => new Promise<void>(() => undefined) },
      );
      const activationResult = expect(activation).rejects.toBeInstanceOf(
        ExtensionActivationError,
      );

      await vi.advanceTimersByTimeAsync(50);
      await activationResult;

      expect(host.getState("example.timeout")?.error).toBeInstanceOf(
        ExtensionActivationTimeoutError,
      );
      expect(host.getState("example.timeout")?.status).toBe("failed");
      await expect(host.deactivate("example.timeout")).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes contributions registered after an activation timeout", async () => {
    vi.useFakeTimers();
    try {
      const { host, registry } = createHarness({ activationTimeoutMs: 50 });
      let releaseActivation: (() => void) | undefined;
      const activationGate = new Promise<void>((resolve) => {
        releaseActivation = resolve;
      });
      const activation = host.activate(
        { id: "example.late", version: "1.0.0" },
        {
          activate: async (context) => {
            await activationGate;
            context.api.register({
              id: "too-late",
              apiVersion: 1,
              value: "must not leak",
            });
          },
        },
      );
      const activationResult = expect(activation).rejects.toBeInstanceOf(
        ExtensionActivationError,
      );

      await vi.advanceTimersByTimeAsync(50);
      await activationResult;
      releaseActivation?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(registry.list()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues cleanup after a disposer fails and reports the errors", async () => {
    const { host, registry } = createHarness();
    const finalCleanup = vi.fn();

    await host.activate(
      { id: "example.cleanup-failure", version: "1.0.0" },
      {
        activate: (context) => {
          context.api.register({
            id: "owned",
            apiVersion: 1,
            value: "temporary",
          });
          context.onDispose(finalCleanup);
          context.onDispose(() => {
            throw new Error("Cleanup exploded");
          });
        },
      },
    );

    await expect(
      host.deactivate("example.cleanup-failure"),
    ).rejects.toBeInstanceOf(ExtensionDeactivationError);

    expect(finalCleanup).toHaveBeenCalledOnce();
    expect(registry.list()).toHaveLength(0);
    expect(host.getState("example.cleanup-failure")?.status).toBe("failed");
  });

  it("deactivates extensions in reverse activation order", async () => {
    const { host } = createHarness();
    const order: string[] = [];

    await host.activate(
      { id: "example.first", version: "1.0.0" },
      {
        activate: () => () => {
          order.push("first");
        },
      },
    );
    await host.activate(
      { id: "example.second", version: "1.0.0" },
      {
        activate: () => () => {
          order.push("second");
        },
      },
    );

    await host.deactivateAll();

    expect(order).toEqual(["second", "first"]);
  });

  it("rejects invalid resources when they are registered", async () => {
    const { host } = createHarness();

    await expect(
      host.activate(
        { id: "example.invalid-resource", version: "1.0.0" },
        {
          activate: (context) => {
            context.onDispose({} as ExtensionDisposable);
          },
        },
      ),
    ).rejects.toBeInstanceOf(ExtensionActivationError);

    expect(host.getState("example.invalid-resource")?.error).toBeInstanceOf(
      InvalidExtensionResourceError,
    );
  });

  it("caps retained diagnostics while continuing to publish them", async () => {
    const published: ExtensionDiagnostic[] = [];
    const { host } = createHarness({
      maxDiagnostics: 3,
      onDiagnostic: (diagnostic) => published.push(diagnostic),
    });

    await host.activate(
      { id: "example.chatty", version: "1.0.0" },
      {
        activate: (context) => {
          context.logger.info("one");
          context.logger.info("two");
          context.logger.info("three");
          context.logger.info("four");
        },
      },
    );

    expect(host.getDiagnostics()).toHaveLength(3);
    expect(host.getDiagnostics().map((diagnostic) => diagnostic.message)).toEqual([
      "three",
      "four",
      "Activation completed.",
    ]);
    expect(published).toHaveLength(6);
  });
});

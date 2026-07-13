import type {
  ExtensionContext,
  ExtensionModule,
} from "@vlo/extension-sdk";

export const activate: ExtensionModule["activate"] = (
  context: ExtensionContext,
) => {
  // Prefer scoped APIs. If they cannot express the feature, discover exact live
  // internals through context.api.trusted.host and register raw cleanup here.
  context.logger.info("Minimal frontend extension activated.", {
    sdkVersion: context.sdkVersion,
  });

  const handleAbort = () => {
    context.logger.info("Minimal frontend extension received its abort signal.");
  };
  context.signal.addEventListener("abort", handleAbort, { once: true });
  context.onDispose(() => {
    context.signal.removeEventListener("abort", handleAbort);
    context.logger.info("Minimal frontend extension disposed.");
  });
};

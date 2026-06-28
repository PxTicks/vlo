import type {
  ExtensionContext,
  ExtensionModule,
} from "@vlo/extension-sdk";

export const activate: ExtensionModule["activate"] = (
  context: ExtensionContext,
) => {
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

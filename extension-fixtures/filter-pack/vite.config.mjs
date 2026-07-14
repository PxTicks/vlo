import { createExtensionBuildConfig } from "../../extension-template/vite.config.mjs";

export default createExtensionBuildConfig(new URL(".", import.meta.url).pathname);

/// <reference types="vite/client" />
/// <reference types="@types/wicg-file-system-access" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION: string | null;
  readonly VITE_HMR_PROTOCOL?: "ws" | "wss";
  readonly VITE_HMR_CLIENT_PORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HERMES_KEY: string;
  readonly VITE_HERMES_SESSION_KEY: string;
  readonly VITE_FEISHU_CHAT_ID: string;
  readonly VITE_WORKBENCH_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

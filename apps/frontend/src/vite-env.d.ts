/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Donkeyfolio fork identity (loaded from .env.local via Vite envPrefix)
  readonly DONKEYFOLIO_GITHUB_OWNER?: string;
  readonly DONKEYFOLIO_GITHUB_REPO?: string;
  readonly DONKEYFOLIO_SUPPORT_EMAIL?: string;
  readonly DONKEYFOLIO_APP_NAME?: string;
  readonly DONKEYFOLIO_BUNDLE_ID?: string;
  readonly DONKEYFOLIO_DEEP_LINK_SCHEME?: string;
  readonly DONKEYFOLIO_ADDON_STORE_URL?: string;
  readonly DONKEYFOLIO_UPDATER_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

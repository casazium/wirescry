// Set by Vite at build time: true for `npm run dev`, false for production builds.
interface ImportMetaEnv {
  readonly DEV: boolean;
  /** When this build was made (ISO 8601). Set in electron.vite.config.ts. */
  readonly WIRESCRY_RELEASE_DATE: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

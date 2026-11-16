/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by packages/dev-host: the sim's fixed time, which ages are measured from. Absent outside the dev loop. */
  readonly VITE_LETTERBOX_NOW?: string
}

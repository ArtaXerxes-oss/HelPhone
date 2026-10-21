/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAPBOX_TOKEN: string
  readonly VITE_HELPHONE_CONTRACT_ID: string
  readonly VITE_AEGIS_VAULT_ID: string
  readonly VITE_FRIENDBOT_URL: string
  readonly VITE_ZK_PROVER_URL: string
  readonly VITE_ZK_BROWSER_FALLBACK: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

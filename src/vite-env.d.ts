/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Environment variables injected by Vite at build-time. `VITE_*` are exposed to
// the client by design (the anon key is public with RLS as the protection).
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

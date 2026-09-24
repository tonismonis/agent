import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The design preview: its own root, port and config, so nothing here can reach
// the app's `vite build`. Local dev only; there is deliberately no build step.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { tsconfigPaths: true },
  plugins: [tailwindcss(), viteReact()],
  server: { port: 3100, strictPort: true },
})

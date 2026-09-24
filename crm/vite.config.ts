import { defineConfig } from 'vitest/config'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    // Vite already forwards browser console to the terminal; devtools piping
    // on top sends each server log to the browser and back, forever.
    devtools({ consolePiping: { enabled: false } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  test: {
    setupFiles: ['./src/test/setup.ts'],
    // Database integration tests share one local schema.
    fileParallelism: false,
  },
})

export default config

import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const zelavisDevServer =
  process.env.ZELAVIS_DEV_SERVER ?? 'http://127.0.0.1:3000'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    proxy: {
      '/api': {
        target: zelavisDevServer,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/zelavis/api'),
      },
      '/zelavis/api': {
        target: zelavisDevServer,
        changeOrigin: true,
      },
    },
  },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
      },
    }),
    viteReact(),
  ],
})

export default config

import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const zelavisDevServer =
  process.env.ZELAVIS_DEV_SERVER ?? 'http://127.0.0.1:3000'
const zelavisUiBasePath = normalizeBasePath(
  process.env.ZELAVIS_UI_BASE_PATH ?? '/',
)

function normalizeBasePath(path: string): string {
  if (!path || path === '/') {
    return '/'
  }

  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`
  return `${withLeadingSlash.replace(/\/+$/, '')}/`
}

const config = defineConfig({
  base: zelavisUiBasePath,
  resolve: { tsconfigPaths: true },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return
          }

          if (id.includes('/@base-ui/')) {
            return 'base-ui'
          }

          if (id.includes('/@tanstack/')) {
            return 'tanstack'
          }

          if (id.includes('/react') || id.includes('/scheduler')) {
            return 'react'
          }

          if (id.includes('/swiper/') || id.includes('/embla-carousel')) {
            return 'interaction'
          }

          return 'vendor'
        },
      },
    },
  },
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

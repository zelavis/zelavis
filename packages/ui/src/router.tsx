import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

function getRootPath() {
  if (typeof window === 'undefined') {
    return undefined
  }

  const rootPath = window.__ZELAVIS_RUNTIME_CONFIG__?.rootPath
  if (!rootPath || rootPath === '/') {
    return undefined
  }

  return rootPath
}

function getRuntimeRootRewrite() {
  const rootPath = getRootPath()
  if (!rootPath) {
    return undefined
  }

  return {
    input: ({ url }: { url: URL }) => {
      if (
        url.pathname === rootPath ||
        url.pathname.startsWith(`${rootPath}/`)
      ) {
        const rewritten = new URL(url)
        rewritten.pathname = rewritten.pathname.slice(rootPath.length) || '/'
        return rewritten
      }

      return url
    },
    output: ({ url }: { url: URL }) => {
      if (
        url.pathname === rootPath ||
        url.pathname.startsWith(`${rootPath}/`)
      ) {
        return url
      }

      const rewritten = new URL(url)
      rewritten.pathname =
        url.pathname === '/'
          ? rootPath
          : `${rootPath}${url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`}`
      return rewritten
    },
  }
}

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    rewrite: getRuntimeRootRewrite(),
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}

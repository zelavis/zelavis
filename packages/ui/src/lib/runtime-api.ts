export interface RuntimeService {
  name: string
  core: boolean
  apiPath: string
}

export interface RuntimeConfig {
  name: string
  rootPath: string
  api: {
    prefix: string
    version: string
    basePath: string
  }
  dashboard: {
    title: string
    clientRoutes: string[]
    assetRoot: string
  }
  services: RuntimeService[]
}

declare global {
  interface Window {
    __ZELAVIS_RUNTIME_CONFIG__?: RuntimeConfig
  }
}

export interface DatabaseHealth {
  status: string
  driver: string
  capabilities: Record<string, boolean>
  defaultTenantId: string
}

export interface DatabaseCollection {
  name: string
  tenantId: string
  createdAt: string
  documentCount: number
  metadata?: Record<string, unknown>
}

export interface DatabaseDocument {
  id: string
  tenantId: string
  collection: string
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
  version: number
}

const fallbackConfig: RuntimeConfig = {
  name: 'zelavis',
  rootPath: '',
  api: {
    prefix: '/api',
    version: 'v1',
    basePath: '/api/v1',
  },
  dashboard: {
    title: 'zelavis',
    clientRoutes: [
      '/agents',
      '/auth',
      '/builder',
      '/commerce',
      '/content',
      '/database',
      '/services',
      '/settings',
    ],
    assetRoot: '/assets',
  },
  services: [
    { name: 'dashboard', core: true, apiPath: '/' },
    { name: 'auth', core: true, apiPath: '/api/v1/auth' },
    { name: 'database', core: true, apiPath: '/api/v1/database' },
  ],
}

function inferRootPath(): string {
  if (typeof window === 'undefined') {
    return ''
  }

  const segment = window.location.pathname.split('/').filter(Boolean)[0]
  return segment === 'zelavis' ? '/zelavis' : ''
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('accept', 'application/json')
  headers.set('content-type', 'application/json')

  const response = await fetch(path, {
    ...init,
    headers,
  })

  if (!response.ok) {
    let message = `Request failed: ${response.status}`

    try {
      const body = (await response.json()) as { error?: unknown }
      if (typeof body.error === 'string' && body.error.length > 0) {
        message = body.error
      }
    } catch {
      // Keep the status-only fallback when the response is not JSON.
    }

    throw new Error(message)
  }

  return response.json() as Promise<T>
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  if (typeof window !== 'undefined' && window.__ZELAVIS_RUNTIME_CONFIG__) {
    return window.__ZELAVIS_RUNTIME_CONFIG__
  }

  const rootPath = inferRootPath()

  try {
    return await readJson<RuntimeConfig>(
      `${rootPath}/api/v1/dashboard/config`,
    )
  } catch {
    return {
      ...fallbackConfig,
      rootPath,
      api: {
        ...fallbackConfig.api,
        basePath: `${rootPath}/api/v1`,
      },
      services: fallbackConfig.services.map((service) => ({
        ...service,
        apiPath:
          service.name === 'dashboard'
            ? rootPath || '/'
            : `${rootPath}/api/v1/${service.name}`,
      })),
    }
  }
}

export async function getDatabaseHealth(config: RuntimeConfig) {
  return readJson<DatabaseHealth>(`${config.api.basePath}/database/health`)
}

export async function listAuthProviders(config: RuntimeConfig) {
  return readJson<string[]>(`${config.api.basePath}/auth/providers`)
}

export async function listDatabaseCollections(config: RuntimeConfig) {
  const result = await readJson<{ collections: DatabaseCollection[] }>(
    `${config.api.basePath}/database/documents/collections`,
  )

  return result.collections
}

export async function createDatabaseCollection(
  config: RuntimeConfig,
  input: {
    name: string
    metadata?: Record<string, unknown>
    tenantId?: string
  },
) {
  return readJson<DatabaseCollection>(
    `${config.api.basePath}/database/documents/collections`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  )
}

export async function queryDatabaseDocuments(
  config: RuntimeConfig,
  collection: string,
) {
  const result = await readJson<{ documents: DatabaseDocument[] }>(
    `${config.api.basePath}/database/documents/${encodeURIComponent(collection)}/query`,
    {
      method: 'POST',
      body: JSON.stringify({
        limit: 25,
      }),
    },
  )

  return result.documents
}

export async function insertDatabaseDocument(
  config: RuntimeConfig,
  input: {
    collection: string
    data: Record<string, unknown>
    id?: string
    tenantId?: string
  },
) {
  return readJson<DatabaseDocument>(
    `${config.api.basePath}/database/documents/${encodeURIComponent(input.collection)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        data: input.data,
        id: input.id || undefined,
        tenantId: input.tenantId || undefined,
      }),
    },
  )
}

export async function updateDatabaseDocument(
  config: RuntimeConfig,
  input: {
    collection: string
    id: string
    data: Record<string, unknown>
    mode?: 'merge' | 'replace'
    tenantId?: string
  },
) {
  return readJson<DatabaseDocument>(
    `${config.api.basePath}/database/documents/${encodeURIComponent(input.collection)}/${encodeURIComponent(input.id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        data: input.data,
        mode: input.mode ?? 'merge',
        tenantId: input.tenantId || undefined,
      }),
    },
  )
}

export async function deleteDatabaseDocument(
  config: RuntimeConfig,
  input: {
    collection: string
    id: string
    tenantId?: string
  },
) {
  return readJson<{ deleted: boolean }>(
    `${config.api.basePath}/database/documents/${encodeURIComponent(input.collection)}/${encodeURIComponent(input.id)}${input.tenantId ? `?tenantId=${encodeURIComponent(input.tenantId)}` : ''}`,
    {
      method: 'DELETE',
    },
  )
}

export async function seedDemoDatabase(config: RuntimeConfig) {
  const collections = await listDatabaseCollections(config)
  if (!collections.some((collection) => collection.name === 'products')) {
    await createDatabaseCollection(config, {
      name: 'products',
      metadata: {
        seededBy: 'zelavis-dashboard',
      },
    })
  }

  const timestamp = Date.now()
  await insertDatabaseDocument(config, {
    collection: 'products',
    id: `starter-product-${timestamp}`,
    data: {
      name: 'Starter Product',
      slug: `starter-product-${timestamp}`,
      price: 4900,
      currency: 'EUR',
      status: 'draft',
    },
  })

  await insertDatabaseDocument(config, {
    collection: 'products',
    id: `service-plan-${timestamp}`,
    data: {
      name: 'Service Plan',
      slug: `service-plan-${timestamp}`,
      price: 9900,
      currency: 'EUR',
      status: 'active',
    },
  })
}

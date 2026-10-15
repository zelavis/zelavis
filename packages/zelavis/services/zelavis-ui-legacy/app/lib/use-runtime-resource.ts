import { useCallback, useEffect, useState } from 'react'

import type * as React from 'react'

export interface RuntimeResourceState<TData> {
  data: TData | undefined
  error: Error | undefined
  loading: boolean
  reload: () => void
}

export function useRuntimeResource<TData>(
  loader: () => Promise<TData>,
  deps: React.DependencyList = [],
): RuntimeResourceState<TData> {
  const [data, setData] = useState<TData>()
  const [error, setError] = useState<Error>()
  const [loading, setLoading] = useState(true)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((current) => current + 1), [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(undefined)

    loader()
      .then((value) => {
        if (active) {
          setData(value)
        }
      })
      .catch((caught) => {
        if (active) {
          setError(caught instanceof Error ? caught : new Error(String(caught)))
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [version, ...deps])

  return {
    data,
    error,
    loading,
    reload,
  }
}

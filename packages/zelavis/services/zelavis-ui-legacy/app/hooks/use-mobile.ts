import * as React from "react"

export const DASHBOARD_MOBILE_BREAKPOINT = 1024

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(() =>
    typeof window === "undefined"
      ? false
      : window.innerWidth < DASHBOARD_MOBILE_BREAKPOINT
  )

  React.useEffect(() => {
    const mql = window.matchMedia(
      `(max-width: ${DASHBOARD_MOBILE_BREAKPOINT - 1}px)`
    )
    const onChange = () => {
      setIsMobile(window.innerWidth < DASHBOARD_MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < DASHBOARD_MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}

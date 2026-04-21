"use client"

import * as React from "react"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react"

import {
  Carousel,
  CarouselContent,
  CarouselItem,
  type CarouselApi,
} from "#/components/ui/carousel"
import { useDirection } from "#/components/ui/direction"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar"
import type { DashboardNavItem } from "#/lib/dashboard-data"

type NavChildItem = {
  title: string
  url?: string
  icon?: LucideIcon
  items?: readonly NavChildItem[]
}

type NavPanel = {
  title: string
  items: readonly NavChildItem[]
}

function encodePanelTitle(title: string) {
  return encodeURIComponent(title)
}

function panelSearchValue(trail: NavPanel[]) {
  if (trail.length === 0) {
    return undefined
  }

  return trail.map((panel) => encodePanelTitle(panel.title)).join("/")
}

function itemContainsPath(
  item: DashboardNavItem | NavChildItem,
  pathname: string,
): boolean {
  return item.url === pathname || Boolean(item.items?.some((child) => itemContainsPath(child, pathname)))
}

function findActiveTrail(
  items: readonly DashboardNavItem[],
  pathname: string,
): NavPanel[] {
  for (const item of items) {
    if (!item.items?.length || !itemContainsPath(item, pathname)) {
      continue
    }

    const panels: NavPanel[] = [{ title: item.title, items: item.items }]
    let current: NavChildItem | undefined = item.items.find(
      (child) => child.items?.length && itemContainsPath(child, pathname),
    )

    while (current?.items?.length) {
      panels.push({ title: current.title, items: current.items })
      current = current.items.find(
        (child) => child.items?.length && itemContainsPath(child, pathname),
      )
    }

    return panels
  }

  return []
}

function findTrailByTitles(
  items: readonly DashboardNavItem[],
  titles: string[],
): NavPanel[] {
  const panels: NavPanel[] = []
  let currentItems: ReadonlyArray<DashboardNavItem | NavChildItem> = items

  for (const title of titles) {
    const match = currentItems.find(
      (item) => item.title === title && item.items?.length,
    )

    if (!match?.items?.length) {
      return []
    }

    panels.push({ title: match.title, items: match.items })
    currentItems = match.items
  }

  return panels
}

function parseSidebarSearch(value: unknown) {
  if (typeof value !== "string" || value.length === 0) {
    return []
  }

  try {
    return value
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .filter(Boolean)
  } catch {
    return []
  }
}

export function NavMain({ items }: { items: readonly DashboardNavItem[] }) {
  const navigate = useNavigate({ from: "/" })
  const location = useRouterState({ select: (state) => state.location })
  const pathname = location.pathname
  const sidebarSearch = location.search.sidebar
  const direction = useDirection()
  const [api, setApi] = React.useState<CarouselApi>()
  const hasSyncedInitialSlideRef = React.useRef(false)
  const backAnimationCleanupRef = React.useRef<(() => void) | null>(null)
  const [trail, setTrail] = React.useState<NavPanel[]>(() => {
    const routeTrail = findActiveTrail(items, pathname)

    if (routeTrail.length > 0) {
      return routeTrail
    }

    return findTrailByTitles(items, parseSidebarSearch(sidebarSearch))
  })
  const panels = React.useMemo<NavPanel[]>(
    () => [{ title: "Platform", items }, ...trail],
    [items, trail],
  )
  const currentIndex = trail.length

  const syncSidebarSearch = React.useCallback(
    (nextTrail: NavPanel[], replace = true) => {
      void navigate({
        replace,
        search: (previous) => ({
          ...previous,
          sidebar: panelSearchValue(nextTrail),
        }),
      })
    },
    [navigate],
  )

  React.useEffect(() => {
    const routeTrail = findActiveTrail(items, pathname)

    if (routeTrail.length > 0) {
      setTrail(routeTrail)
      return
    }

    setTrail(findTrailByTitles(items, parseSidebarSearch(sidebarSearch)))
  }, [items, pathname, sidebarSearch, syncSidebarSearch])

  React.useEffect(() => {
    if (!api) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      api.reInit()
      api.scrollTo(currentIndex, !hasSyncedInitialSlideRef.current)
      hasSyncedInitialSlideRef.current = true
    })

    return () => window.cancelAnimationFrame(frame)
  }, [api, currentIndex, panels.length])

  React.useEffect(() => {
    return () => {
      clearBackAnimation()
    }
  }, [])

  function clearBackAnimation() {
    if (!backAnimationCleanupRef.current) {
      return
    }

    backAnimationCleanupRef.current()
    backAnimationCleanupRef.current = null
  }

  function openPanel(title: string, panelItems: readonly NavChildItem[]) {
    const nextTrail = [...trail, { title, items: panelItems }]

    clearBackAnimation()
    setTrail(nextTrail)
    syncSidebarSearch(nextTrail, false)
  }

  function goBack() {
    const nextTrail = trail.slice(0, -1)

    clearBackAnimation()

    if (!api) {
      setTrail(nextTrail)
      syncSidebarSearch(nextTrail, false)
      return
    }

    api.reInit()
    let hasFinished = false
    const finishBackAnimation = () => {
      if (hasFinished) {
        return
      }

      hasFinished = true
      cleanup()
      setTrail(nextTrail)
      syncSidebarSearch(nextTrail, false)
      backAnimationCleanupRef.current = null
    }
    const fallback = window.setTimeout(finishBackAnimation, 1500)
    const cleanup = () => {
      window.clearTimeout(fallback)
      api.off("settle", finishBackAnimation)
    }

    api.on("settle", finishBackAnimation)
    backAnimationCleanupRef.current = cleanup
    api.scrollTo(nextTrail.length)
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Platform</SidebarGroupLabel>
      <Carousel
        className="w-full overflow-hidden"
        opts={{
          align: "start",
          containScroll: false,
          direction,
          duration: 20,
          watchDrag: false,
        }}
        setApi={setApi}
        dir={direction}
        aria-label="Platform navigation"
      >
        <CarouselContent className="ml-0 w-full">
          {panels.map((panel, panelIndex) => (
            <CarouselItem
              key={`${panel.title}-${panelIndex}`}
              className="min-w-0 basis-full px-0"
              aria-hidden={panelIndex !== currentIndex}
            >
              <SidebarMenu>
                {panelIndex > 0 ? (
                  <SidebarMenuItem>
                    <SidebarMenuButton onClick={goBack} tooltip="Back">
                      <ChevronLeft className="rtl:rotate-180" />
                      <span>{panel.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ) : null}

                {panel.items.map((item) => {
                  const hasChildren = Boolean(item.items?.length)
                  const isActive = itemContainsPath(item, pathname)
                  const Icon = item.icon

                  return (
                    <SidebarMenuItem key={item.title}>
                      {hasChildren && item.items ? (
                        <SidebarMenuButton
                          isActive={isActive}
                          tooltip={item.title}
                          onClick={() => openPanel(item.title, item.items ?? [])}
                        >
                          {Icon ? <Icon /> : null}
                          <span>{item.title}</span>
                          <ChevronRight className="ms-auto rtl:rotate-180" />
                        </SidebarMenuButton>
                      ) : item.url ? (
                        <SidebarMenuButton
                          asChild
                          isActive={isActive}
                          tooltip={item.title}
                        >
                          <Link to={item.url}>
                            {Icon ? <Icon /> : null}
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                      ) : null}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </CarouselItem>
          ))}
        </CarouselContent>
      </Carousel>
    </SidebarGroup>
  )
}

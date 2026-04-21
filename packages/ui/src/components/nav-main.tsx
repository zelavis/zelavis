"use client"

import * as React from "react"
import { Link, useRouterState } from "@tanstack/react-router"
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

type NavItem = {
  title: string
  url?: string
  icon: LucideIcon
  isActive?: boolean
  items?: NavChildItem[]
}

type NavChildItem = {
  title: string
  url?: string
  icon?: LucideIcon
  items?: NavChildItem[]
}

type NavPanel = {
  title: string
  items: NavChildItem[]
}

function itemContainsPath(item: NavItem | NavChildItem, pathname: string): boolean {
  return item.url === pathname || Boolean(item.items?.some((child) => itemContainsPath(child, pathname)))
}

function findActiveTrail(items: NavItem[], pathname: string): NavPanel[] {
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

export function NavMain({ items }: { items: NavItem[] }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const direction = useDirection()
  const [api, setApi] = React.useState<CarouselApi>()
  const [trail, setTrail] = React.useState<NavPanel[]>(() =>
    findActiveTrail(items, pathname),
  )
  const panels = React.useMemo<NavPanel[]>(
    () => [{ title: "Platform", items }, ...trail],
    [items, trail],
  )
  const currentIndex = trail.length

  React.useEffect(() => {
    setTrail(findActiveTrail(items, pathname))
  }, [items, pathname])

  React.useEffect(() => {
    api?.scrollTo(currentIndex)
  }, [api, currentIndex])

  function openPanel(title: string, panelItems: NavChildItem[]) {
    setTrail((current) => [...current, { title, items: panelItems }])
  }

  function goBack() {
    setTrail((current) => current.slice(0, -1))
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
          duration: 18,
          startIndex: currentIndex,
          watchDrag: false,
        }}
        setApi={setApi}
        dir={direction}
        aria-label="Platform navigation"
      >
        <CarouselContent className="-ml-0">
          {panels.map((panel, panelIndex) => (
            <CarouselItem
              key={`${panel.title}-${panelIndex}`}
              className="min-w-0 basis-full ps-0"
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

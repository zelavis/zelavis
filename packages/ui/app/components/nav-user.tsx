import * as React from "react"
import {
  Bell,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  Home,
  Paintbrush,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react"
import { useNavigate } from "react-router"
import type { Swiper as SwiperInstance } from "swiper"
import { Swiper, SwiperSlide } from "swiper/react"

import { AssistantChat } from "#/components/assistant/AssistantChat"
import { Input } from "#/components/ui/input"
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar"
import { cn } from "#/lib/utils"

export type SidebarUtilityScreen =
  | "assistant"
  | "notifications"
  | "search"
  | "account"

type SidebarUtilityPanel = {
  title: string
  items: readonly SidebarUtilityItem[]
}

type SidebarUtilityItem = {
  title: string
  icon?: LucideIcon
  url?: string
  items?: readonly SidebarUtilityItem[]
  content?: React.ReactNode
}

const languages = [
  { code: "en", label: "English", region: "United States" },
  { code: "de", label: "Deutsch", region: "Deutschland" },
  { code: "sr", label: "Serbian", region: "Srbija" },
  { code: "es", label: "Spanish", region: "Espana" },
] as const

const screenLabels: Record<SidebarUtilityScreen, string> = {
  assistant: "Assistant",
  notifications: "Notifications",
  search: "Search",
  account: "Account",
}

const bottomIconButtonClassName =
  "min-w-0 basis-0 flex-1 justify-center px-0! has-[>svg:first-child]:pl-0! has-[>svg:last-child]:pr-0! [&>svg]:mx-auto"

export function NavUser({
  activeScreen,
  onHome,
  onScreenChange,
  user,
}: {
  activeScreen?: SidebarUtilityScreen | null
  onHome: () => void
  onScreenChange: (screen: SidebarUtilityScreen) => void
  user: {
    name: string
    email: string
    avatar: string
  }
}) {
  return (
    <SidebarMenu>
      <SidebarMenuItem className="flex min-w-0 gap-1">
        <SidebarMenuButton
          size="lg"
          tooltip="Home"
          className={cn(
            bottomIconButtonClassName,
            "group-data-[collapsible=icon]:hidden",
          )}
          onClick={onHome}
        >
          <Home className="size-4" />
          <span className="sr-only">Home</span>
        </SidebarMenuButton>
        <UtilityButton
          active={activeScreen === "assistant"}
          className="group-data-[collapsible=icon]:hidden"
          icon={Sparkles}
          label="Assistant"
          onClick={() => onScreenChange("assistant")}
        />
        <UtilityButton
          active={activeScreen === "notifications"}
          className="group-data-[collapsible=icon]:hidden"
          icon={Bell}
          label="Notifications"
          onClick={() => onScreenChange("notifications")}
        />
        <UtilityButton
          active={activeScreen === "search"}
          className="group-data-[collapsible=icon]:hidden"
          icon={Search}
          label="Search"
          onClick={() => onScreenChange("search")}
        />
        <UtilityButton
          active={activeScreen === "account"}
          icon={UserRound}
          label={`Account for ${user.name}, ${user.email}`}
          onClick={() => onScreenChange("account")}
          className="group-data-[collapsible=icon]:w-full"
        />
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function UtilityButton({
  active,
  className,
  icon: Icon,
  label,
  onClick,
}: {
  active?: boolean
  className?: string
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <SidebarMenuButton
      size="lg"
      tooltip={label}
      isActive={active}
      className={cn(bottomIconButtonClassName, className)}
      onClick={onClick}
    >
      <Icon className="size-4" />
      <span className="sr-only">{label}</span>
    </SidebarMenuButton>
  )
}

export function NavUserScreen({
  onClose,
  openedFromNested,
  screen,
  user,
}: {
  onClose: () => void
  openedFromNested: boolean
  screen: SidebarUtilityScreen
  user: {
    name: string
    email: string
    avatar: string
  }
}) {
  const [activeLanguage, setActiveLanguage] = React.useState<
    (typeof languages)[number]
  >(languages[0])
  const rootPanel = React.useMemo<SidebarUtilityPanel>(
    () =>
      buildUtilityPanel({
        activeLanguage,
        onNavigate: onClose,
        screen,
        setActiveLanguage,
        user,
      }),
    [activeLanguage, screen, user],
  )
  const direction = "ltr"
  const [swiper, setSwiper] = React.useState<SwiperInstance>()
  const [trail, setTrail] = React.useState<SidebarUtilityPanel[]>([])
  const panels = React.useMemo(
    () => [rootPanel, ...trail],
    [rootPanel, trail],
  )
  const currentIndex = trail.length

  React.useEffect(() => {
    setTrail([])
  }, [screen])

  React.useEffect(() => {
    if (!swiper) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      swiper.update()
      swiper.slideTo(currentIndex)
    })

    return () => window.cancelAnimationFrame(frame)
  }, [currentIndex, panels.length, swiper])

  function openPanel(panel: SidebarUtilityPanel) {
    setTrail((current) => [...current, panel])
  }

  function goBack() {
    setTrail((current) => current.slice(0, -1))
  }

  return (
    <SidebarGroup className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <Swiper
        className="min-h-0 min-w-0 w-full flex-1 overflow-hidden [&_.swiper-slide]:min-w-0 [&_.swiper-wrapper]:min-w-0"
        dir={direction}
        initialSlide={currentIndex}
        onSwiper={setSwiper}
        slidesPerView={1}
        speed={300}
        aria-label={`${screenLabels[screen]} menu`}
      >
        {panels.map((panel, index) => {
          const isRoot = index === 0

          return (
            <SwiperSlide
              key={`${screen}-${panel.title}-${index}`}
              className="h-full min-w-0 overflow-hidden"
              aria-hidden={index !== currentIndex}
            >
              <div className="flex h-full min-h-0 min-w-0 flex-col gap-1 overflow-hidden pr-1">
                <div className="shrink-0">
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        className="relative justify-center font-semibold"
                        tooltip={
                          isRoot
                            ? openedFromNested
                              ? "Close"
                              : "Home"
                            : `Back to ${screenLabels[screen]}`
                        }
                        onClick={isRoot ? onClose : goBack}
                      >
                        {isRoot ? (
                          openedFromNested ? (
                            <X className="absolute left-3 rtl:left-auto rtl:right-3" />
                          ) : (
                            <Home className="absolute left-3 rtl:left-auto rtl:right-3" />
                          )
                        ) : (
                          <ChevronLeft className="absolute left-3 rtl:left-auto rtl:right-3 rtl:rotate-180" />
                        )}
                        <span className="px-8 text-center">{panel.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </div>

                <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pt-1">
                  <div className="flex min-h-0 min-w-0 w-full max-w-full shrink-0 flex-col gap-1">
                    <SidebarMenu>
                      {panel.items.map((item) => (
                        <UtilityScreenItem
                          key={item.title}
                          item={item}
                          onNavigate={onClose}
                          onOpenPanel={openPanel}
                        />
                      ))}
                    </SidebarMenu>
                  </div>
                </div>
              </div>
            </SwiperSlide>
          )
        })}
      </Swiper>
    </SidebarGroup>
  )
}

function UtilityScreenItem({
  item,
  onNavigate,
  onOpenPanel,
}: {
  item: SidebarUtilityItem
  onNavigate: () => void
  onOpenPanel: (panel: SidebarUtilityPanel) => void
}) {
  const navigate = useNavigate()
  const Icon = item.icon

  if (item.content) {
    return (
      <SidebarMenuItem>
        <div className="grid gap-2 px-2 py-2">{item.content}</div>
      </SidebarMenuItem>
    )
  }

  if (item.items?.length) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={item.title}
          onClick={() =>
            onOpenPanel({
              title: item.title,
              items: item.items ?? [],
            })
          }
        >
          {Icon ? <Icon /> : null}
          <span>{item.title}</span>
          <ChevronRight className="ms-auto rtl:rotate-180" />
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  if (!item.url) {
    return null
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={item.title}
        onClick={() => {
          navigate(item.url ?? "/", { viewTransition: true })
          onNavigate()
        }}
      >
        {Icon ? <Icon /> : null}
        <span>{item.title}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function buildUtilityPanel({
  activeLanguage,
  onNavigate,
  screen,
  setActiveLanguage,
  user,
}: {
  activeLanguage: (typeof languages)[number]
  onNavigate: () => void
  screen: SidebarUtilityScreen
  setActiveLanguage: (language: (typeof languages)[number]) => void
  user: {
    name: string
    email: string
    avatar: string
  }
}): SidebarUtilityPanel {
  switch (screen) {
    case "assistant":
      return {
        title: "Assistant",
        items: [
          {
            title: "Projects",
            icon: Home,
            items: [
              {
                title: "Default project",
                icon: Sparkles,
                items: [
                  {
                    title: "Ask Zelavis",
                    icon: Sparkles,
                    content: <AssistantChat compact onNavigate={onNavigate} />,
                  },
                  {
                    title: "Open project",
                    icon: Home,
                    url: "/projects/default",
                  },
                  {
                    title: "Content builder",
                    icon: Boxes,
                    url: "/projects/default/content",
                  },
                  {
                    title: "Database",
                    icon: Settings2,
                    url: "/projects/default/database",
                  },
                ],
              },
            ],
          },
          { title: "Open chat", icon: Sparkles, url: "/assistant" },
          { title: "Build a project", icon: Sparkles, url: "/projects?new=1" },
          { title: "Explore starters", icon: Boxes, url: "/marketplace" },
          { title: "Inspect services", icon: Settings2, url: "/services" },
        ],
      }
    case "notifications":
      return {
        title: "Notifications",
        items: [
          {
            title: "Security checklist",
            icon: ShieldCheck,
            url: "/security",
          },
          { title: "Server logs", icon: Bell, url: "/server/logs" },
          { title: "Resource usage", icon: Boxes, url: "/resources" },
        ],
      }
    case "search":
      return {
        title: "Search",
        items: [
          {
            title: "Search field",
            content: (
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  name="zelavis-sidebar-search"
                  aria-label="Search Zelavis"
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect="off"
                  enterKeyHint="search"
                  placeholder="Search Zelavis"
                  spellCheck={false}
                  className="pl-8"
                />
              </div>
            ),
          },
          { title: "Projects", icon: Home, url: "/projects" },
          { title: "Marketplace", icon: Boxes, url: "/marketplace" },
          { title: "Server", icon: Settings2, url: "/server" },
        ],
      }
    case "account":
      return {
        title: "Account",
        items: [
          {
            title: "Signed in",
            content: (
              <div className="grid gap-0.5 rounded-md border bg-muted/25 px-3 py-2 text-sm">
                <span className="truncate font-medium">{user.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
              </div>
            ),
          },
          { title: "Account overview", icon: UserRound, url: "/projects" },
          {
            title: "Settings",
            icon: Settings2,
            items: [
              { title: "Global settings", icon: Settings2, url: "/settings" },
              {
                title: "Appearance",
                icon: Paintbrush,
                url: "/settings/appearance",
              },
              {
                title: "Runtime services",
                icon: Boxes,
                url: "/services",
              },
              {
                title: "Language",
                icon: Bell,
                items: languages.map((language) => {
                  const isActive = language.code === activeLanguage.code

                  return {
                    title: `${language.label} (${language.region})`,
                    content: (
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                        onClick={() => setActiveLanguage(language)}
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-sm border text-xs font-medium uppercase">
                          {language.code}
                        </span>
                        <span className="grid min-w-0 flex-1">
                          <span className="truncate">{language.label}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {language.region}
                          </span>
                        </span>
                        {isActive ? <Check className="ms-auto size-4" /> : null}
                      </button>
                    ),
                  }
                }),
              },
            ],
          },
        ],
      }
  }
}

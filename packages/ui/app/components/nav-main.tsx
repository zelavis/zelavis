"use client";

import * as React from "react";
import { Link, useLocation, useMatches, useNavigate } from "react-router";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import type { Swiper as SwiperInstance } from "swiper";
import { Swiper, SwiperSlide } from "swiper/react";
import "swiper/css";

import { useDirection } from "#/components/ui/direction";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar";
import type {
  DashboardNavSearch,
  DashboardNavItem,
} from "#/lib/dashboard-data";
import {
  mergeSearchParams,
  readSearchParams,
  toDashboardPath,
} from "#/lib/routing";
import { getDashboardSidebarTrailFromMatches } from "#/lib/dashboard-route-handles";

type NavChildItem = {
  title: string;
  url?: string;
  search?: DashboardNavSearch;
  icon?: LucideIcon;
  panelLabel?: string;
  pluginOwned?: boolean;
  items?: readonly NavChildItem[];
};

type NavPanel = {
  title: string;
  panelLabel?: string;
  items: readonly NavChildItem[];
};

function encodePanelTitle(title: string) {
  return encodeURIComponent(title);
}

function panelSearchValue(trail: NavPanel[]) {
  if (trail.length === 0) {
    return undefined;
  }

  return trail.map((panel) => encodePanelTitle(panel.title)).join("/");
}

function itemContainsPath(
  item: DashboardNavItem | NavChildItem,
  pathname: string,
  search?: Record<string, unknown>,
): boolean {
  const routeMatches =
    item.url === pathname &&
    (!item.search ||
      Object.entries(item.search).every(
        ([key, value]) => value === undefined || search?.[key] === value,
      ));

  return (
    routeMatches ||
    Boolean(item.items?.some((child) => itemContainsPath(child, pathname, search)))
  );
}

function findActiveTrail(
  items: readonly DashboardNavItem[],
  pathname: string,
  search?: Record<string, unknown>,
): NavPanel[] {
  for (const item of items) {
    if (!item.items?.length || !itemContainsPath(item, pathname, search)) {
      continue;
    }

    const panels: NavPanel[] = [
      {
        title: item.title,
        panelLabel: item.panelLabel,
        items: item.items,
      },
    ];
    let current: NavChildItem | undefined = item.items.find(
      (child) => child.items?.length && itemContainsPath(child, pathname, search),
    );

    while (current?.items?.length) {
      panels.push({
        title: current.title,
        panelLabel: current.panelLabel,
        items: current.items,
      });
      current = current.items.find(
        (child) => child.items?.length && itemContainsPath(child, pathname, search),
      );
    }

    return panels;
  }

  return [];
}

function findTrailByTitles(
  items: readonly DashboardNavItem[],
  titles: string[],
): NavPanel[] {
  const panels: NavPanel[] = [];
  let currentItems: ReadonlyArray<DashboardNavItem | NavChildItem> = items;

  for (const title of titles) {
    const match = currentItems.find(
      (item) => item.title === title && item.items?.length,
    );

    if (!match?.items?.length) {
      return [];
    }

    panels.push({
      title: match.title,
      panelLabel: match.panelLabel,
      items: match.items,
    });
    currentItems = match.items;
  }

  return panels;
}

function parseSidebarSearch(value: unknown) {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }

  try {
    return value
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function routeIdentity(pathname: string, search: string) {
  const params = new URLSearchParams(search);
  params.delete("sidebar");
  const nextSearch = params.toString();

  return nextSearch ? `${pathname}?${nextSearch}` : pathname;
}

function panelTrailsEqual(left: readonly NavPanel[], right: readonly NavPanel[]) {
  return (
    left.length === right.length &&
    left.every((panel, index) => panel.title === right[index]?.title)
  );
}

function itemContainsPluginOwnedEntry(item: NavChildItem): boolean {
  return Boolean(
    item.pluginOwned || item.items?.some((child) => itemContainsPluginOwnedEntry(child)),
  );
}

export function NavMain({
  items,
}: {
  items: readonly DashboardNavItem[];
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const matches = useMatches();
  const pathname = location.pathname;
  const locationSearch = React.useMemo(
    () => readSearchParams(location.search),
    [location.search],
  );
  const sidebarSearch = locationSearch.sidebar;
  const routeSidebarTrailKey = [
    ...(getDashboardSidebarTrailFromMatches(matches) ?? []),
    ...(locationSearch.systemTable ? ["System Tables"] : []),
  ].join("\u0000");
  const routeSidebarTrail = React.useMemo(() => {
    if (!routeSidebarTrailKey) {
      return [];
    }

    return routeSidebarTrailKey.split("\u0000");
  }, [routeSidebarTrailKey]);
  const currentRouteIdentity = React.useMemo(
    () => routeIdentity(pathname, location.search),
    [location.search, pathname],
  );
  const direction = useDirection();
  const [swiper, setSwiper] = React.useState<SwiperInstance>();
  const hasSyncedInitialSlideRef = React.useRef(false);
  const shouldAnimateNextSlideRef = React.useRef(false);
  const manualTrailOverrideRef = React.useRef<NavPanel[] | null>(null);
  const lastRouteIdentityRef = React.useRef(currentRouteIdentity);
  const backAnimationCleanupRef = React.useRef<(() => void) | null>(null);
  const hideScrollbarsTimeoutRef = React.useRef<number | null>(null);
  const panelContentRefs = React.useRef<Array<HTMLDivElement | null>>([]);
  const [hideScrollbars, setHideScrollbars] = React.useState(false);
  const [trail, setTrail] = React.useState<NavPanel[]>(() => {
    const sidebarTrail = findTrailByTitles(items, parseSidebarSearch(sidebarSearch));

    if (typeof sidebarSearch === "string") {
      return sidebarTrail;
    }

    const handleTrail = findTrailByTitles(items, routeSidebarTrail);
    const routeTrail = findActiveTrail(items, pathname, locationSearch);

    if (handleTrail.length >= routeTrail.length && handleTrail.length > 0) {
      return handleTrail;
    }

    if (routeTrail.length > 0) {
      return routeTrail;
    }

    return sidebarTrail;
  });
  const applyTrail = React.useCallback((nextTrail: NavPanel[]) => {
    setTrail((currentTrail) =>
      panelTrailsEqual(currentTrail, nextTrail) ? currentTrail : nextTrail,
    );
  }, []);
  const panels = React.useMemo<NavPanel[]>(
    () => [{ title: "Platform", items }, ...trail],
    [items, trail],
  );
  const currentIndex = trail.length;

  const syncSidebarSearch = React.useCallback(
    (nextTrail: NavPanel[], replace = true) => {
      navigate(
        {
          pathname: location.pathname,
          search: mergeSearchParams(location.search, {
            sidebar: panelSearchValue(nextTrail),
          }),
        },
        { replace },
      );
    },
    [location.pathname, location.search, navigate],
  );

  React.useEffect(() => {
    clearBackAnimation();

    if (lastRouteIdentityRef.current !== currentRouteIdentity) {
      lastRouteIdentityRef.current = currentRouteIdentity;
      manualTrailOverrideRef.current = null;
    }

    if (manualTrailOverrideRef.current) {
      applyTrail(manualTrailOverrideRef.current);
      return;
    }

    if (typeof sidebarSearch === "string") {
      applyTrail(findTrailByTitles(items, parseSidebarSearch(sidebarSearch)));
      return;
    }

    const handleTrail = findTrailByTitles(items, routeSidebarTrail);
    const routeTrail = findActiveTrail(items, pathname, locationSearch);

    if (handleTrail.length >= routeTrail.length && handleTrail.length > 0) {
      applyTrail(handleTrail);
      return;
    }

    if (routeTrail.length > 0) {
      applyTrail(routeTrail);
      return;
    }

    applyTrail(findTrailByTitles(items, parseSidebarSearch(sidebarSearch)));
  }, [
    applyTrail,
    currentRouteIdentity,
    items,
    locationSearch,
    pathname,
    routeSidebarTrail,
    sidebarSearch,
  ]);

  React.useEffect(() => {
    if (!swiper) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      swiper.update();

      const duration =
        hasSyncedInitialSlideRef.current && shouldAnimateNextSlideRef.current
          ? undefined
          : 0;

      swiper.slideTo(currentIndex, duration);

      hasSyncedInitialSlideRef.current = true;
      shouldAnimateNextSlideRef.current = false;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [swiper, currentIndex, panels.length]);

  React.useEffect(() => {
    return () => {
      clearBackAnimation();
      clearHideScrollbarsTimeout();
    };
  }, []);

  React.useLayoutEffect(() => {
    resetPanelScroll(currentIndex);
  }, [currentIndex, panels.length]);

  function resetPanelScroll(index: number) {
    const panel = panelContentRefs.current[index];

    if (!panel) {
      return;
    }

    panel.scrollTop = 0;
    panel.scrollLeft = 0;
  }

  function clearBackAnimation() {
    if (!backAnimationCleanupRef.current) {
      return;
    }

    backAnimationCleanupRef.current();
    backAnimationCleanupRef.current = null;
  }

  function clearHideScrollbarsTimeout() {
    if (hideScrollbarsTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(hideScrollbarsTimeoutRef.current);
    hideScrollbarsTimeoutRef.current = null;
  }

  function temporarilyHideScrollbars(duration = 400) {
    clearHideScrollbarsTimeout();
    setHideScrollbars(true);

    hideScrollbarsTimeoutRef.current = window.setTimeout(() => {
      setHideScrollbars(false);
      hideScrollbarsTimeoutRef.current = null;
    }, duration);
  }

  function openPanel(panel: NavPanel) {
    const nextTrail = [...trail, panel];
    const nextIndex = nextTrail.length;

    clearBackAnimation();
    resetPanelScroll(nextIndex);
    shouldAnimateNextSlideRef.current = true;
    manualTrailOverrideRef.current = nextTrail;
    setTrail(nextTrail);
    syncSidebarSearch(nextTrail, false);
  }

  function goBack() {
    const nextTrail = trail.slice(0, -1);
    const nextIndex = nextTrail.length;

    clearBackAnimation();
    temporarilyHideScrollbars();
    resetPanelScroll(nextIndex);
    manualTrailOverrideRef.current = nextTrail;

    if (!swiper) {
      setTrail(nextTrail);
      syncSidebarSearch(nextTrail, false);
      return;
    }

    swiper.update();
    let hasFinished = false;
    const finishBackAnimation = () => {
      if (hasFinished) {
        return;
      }

      hasFinished = true;
      cleanup();
      setTrail(nextTrail);
      syncSidebarSearch(nextTrail, false);
      backAnimationCleanupRef.current = null;
    };
    const fallback = window.setTimeout(finishBackAnimation, 1500);
    const cleanup = () => {
      window.clearTimeout(fallback);
      swiper.off("slideChangeTransitionEnd", finishBackAnimation);
    };

    swiper.on("slideChangeTransitionEnd", finishBackAnimation);
    backAnimationCleanupRef.current = cleanup;
    swiper.slideTo(nextIndex);
  }

  return (
    <SidebarGroup className="flex min-h-0 flex-1 flex-col">
      <Swiper
        className="min-h-0 w-full flex-1 overflow-hidden"
        dir={direction}
        initialSlide={currentIndex}
        allowTouchMove={false}
        slidesPerView={1}
        speed={300}
        onSwiper={setSwiper}
        aria-label="Platform navigation"
      >
        {panels.map((panel, panelIndex) => (
          <SwiperSlide
            key={`${panel.title}-${panelIndex}`}
            className="h-full min-w-0"
            aria-hidden={panelIndex !== currentIndex}
          >
            <div
              ref={(node) => {
                panelContentRefs.current[panelIndex] = node;
              }}
              className={[
                "flex h-full min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain pr-1",
                hideScrollbars
                  ? "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  : "",
              ].join(" ")}
            >
              <div className="flex min-h-0 w-full shrink-0 flex-col gap-1">
                {panelIndex === 0 ? (
                  <SidebarGroupLabel>Platform</SidebarGroupLabel>
                ) : panel.panelLabel ? (
                  <SidebarGroupLabel>{panel.panelLabel}</SidebarGroupLabel>
                ) : null}
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
                    const hasChildren = Boolean(item.items?.length);
                    const isActive = itemContainsPath(item, pathname, locationSearch);
                    const Icon = item.icon;

                    return (
                      <SidebarMenuItem key={item.title}>
                        {hasChildren && item.items ? (
                          <SidebarMenuButton
                            isActive={isActive}
                            tooltip={item.title}
                            onClick={() =>
                              openPanel({
                                title: item.title,
                                panelLabel: item.panelLabel,
                                items: item.items ?? [],
                              })
                            }
                          >
                            {Icon ? <Icon /> : null}
                            <span>{item.title}</span>
                            <ChevronRight className="ms-auto rtl:rotate-180" />
                          </SidebarMenuButton>
                        ) : item.url ? (
                          <SidebarMenuButton
                            render={
                              <Link
                                to={toDashboardPath(item.url, item.search)}
                                aria-current={isActive ? "page" : undefined}
                              />
                            }
                            isActive={isActive}
                            tooltip={item.title}
                          >
                            {Icon ? <Icon /> : null}
                            <span>{item.title}</span>
                          </SidebarMenuButton>
                        ) : null}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
                {panel.title === "Workspace" &&
                !panel.items.some((item) => itemContainsPluginOwnedEntry(item)) ? (
                  <div className="rounded-md border border-dashed bg-muted/35 px-3 py-3 text-sm text-muted-foreground">
                    Install a plugin from Marketplace to give Workspace its first plugin area.
                  </div>
                ) : null}
              </div>
            </div>
          </SwiperSlide>
        ))}
      </Swiper>
    </SidebarGroup>
  );
}

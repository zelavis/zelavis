"use client";

import * as React from "react";
import { Link, useLocation, useMatches, useNavigate } from "react-router";
import {
  ChevronLeft,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import type { Swiper as SwiperInstance } from "swiper";
import { Swiper, SwiperSlide } from "swiper/react";
import "swiper/css";

import { useDirection } from "#/components/ui/direction";
import {
  SidebarFixedActionMenu,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "#/components/ui/sidebar";
import type {
  DashboardSlotDefinition,
  DashboardSlotId,
} from "#/components/DashboardSlots";
import { useIsMobile } from "#/hooks/use-mobile";
import type {
  DashboardNavSearch,
  DashboardNavItem,
} from "#/lib/dashboard-data";
import {
  getProjectIdFromPathname,
  isProjectManagementPath,
  mergeSearchParams,
  readSearchParams,
  toDashboardPath,
  toProjectPath,
} from "#/lib/routing";
import {
  getDashboardPageLabelFromMatches,
  getDashboardSidebarTrailFromMatches,
  getDashboardSlotsFromMatches,
} from "#/lib/dashboard-route-handles";

type NavChildItem = {
  title: string;
  url?: string;
  landingUrl?: string;
  search?: DashboardNavSearch;
  icon?: LucideIcon;
  panelLabel?: string;
  pageLabel?: string;
  slot?: DashboardSlotId;
  fixed?: boolean;
  fixedOrder?: number;
  sectionLabel?: string;
  serviceOwned?: boolean;
  items?: readonly NavChildItem[];
};

type NavPanel = {
  title: string;
  panelLabel?: string;
  landingUrl?: string;
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
  siblingSearchKeys = new Set<string>(),
): boolean {
  const routeMatches =
    item.url === pathname && itemSearchMatches(item, search, siblingSearchKeys);

  if (!item.items?.length) {
    return routeMatches;
  }

  const childSiblingSearchKeys = getSiblingSearchKeys(item.items);

  return (
    routeMatches ||
    item.items.some((child) =>
      itemContainsPath(child, pathname, search, childSiblingSearchKeys),
    )
  );
}

function getSiblingSearchKeys(
  items: readonly (DashboardNavItem | NavChildItem)[],
) {
  const keys = new Set<string>();

  for (const item of items) {
    for (const key of Object.keys(item.search ?? {})) {
      keys.add(key);
    }
  }

  return keys;
}

function itemSearchMatches(
  item: DashboardNavItem | NavChildItem,
  search?: Record<string, unknown>,
  siblingSearchKeys = new Set<string>(),
) {
  if (item.search) {
    return Object.entries(item.search).every(
      ([key, value]) => value === undefined || search?.[key] === value,
    );
  }

  return [...siblingSearchKeys].every((key) => search?.[key] === undefined);
}

function findActiveTrail(
  items: readonly DashboardNavItem[],
  pathname: string,
  search?: Record<string, unknown>,
): NavPanel[] {
  const rootSiblingSearchKeys = getSiblingSearchKeys(items);

  for (const item of items) {
    if (
      !item.items?.length ||
      !itemContainsPath(item, pathname, search, rootSiblingSearchKeys)
    ) {
      continue;
    }

    const panels: NavPanel[] = [
      {
        title: item.title,
        panelLabel: item.panelLabel,
        landingUrl: item.landingUrl,
        items: item.items,
      },
    ];
    let current: NavChildItem | undefined = item.items.find(
      (child) =>
        child.items?.length &&
        itemContainsPath(
          child,
          pathname,
          search,
          getSiblingSearchKeys(item.items ?? []),
        ),
    );

    while (current?.items?.length) {
      const currentSiblingSearchKeys = getSiblingSearchKeys(current.items);
      panels.push({
        title: current.title,
        panelLabel: current.panelLabel,
        items: current.items,
      });
      current = current.items.find(
        (child) =>
          child.items?.length &&
          itemContainsPath(child, pathname, search, currentSiblingSearchKeys),
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
      landingUrl: 'landingUrl' in match ? match.landingUrl as string | undefined : undefined,
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
    left.every((panel, index) => {
      const rightPanel = right[index];

      return (
        panel.title === rightPanel?.title &&
        panel.panelLabel === rightPanel.panelLabel &&
        panel.items === rightPanel.items
      );
    })
  );
}

function itemContainsServiceOwnedEntry(item: NavChildItem): boolean {
  return Boolean(
    item.serviceOwned || item.items?.some((child) => itemContainsServiceOwnedEntry(child)),
  );
}

function sortFixedItems(items: readonly NavChildItem[]) {
  return [...items].sort(
    (left, right) =>
      (left.fixedOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.fixedOrder ?? Number.MAX_SAFE_INTEGER) ||
      left.title.localeCompare(right.title),
  );
}

function groupItemsBySection(items: readonly NavChildItem[]) {
  const groups: Array<{ label?: string; items: NavChildItem[] }> = [];

  for (const item of items) {
    const previous = groups.at(-1);
    if (previous && previous.label === item.sectionLabel) {
      previous.items.push(item);
      continue;
    }

    groups.push({
      label: item.sectionLabel,
      items: [item],
    });
  }

  return groups;
}

export function NavMain({
  homeResetKey,
  items,
  mobileSlotContent,
}: {
  homeResetKey?: number;
  items: readonly DashboardNavItem[];
  mobileSlotContent?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const matches = useMatches();
  const isMobile = useIsMobile();
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
  const routeSlots = getDashboardSlotsFromMatches(matches);
  const pageLabel =
    getDashboardPageLabelFromMatches(matches) ?? panelsLabelFromPath(pathname);
  const mobileRouteSlots = React.useMemo<DashboardSlotDefinition[]>(
    () =>
      routeSlots.length > 0
        ? [...routeSlots]
        : [
            {
              id: "main",
              label: pageLabel,
            },
          ],
    [pageLabel, routeSlots],
  );
  const hasSyncedInitialSlideRef = React.useRef(false);
  const shouldAnimateNextSlideRef = React.useRef(false);
  const manualTrailOverrideRef = React.useRef<NavPanel[] | null>(null);
  const openSlotsAfterRouteChangeRef = React.useRef(false);
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
  const navPanelIndex = trail.length;
  const hasMobileRouteContent = isMobile && Boolean(mobileSlotContent);
  const [showMobileSlots, setShowMobileSlots] = React.useState(
    () =>
      hasMobileRouteContent &&
      (routeSlots.length === 0 || routeSidebarTrail.length === 0),
  );
  const [activeMobileSlotId, setActiveMobileSlotId] =
    React.useState<DashboardSlotId>(mobileRouteSlots[0]?.id ?? "main");
  const [mobileSlotTitle, setMobileSlotTitle] = React.useState(pageLabel);
  const currentIndex =
    hasMobileRouteContent && showMobileSlots ? panels.length : navPanelIndex;

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
      setShowMobileSlots(
        hasMobileRouteContent &&
          (openSlotsAfterRouteChangeRef.current ||
            showMobileSlots ||
            routeSlots.length === 0 ||
            routeSidebarTrail.length === 0),
      );
      setActiveMobileSlotId(mobileRouteSlots[0]?.id ?? "main");
      setMobileSlotTitle(pageLabel);
      openSlotsAfterRouteChangeRef.current = false;
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
    hasMobileRouteContent,
    mobileRouteSlots,
    pageLabel,
    routeSlots.length,
    routeSidebarTrail,
    sidebarSearch,
    showMobileSlots,
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
    resetPanelScroll(navPanelIndex);
  }, [navPanelIndex, panels.length]);

  React.useEffect(() => {
    if (!homeResetKey) {
      return;
    }

    clearBackAnimation();
    temporarilyHideScrollbars();
    resetPanelScroll(0);
    manualTrailOverrideRef.current = [];
    shouldAnimateNextSlideRef.current = true;
    setShowMobileSlots(false);
    setTrail([]);
    navigate(
      {
        pathname: location.pathname,
        search: mergeSearchParams(location.search, { sidebar: undefined }),
      },
      { replace: false, viewTransition: true },
    );
  }, [homeResetKey]);

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
    setShowMobileSlots(false);
    setTrail(nextTrail);

    // Navigate to the panel's canonical landing page so the visible content
    // keeps pace with slide navigation.
    if (panel.landingUrl && !pathname.startsWith(panel.landingUrl)) {
      navigate(
        {
          pathname: panel.landingUrl,
          search: mergeSearchParams("", { sidebar: panelSearchValue(nextTrail) }),
        },
        { replace: false, viewTransition: true },
      );
    } else {
      syncSidebarSearch(nextTrail, false);
    }
  }

  function openRouteSlotsFromMenuItem(item: NavChildItem) {
    if (!hasMobileRouteContent || !item.url) {
      return;
    }

    setActiveMobileSlotId(item.slot ?? mobileRouteSlots[0]?.id ?? "main");
    setMobileSlotTitle(item.pageLabel ?? item.title);
    openSlotsAfterRouteChangeRef.current = true;
    setShowMobileSlots(true);
  }

  function closeMobileSlots() {
    clearBackAnimation();
    temporarilyHideScrollbars();
    resetPanelScroll(navPanelIndex);
    shouldAnimateNextSlideRef.current = true;
    setShowMobileSlots(false);
  }

  function completeBackNavigation(nextTrail: NavPanel[]) {
    setTrail(nextTrail);

    if (nextTrail.length === 0) {
      const projectId = getProjectIdFromPathname(pathname);
      navigate(
        {
          pathname: isProjectManagementPath(pathname)
            ? "/projects"
            : toProjectPath("/", projectId),
          search: "",
        },
        { replace: false, viewTransition: true },
      );
      return;
    }

    syncSidebarSearch(nextTrail, false);
  }

  function goBack() {
    const nextTrail = trail.slice(0, -1);
    const nextIndex = nextTrail.length;

    clearBackAnimation();
    temporarilyHideScrollbars();
    resetPanelScroll(nextIndex);
    manualTrailOverrideRef.current = nextTrail;
    setShowMobileSlots(false);

    if (!swiper) {
      completeBackNavigation(nextTrail);
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
      completeBackNavigation(nextTrail);
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
    <SidebarGroup className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <Swiper
        className="min-h-0 min-w-0 w-full flex-1 overflow-hidden [&_.swiper-slide]:min-w-0 [&_.swiper-wrapper]:min-w-0"
        dir={direction}
        initialSlide={currentIndex}
        allowTouchMove={isMobile}
        slidesPerView={1}
        speed={300}
        onSwiper={setSwiper}
        aria-label="Platform navigation"
      >
        {panels.map((panel, panelIndex) => {
          const previousPanel = panels[panelIndex - 1];
          const fixedItems = sortFixedItems(
            panel.items.filter((item) => item.fixed),
          );
          const scrollItems = panel.items.filter((item) => !item.fixed);
          const scrollGroups = groupItemsBySection(scrollItems);
          const panelSearchKeys = getSiblingSearchKeys(panel.items);
          const hasBackButton = panelIndex > 0 && Boolean(previousPanel);
          const hasHeaderSpacingBeforeScroll =
            hasBackButton && fixedItems.length === 0;

          const renderItem = (item: NavChildItem) => {
            const hasChildren = Boolean(item.items?.length);
            const isActive = itemContainsPath(
              item,
              pathname,
              locationSearch,
              panelSearchKeys,
            );
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
                        landingUrl: item.landingUrl,
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
                        viewTransition
                        onClick={() => openRouteSlotsFromMenuItem(item)}
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
          };

          return (
            <SwiperSlide
              key={`${panel.title}-${panelIndex}`}
              className="h-full min-w-0 overflow-hidden"
              aria-hidden={panelIndex !== currentIndex}
            >
              <div className="flex h-full min-h-0 min-w-0 flex-col gap-1 overflow-hidden pr-1">
                <div className="shrink-0">
                  {hasBackButton && previousPanel ? (
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          className="relative justify-center font-semibold"
                          onClick={goBack}
                          tooltip={`Back to ${previousPanel.panelLabel ?? previousPanel.title}`}
                        >
                          <ChevronLeft className="absolute left-3 rtl:left-auto rtl:right-3 rtl:rotate-180 group-data-[collapsible=icon]:left-1/2 group-data-[collapsible=icon]:right-auto group-data-[collapsible=icon]:-translate-x-1/2" />
                          <span className="px-8 text-center group-data-[collapsible=icon]:hidden">
                            {panel.panelLabel ?? panel.title}
                          </span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  ) : null}
                  {fixedItems.length > 0 ? (
                    <SidebarFixedActionMenu afterHeader={hasBackButton}>
                      {fixedItems.map(renderItem)}
                    </SidebarFixedActionMenu>
                  ) : null}
                </div>

                <div
                  ref={(node) => {
                    panelContentRefs.current[panelIndex] = node;
                  }}
                  className={[
                    "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-x-contain overscroll-y-contain",
                    hasHeaderSpacingBeforeScroll ? "pt-1" : "",
                    hideScrollbars
                      ? "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                      : "",
                  ].join(" ")}
                >
                  <div className="flex min-h-0 min-w-0 w-full max-w-full shrink-0 flex-col gap-1">
                    {scrollGroups.map((group, groupIndex) => {
                      const hasPreviousContent =
                        fixedItems.length > 0 || groupIndex > 0;

                      return (
                        <div
                          key={`${group.label ?? "ungrouped"}-${groupIndex}`}
                          className="grid gap-1"
                        >
                          {hasPreviousContent ? (
                            <SidebarSeparator className="my-1" />
                          ) : null}
                          <SidebarMenu>{group.items.map(renderItem)}</SidebarMenu>
                        </div>
                      );
                    })}
                    {panel.title === "Extensions" &&
                    !panel.items.some((item) => itemContainsServiceOwnedEntry(item)) ? (
                      <div className="rounded-md border border-dashed bg-muted/35 px-3 py-3 text-sm text-muted-foreground">
                        Install a service from Marketplace to give Extensions its first service area.
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </SwiperSlide>
          );
        })}
        {hasMobileRouteContent ? (
          <SwiperSlide
            key="route-slots"
            className="h-full min-w-0 overflow-hidden"
            aria-hidden={currentIndex !== panels.length}
          >
            <MobileRouteSlots
              title={mobileSlotTitle}
              slots={mobileRouteSlots}
              activeSlotId={activeMobileSlotId}
              onBack={closeMobileSlots}
            >
              {mobileSlotContent}
            </MobileRouteSlots>
          </SwiperSlide>
        ) : null}
      </Swiper>
    </SidebarGroup>
  );
}

function panelsLabelFromPath(pathname: string) {
  const segment = pathname.split("/").filter(Boolean).at(-1);

  if (!segment) {
    return "Page";
  }

  return segment
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function slotVisibilityClassName(slotId: DashboardSlotId) {
  switch (slotId) {
    case "overview":
      return "[&_[data-dashboard-slot]:not([data-dashboard-slot=overview])]:hidden";
    case "main":
      return "[&_[data-dashboard-slot]:not([data-dashboard-slot=main])]:hidden";
    case "detail":
      return "[&_[data-dashboard-slot]:not([data-dashboard-slot=detail])]:hidden";
    case "create":
      return "[&_[data-dashboard-slot]:not([data-dashboard-slot=create])]:hidden";
    case "edit":
      return "[&_[data-dashboard-slot]:not([data-dashboard-slot=edit])]:hidden";
    case "inspect":
      return "[&_[data-dashboard-slot]:not([data-dashboard-slot=inspect])]:hidden";
    case "settings":
      return "[&_[data-dashboard-slot]:not([data-dashboard-slot=settings])]:hidden";
  }
}

function MobileRouteSlots({
  title,
  slots,
  activeSlotId,
  children,
  onBack,
}: {
  title: string;
  slots: readonly DashboardSlotDefinition[];
  activeSlotId: DashboardSlotId;
  children: React.ReactNode;
  onBack: () => void;
}) {
  const activeSlot =
    slots.find((slot) => slot.id === activeSlotId) ?? slots[0];

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden pr-1">
      <div className="shrink-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="relative justify-center font-semibold"
              onClick={onBack}
              tooltip="Back to navigation"
            >
              <ChevronLeft className="absolute left-3 rtl:left-auto rtl:right-3 rtl:rotate-180" />
              <span className="px-8 text-center">{title}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </div>

      {activeSlot?.description ? (
        <p className="shrink-0 px-3 text-sm text-sidebar-foreground/65">
          {activeSlot.description}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-4">
        <div
          className={[
            "dashboard-mobile-slot-content grid min-w-0 gap-4 [&_[data-dashboard-slot-layout]]:max-w-none [&_[data-dashboard-slot-layout]]:gap-4 [&_[data-dashboard-slot]]:gap-4",
            slotVisibilityClassName(activeSlot?.id ?? activeSlotId),
          ].join(" ")}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

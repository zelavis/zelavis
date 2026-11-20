export function initNavigation(): void {
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	// 1. Scroll-triggered section reveals
	const revealables = document.querySelectorAll<HTMLElement>('[data-reveal]');
	if (reduced || !('IntersectionObserver' in window)) {
		revealables.forEach((el) => el.classList.add('is-visible'));
	} else if (revealables.length > 0) {
		const revealObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					entry.target.classList.add('is-visible');
					revealObserver.unobserve(entry.target);
				}
			},
			{ threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
		);
		revealables.forEach((el) => revealObserver.observe(el));
	}

	// 2. Scroll Progress Bar fallback when CSS scroll-timeline is unavailable
	const progressBar = document.querySelector<HTMLElement>('.scroll-progress-bar');
	if (
		progressBar &&
		!reduced &&
		!(window.CSS && typeof CSS.supports === 'function' && CSS.supports('animation-timeline', 'scroll()'))
	) {
		let ticking = false;
		const updateProgress = () => {
			ticking = false;
			const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
			const progress = maxScroll > 0 ? Math.min(1, Math.max(0, window.scrollY / maxScroll)) : 0;
			progressBar.style.setProperty('--scroll-progress', String(progress));
		};
		const onScrollProgress = () => {
			if (!ticking) {
				ticking = true;
				requestAnimationFrame(updateProgress);
			}
		};
		updateProgress();
		window.addEventListener('scroll', onScrollProgress, { passive: true });
		window.addEventListener('resize', onScrollProgress, { passive: true });
	}

	// 3. Metric counters
	const runMetric = (el: HTMLElement) => {
		const target = parseFloat(el.dataset.count || '0');
		const decimals = parseInt(el.dataset.decimals || '0', 10);
		const suffix = el.dataset.suffix || '';
		const prefix = el.dataset.prefix || '';
		if (reduced) {
			el.textContent = prefix + target.toFixed(decimals) + suffix;
			return;
		}
		const duration = 1100;
		let start = 0;
		const frame = (now: number) => {
			if (!start) start = now;
			const progress = Math.min((now - start) / duration, 1);
			const eased = 1 - Math.pow(1 - progress, 3);
			el.textContent = prefix + (target * eased).toFixed(decimals) + suffix;
			if (progress < 1) requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
	};

	const metricPanels = document.querySelectorAll<HTMLElement>('[data-metrics]');
	if (metricPanels.length > 0) {
		const activate = (panel: HTMLElement) => {
			panel.classList.add('is-running');
			panel.querySelectorAll<HTMLElement>('[data-count]').forEach(runMetric);
		};
		if (!('IntersectionObserver' in window)) {
			metricPanels.forEach(activate);
		} else {
			const metricObserver = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (!entry.isIntersecting) continue;
						activate(entry.target as HTMLElement);
						metricObserver.unobserve(entry.target);
					}
				},
				{ threshold: 0.35 },
			);
			metricPanels.forEach((panel) => metricObserver.observe(panel));
		}
	}

	// 4. Sticky Nav, Upward Reveal, Mega Menus & Mobile Drawer
	const header = document.querySelector<HTMLElement>('[data-nav]');
	if (header) {
		let lastScrollY = Math.max(window.scrollY, 0);
		let upwardDistance = 0;

		const hasSectionNavigator = () =>
			!!document.querySelector('[data-local-nav]') &&
			window.matchMedia('(min-width: 1351px)').matches;

		const menuIsActive = () => {
			const shell = document.querySelector('[data-nav-shell]');
			const keyboardFocusActive = shell?.querySelector(':focus-visible');
			return !!(
				shell &&
				(shell.classList.contains('is-open') ||
					shell.classList.contains('is-mobile-open') ||
					keyboardFocusActive)
			);
		};

		const onScroll = () => {
			const currentScrollY = Math.max(window.scrollY, 0);
			const delta = currentScrollY - lastScrollY;
			const sectionNavigatorActive = hasSectionNavigator();
			const sectionNavigatorReached =
				document.documentElement.classList.contains('local-navigation-reached');
			header.classList.toggle('is-stuck', currentScrollY > 12);

			if (currentScrollY <= 80) {
				header.classList.remove('is-hidden', 'is-revealed');
				upwardDistance = 0;
			} else if (sectionNavigatorActive) {
				upwardDistance = 0;
				if (!sectionNavigatorReached) {
					header.classList.remove('is-hidden');
					header.classList.add('is-revealed');
				} else if (!menuIsActive()) {
					header.classList.add('is-hidden');
				}
			} else if (delta < -1) {
				upwardDistance += Math.abs(delta);
				if (upwardDistance >= 10) {
					header.classList.remove('is-hidden');
					header.classList.add('is-revealed');
					upwardDistance = 0;
				}
			} else if (delta > 1) {
				upwardDistance = 0;
				if (!menuIsActive()) {
					header.classList.add('is-hidden');
				}
			}
			lastScrollY = currentScrollY;
		};

		onScroll();
		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('local-nav-first-visible', () => {
			if (window.scrollY <= 80 || menuIsActive()) return;
			header.classList.add('is-revealed', 'is-hidden');
		});
		window.addEventListener('local-nav-reset', () => {
			header.classList.remove('is-hidden');
			header.classList.toggle('is-revealed', window.scrollY > 80);
		});

		const navShell = document.querySelector<HTMLElement>('[data-nav-shell]');
		const navBackdrop = document.querySelector<HTMLElement>('[data-nav-backdrop]');
		const menuTriggers = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-menu-trigger]'));
		const megaMenus = Array.from(document.querySelectorAll<HTMLElement>('[data-menu]'));
		const megaStage = document.querySelector<HTMLElement>('[data-mega-stage]');
		const mobileToggle = document.querySelector<HTMLButtonElement>('[data-mobile-menu-toggle]');
		const mobileMenu = document.querySelector<HTMLElement>('[data-mobile-menu]');
		let closeTimer: number | undefined;

		const setActiveMenu = (name: string | undefined): number => {
			let activeMenu: HTMLElement | undefined;
			megaMenus.forEach((menu) => {
				const isActive = menu.dataset.menu === name;
				menu.classList.toggle('is-active', isActive);
				menu.setAttribute('aria-hidden', isActive ? 'false' : 'true');
				menu.inert = !isActive;
				if (isActive) activeMenu = menu;
			});
			return activeMenu ? activeMenu.scrollHeight : 0;
		};

		const closeMenus = () => {
			window.clearTimeout(closeTimer);
			menuTriggers.forEach((trigger) => trigger.setAttribute('aria-expanded', 'false'));
			if (navBackdrop && !navShell?.classList.contains('is-mobile-open')) {
				navBackdrop.classList.remove('is-visible');
			}
			megaMenus.forEach((menu) => {
				menu.classList.remove('is-active');
				menu.setAttribute('aria-hidden', 'true');
				menu.inert = true;
			});
			if (megaStage) {
				megaStage.classList.remove('is-visible');
				megaStage.hidden = true;
				megaStage.style.height = '';
			}
			if (navShell) navShell.classList.remove('is-open', 'is-closing');
			if (!navShell?.classList.contains('is-mobile-open')) {
				header.classList.remove('is-menu-open');
			}
		};

		const openMenu = (name: string | undefined) => {
			window.clearTimeout(closeTimer);
			if (!window.matchMedia('(min-width: 821px)').matches) return;
			header.classList.remove('is-hidden');
			header.classList.add('is-menu-open');
			navBackdrop?.classList.add('is-visible');
			menuTriggers.forEach((trigger) => {
				trigger.setAttribute('aria-expanded', trigger.dataset.menuTrigger === name ? 'true' : 'false');
			});
			if (megaStage) megaStage.hidden = false;
			if (navShell) {
				navShell.classList.remove('is-closing');
				navShell.classList.add('is-open');
			}
			const targetHeight = setActiveMenu(name);
			if (megaStage) {
				megaStage.style.height = `${targetHeight}px`;
				megaStage.classList.add('is-visible');
			}
		};

		menuTriggers.forEach((trigger) => {
			trigger.addEventListener('mouseenter', () => openMenu(trigger.dataset.menuTrigger));
			trigger.addEventListener('focus', () => openMenu(trigger.dataset.menuTrigger));
			trigger.addEventListener('click', () => openMenu(trigger.dataset.menuTrigger));
		});

		const plainNavLinks = Array.from(
			navShell?.querySelectorAll<HTMLElement>('.nav-inner a') ?? [],
		);
		plainNavLinks.forEach((link) => {
			const handleNonMegaFocus = () => {
				if (navShell?.classList.contains('is-open')) {
					closeMenus();
				}
			};
			link.addEventListener('mouseenter', handleNonMegaFocus);
			link.addEventListener('focus', handleNonMegaFocus);
		});

		if (navShell) {
			navShell.addEventListener('mouseleave', () => {
				closeTimer = window.setTimeout(closeMenus, 60);
			});
			navShell.addEventListener('mouseenter', () => window.clearTimeout(closeTimer));
		}

		if (mobileToggle && mobileMenu && navShell) {
			mobileToggle.addEventListener('click', () => {
				const open = mobileToggle.getAttribute('aria-expanded') !== 'true';
				if (open) header.classList.remove('is-hidden');
				header.classList.toggle('is-menu-open', open);
				navBackdrop?.classList.toggle('is-visible', open);
				mobileToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
				mobileMenu.hidden = !open;
				navShell.classList.toggle('is-mobile-open', open);
			});
		}

		navBackdrop?.addEventListener('pointerdown', () => {
			closeMenus();
			if (mobileToggle && mobileMenu && navShell) {
				mobileToggle.setAttribute('aria-expanded', 'false');
				mobileMenu.hidden = true;
				navShell.classList.remove('is-mobile-open');
				header.classList.remove('is-menu-open');
				navBackdrop.classList.remove('is-visible');
			}
		});

		window.addEventListener('resize', () => {
			if (!window.matchMedia('(min-width: 821px)').matches && navShell?.classList.contains('is-open')) {
				closeMenus();
			}
		});

		document.addEventListener('pointerdown', (event) => {
			if (navShell && event.target instanceof Node && !navShell.contains(event.target)) {
				closeMenus();
			}
		});

		document.addEventListener('keydown', (event) => {
			if (event.key !== 'Escape') return;
			closeMenus();
			if (mobileToggle && mobileMenu && navShell) {
				mobileToggle.setAttribute('aria-expanded', 'false');
				mobileMenu.hidden = true;
				navShell.classList.remove('is-mobile-open');
				header.classList.remove('is-menu-open');
				navBackdrop?.classList.remove('is-visible');
			}
		});
	}

	// 5. Sticky Local Navigation
	const localNavs = document.querySelectorAll<HTMLElement>('[data-local-nav]');
	localNavs.forEach((localNav) => {
		const links = Array.from(localNav.querySelectorAll<HTMLAnchorElement>('[data-local-link]'));
		const sections = links
			.map((link) => document.getElementById(link.dataset.localLink ?? ''))
			.filter((section): section is HTMLElement => section instanceof HTMLElement);

		const boundary = document.getElementById(localNav.dataset.showAfter ?? '');
		const updateVisibility = () => {
			const hasEnteredContent = boundary
				? boundary.getBoundingClientRect().top <= 110
				: window.scrollY > 260;
			const canShow = window.matchMedia('(min-width: 1351px)').matches;
			const visible = hasEnteredContent && canShow;
			localNav.classList.toggle('local-nav--visible', visible);
			if (visible && localNav.dataset.firstVisible !== 'true') {
				localNav.dataset.firstVisible = 'true';
				document.documentElement.classList.add('local-navigation-reached');
				window.dispatchEvent(new CustomEvent('local-nav-first-visible'));
			} else if (!visible && localNav.dataset.firstVisible === 'true') {
				localNav.dataset.firstVisible = 'false';
				document.documentElement.classList.remove('local-navigation-reached');
				window.dispatchEvent(new CustomEvent('local-nav-reset'));
			}
		};

		updateVisibility();
		window.addEventListener('scroll', updateVisibility, { passive: true });
		window.addEventListener('resize', updateVisibility);

		const setActive = (id: string) => {
			links.forEach((link) => {
				if (link.dataset.localLink === id) link.setAttribute('aria-current', 'location');
				else link.removeAttribute('aria-current');
			});
		};

		if ('IntersectionObserver' in window && sections.length > 0) {
			const observer = new IntersectionObserver(
				(entries) => {
					const visible = entries
						.filter((entry) => entry.isIntersecting)
						.sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
					if (visible[0]?.target.id) setActive(visible[0].target.id);
				},
				{ rootMargin: '-28% 0px -58% 0px', threshold: 0 },
			);
			sections.forEach((section) => observer.observe(section));
		}
	});
}

interface SearchDoc {
	readonly path: string;
	readonly title: string;
	readonly headings?: readonly string[];
	readonly text?: string;
}

const DOCS_SECTIONS = new Set([
	'docs', 'getting-started', 'api', 'architecture', 'packages', 'adapters', 'guides', 'reference', 'cli',
]);
const THEME_KEY = 'zelavis-docs-theme';

function copyText(text: string): Promise<void> {
	if (navigator.clipboard && window.isSecureContext) {
		return navigator.clipboard.writeText(text);
	}
	const textarea = document.createElement('textarea');
	textarea.value = text;
	textarea.style.position = 'fixed';
	textarea.style.opacity = '0';
	document.body.appendChild(textarea);
	textarea.select();
	document.execCommand('copy');
	textarea.remove();
	return Promise.resolve();
}

export function initDocs(): void {
	const shell = document.querySelector<HTMLElement>('.docs-shell');
	if (!shell) return;

	// 1. Theme (dark default, optional light)
	const savedTheme = window.localStorage.getItem(THEME_KEY);
	if (savedTheme === 'light') {
		document.documentElement.dataset.theme = 'light';
	} else {
		delete document.documentElement.dataset.theme;
	}

	const themeBtn = shell.querySelector<HTMLButtonElement>('[data-docs-theme-toggle]');
	themeBtn?.addEventListener('click', () => {
		const isLight = document.documentElement.dataset.theme === 'light';
		if (isLight) {
			delete document.documentElement.dataset.theme;
			window.localStorage.setItem(THEME_KEY, 'dark');
		} else {
			document.documentElement.dataset.theme = 'light';
			window.localStorage.setItem(THEME_KEY, 'light');
		}
	});

	// 2. Mobile Sidebar Drawer
	const sidebarBtn = shell.querySelector<HTMLButtonElement>('[data-docs-sidebar-toggle]');
	sidebarBtn?.addEventListener('click', () => {
		const open = shell.classList.toggle('is-sidebar-open');
		sidebarBtn.setAttribute('aria-expanded', String(open));
	});

	// 3. Active Sidebar Link & Prev/Next Pagination
	const normalizeRoute = (path: string) => {
		const clean = path.replace(/index\.html$/, '').replace(/\/+$/, '');
		return clean === '' ? '/' : `${clean}/`;
	};
	const currentRoute = normalizeRoute(window.location.pathname);
	const navLinks = Array.from(shell.querySelectorAll<HTMLAnchorElement>('.docs-nav-link[href]'));
	let activeIndex = -1;

	navLinks.forEach((link, idx) => {
		const href = link.getAttribute('href') ?? '';
		if (normalizeRoute(href) === currentRoute) {
			link.setAttribute('aria-current', 'page');
			activeIndex = idx;
			link.scrollIntoView({ block: 'nearest' });
		}
		link.addEventListener('click', () => {
			shell.classList.remove('is-sidebar-open');
			sidebarBtn?.setAttribute('aria-expanded', 'false');
		});
	});

	const pagerEl = shell.querySelector<HTMLElement>('[data-docs-pager]');
	if (pagerEl && activeIndex !== -1) {
		const prev = activeIndex > 0 ? navLinks[activeIndex - 1] : null;
		const next = activeIndex < navLinks.length - 1 ? navLinks[activeIndex + 1] : null;
		pagerEl.replaceChildren();
		if (prev) {
			const a = document.createElement('a');
			a.className = 'docs-pager-link';
			a.href = prev.getAttribute('href') ?? '#';
			a.innerHTML = `<span class="docs-pager-dir">← Previous</span><span class="docs-pager-title"></span>`;
			a.querySelector('.docs-pager-title')!.textContent = prev.textContent ?? '';
			pagerEl.appendChild(a);
		}
		if (next) {
			const a = document.createElement('a');
			a.className = 'docs-pager-link docs-pager-link--next';
			a.href = next.getAttribute('href') ?? '#';
			a.innerHTML = `<span class="docs-pager-dir">Next →</span><span class="docs-pager-title"></span>`;
			a.querySelector('.docs-pager-title')!.textContent = next.textContent ?? '';
			pagerEl.appendChild(a);
		}
		pagerEl.hidden = !prev && !next;
	}

	// 4. Right TOC & Mobile TOC generation + Scrollspy
	const article = shell.querySelector<HTMLElement>('.docs-article');
	const tocList = shell.querySelector<HTMLElement>('[data-docs-toc]');
	const mobileToc = shell.querySelector<HTMLElement>('.docs-mobile-toc');
	const mobileTocList = shell.querySelector<HTMLElement>('[data-docs-mobile-toc]');

	if (article && tocList) {
		const headings = Array.from(article.querySelectorAll<HTMLHeadingElement>('h2[id], h3[id]'));
		const tocAnchors: HTMLAnchorElement[] = [];

		headings.forEach((heading) => {
			const level = heading.tagName === 'H3' ? '3' : '2';
			const text = heading.textContent?.trim() ?? '';
			if (!text) return;

			const li = document.createElement('li');
			const a = document.createElement('a');
			a.href = `#${heading.id}`;
			a.dataset.level = level;
			a.textContent = text;
			li.appendChild(a);
			tocList.appendChild(li);
			tocAnchors.push(a);

			if (mobileTocList) {
				const mLi = li.cloneNode(true) as HTMLLIElement;
				mLi.querySelector('a')?.addEventListener('click', () => {
					mobileToc?.removeAttribute('open');
				});
				mobileTocList.appendChild(mLi);
			}
		});

		if (headings.length > 0) {
			mobileToc?.classList.add('has-items');
			const syncToc = () => {
				const offset = 110;
				let activeId = headings[0].id;
				for (const h of headings) {
					if (h.getBoundingClientRect().top <= offset) {
						activeId = h.id;
					}
				}
				tocAnchors.forEach((a) => {
					a.classList.toggle('is-active', a.getAttribute('href') === `#${activeId}`);
				});
			};
			syncToc();
			window.addEventListener('scroll', syncToc, { passive: true });
		}
	}

	// 5. Copy buttons on code blocks
	if (article) {
		article.querySelectorAll<HTMLPreElement>('pre').forEach((pre) => {
			if (pre.parentElement?.classList.contains('docs-code-wrap')) return;
			const wrap = document.createElement('div');
			wrap.className = 'docs-code-wrap';
			pre.parentNode?.insertBefore(wrap, pre);
			wrap.appendChild(pre);

			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'docs-code-copy';
			btn.textContent = 'Copy';
			btn.setAttribute('aria-label', 'Copy code snippet');
			btn.addEventListener('click', () => {
				const text = pre.textContent ?? '';
				void copyText(text).then(() => {
					btn.textContent = 'Copied';
					btn.classList.add('is-copied');
					window.setTimeout(() => {
						btn.textContent = 'Copy';
						btn.classList.remove('is-copied');
					}, 1600);
				});
			});
			wrap.appendChild(btn);
		});
	}

	// 6. Search Dialog (/search-index.json)
	const dialog = document.getElementById('zelavis-docs-search-dialog') as HTMLDialogElement | null;
	const trigger = shell.querySelector<HTMLButtonElement>('[data-docs-search-trigger]');
	const closeBtn = dialog?.querySelector<HTMLButtonElement>('[data-docs-search-close]');
	const input = dialog?.querySelector<HTMLInputElement>('[data-docs-search-input]');
	const resultsEl = dialog?.querySelector<HTMLElement>('[data-docs-search-results]');

	let indexPromise: Promise<SearchDoc[]> | undefined;
	const loadDocsIndex = (): Promise<SearchDoc[]> => {
		if (!indexPromise) {
			indexPromise = fetch('/search-index.json')
				.then((res) => (res.ok ? res.json() : { documents: [] }))
				.then((payload: { documents?: SearchDoc[] }) =>
					(payload.documents ?? []).filter((doc) => DOCS_SECTIONS.has(doc.path.split('/')[1] ?? '')),
				)
				.catch(() => []);
		}
		return indexPromise;
	};

	const renderResults = (docs: SearchDoc[], rawQuery: string) => {
		if (!resultsEl) return;
		const q = rawQuery.trim().toLowerCase();
		resultsEl.replaceChildren();

		if (!q) {
			const top = docs.slice(0, 8);
			if (top.length === 0) {
				resultsEl.innerHTML = '<div class="docs-search-empty">Type to search documentation...</div>';
				return;
			}
			top.forEach((doc, idx) => {
				const a = document.createElement('a');
				a.className = `docs-search-result${idx === 0 ? ' is-selected' : ''}`;
				a.href = doc.path;
				a.innerHTML = `<span class="docs-search-result-title"></span><span class="docs-search-result-path"></span>`;
				a.querySelector('.docs-search-result-title')!.textContent = doc.title;
				a.querySelector('.docs-search-result-path')!.textContent = doc.path;
				resultsEl.appendChild(a);
			});
			return;
		}

		const scored = docs
			.map((doc) => {
				const title = doc.title.toLowerCase();
				const headings = (doc.headings ?? []).join(' · ').toLowerCase();
				const body = (doc.text ?? '').toLowerCase();
				let score = 0;
				if (title.includes(q)) score += 10;
				if (title.startsWith(q)) score += 6;
				if (headings.includes(q)) score += 4;
				if (body.includes(q)) score += 1;
				return { doc, score };
			})
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 14);

		if (scored.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'docs-search-empty';
			empty.textContent = `No matching pages found for "${rawQuery}".`;
			resultsEl.appendChild(empty);
			return;
		}

		scored.forEach(({ doc }, idx) => {
			const a = document.createElement('a');
			a.className = `docs-search-result${idx === 0 ? ' is-selected' : ''}`;
			a.href = doc.path;
			const snippet = doc.text?.slice(0, 140) ?? '';
			a.innerHTML =
				'<span class="docs-search-result-title"></span><span class="docs-search-result-snippet"></span><span class="docs-search-result-path"></span>';
			a.querySelector('.docs-search-result-title')!.textContent = doc.title;
			a.querySelector('.docs-search-result-snippet')!.textContent = snippet;
			a.querySelector('.docs-search-result-path')!.textContent = doc.path;
			resultsEl.appendChild(a);
		});
	};

	const openSearch = () => {
		if (!dialog || typeof dialog.showModal !== 'function') return;
		if (!dialog.open) dialog.showModal();
		input?.focus();
		void loadDocsIndex().then((docs) => renderResults(docs, input?.value ?? ''));
	};

	trigger?.addEventListener('click', openSearch);
	closeBtn?.addEventListener('click', () => dialog?.close());

	dialog?.addEventListener('click', (event) => {
		if (event.target === dialog) dialog.close();
	});

	input?.addEventListener('input', () => {
		void loadDocsIndex().then((docs) => renderResults(docs, input.value));
	});

	input?.addEventListener('keydown', (event) => {
		if (!resultsEl) return;
		const items = Array.from(resultsEl.querySelectorAll<HTMLAnchorElement>('.docs-search-result'));
		if (items.length === 0) return;
		const currentIdx = items.findIndex((item) => item.classList.contains('is-selected'));

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			const next = (currentIdx + 1) % items.length;
			items.forEach((item, idx) => item.classList.toggle('is-selected', idx === next));
			items[next].scrollIntoView({ block: 'nearest' });
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			const prev = (currentIdx - 1 + items.length) % items.length;
			items.forEach((item, idx) => item.classList.toggle('is-selected', idx === prev));
			items[prev].scrollIntoView({ block: 'nearest' });
		} else if (event.key === 'Enter' && currentIdx !== -1) {
			event.preventDefault();
			items[currentIdx].click();
		}
	});

	document.addEventListener('keydown', (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			if (dialog?.open) {
				dialog.close();
			} else {
				openSearch();
			}
		}
	});
}

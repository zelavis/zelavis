const INSTALL_METHODS = ['curl', 'npm', 'apt', 'deb', 'powershell'] as const;

export function initInstall(): void {
	const page = document.querySelector('.page-install');
	if (!page) return;

	const control = page.querySelector<HTMLElement>('#install-method');
	const panels = Array.from(page.querySelectorAll<HTMLElement>('[data-panel]'));
	if (panels.length === 0) return;

	const show = (id: string, push: boolean) => {
		const next = (INSTALL_METHODS as readonly string[]).includes(id) ? id : 'curl';
		panels.forEach((panel) => {
			panel.hidden = panel.dataset.panel !== next;
		});
		if (push) {
			try {
				history.replaceState(null, '', `#${next}`);
			} catch {
				// Ignore history errors in restricted contexts
			}
		}
		return next;
	};

	control?.addEventListener('segmented-change', (event) => {
		const value = (event as CustomEvent<{ value?: string }>).detail?.value;
		if (value) show(value, true);
	});

	// A shared link such as /install#npm opens that method.
	const wanted = window.location.hash.slice(1);
	if (wanted && (INSTALL_METHODS as readonly string[]).includes(wanted) && wanted !== 'curl') {
		show(wanted, false);
		const segmented = control as (HTMLElement & { setValue?: (value: string, emit?: boolean) => void }) | null;
		if (segmented && typeof segmented.setValue === 'function') {
			segmented.setValue(wanted, false);
		} else {
			control?.querySelector<HTMLButtonElement>(`[data-segment-value="${wanted}"]`)?.click();
		}
	}

	page.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
		button.addEventListener('click', async () => {
			const text = button.dataset.copy ?? '';
			if (!text) return;
			try {
				await navigator.clipboard.writeText(text);
			} catch {
				const area = document.createElement('textarea');
				area.value = text;
				area.setAttribute('readonly', '');
				area.style.position = 'fixed';
				area.style.opacity = '0';
				document.body.appendChild(area);
				area.select();
				try {
					document.execCommand('copy');
				} finally {
					area.remove();
				}
			}
			button.classList.add('is-copied');
			button.setAttribute('aria-label', 'Copied install command');
			window.setTimeout(() => {
				button.classList.remove('is-copied');
				button.setAttribute('aria-label', 'Copy command');
			}, 1600);
		});
	});
}

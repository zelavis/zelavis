export function initPricing(): void {
	const page = document.querySelector('.page-pricing');
	if (!page) return;

	const billingControl = page.querySelector<HTMLElement>('#billing-cycle');
	const amounts = page.querySelectorAll<HTMLElement>('.price-amount');
	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

	const swapAmount = (amount: HTMLElement, next: string | null) => {
		if (next === null || amount.textContent === next) return;
		if (reducedMotion.matches || typeof amount.animate !== 'function') {
			amount.textContent = next;
			return;
		}

		amount.getAnimations().forEach((animation) => animation.cancel());
		const out = amount.animate(
			[
				{ opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' },
				{ opacity: 0, transform: 'translateY(-7px)', filter: 'blur(3px)' },
			],
			{ duration: 130, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' },
		);
		out.onfinish = () => {
			amount.textContent = next;
			amount.animate(
				[
					{ opacity: 0, transform: 'translateY(7px)', filter: 'blur(3px)' },
					{ opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' },
				],
				{ duration: 220, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' },
			);
		};
	};

	const autoFitFeatures = () => {
		const cards = page.querySelectorAll<HTMLElement>('.plan');
		if (!cards.length) return;
		cards.forEach((card) => {
			const wrap = card.querySelector<HTMLElement>('.plan-features-wrap');
			if (!wrap) return;
			const list = wrap.querySelector<HTMLElement>('.plan-features');
			if (!list) return;
			const items = Array.from(list.querySelectorAll<HTMLElement>('.feature-item'));
			items.forEach((item) => {
				item.style.display = '';
			});
			const cardRect = card.getBoundingClientRect();
			const thresholdBottom = cardRect.bottom - 10;
			for (let i = items.length - 1; i >= 0; i -= 1) {
				const item = items[i];
				if (item.offsetParent === null) continue;
				if (item.getBoundingClientRect().bottom > thresholdBottom) {
					item.style.display = 'none';
				}
			}
		});
	};

	billingControl?.addEventListener('segmented-change', (event) => {
		const cycle = (event as CustomEvent<{ value?: string }>).detail?.value;
		if (!cycle) return;
		amounts.forEach((amount) => {
			const next = amount.getAttribute(cycle === 'yearly' ? 'data-yearly' : 'data-monthly');
			swapAmount(amount, next);
		});
		window.setTimeout(autoFitFeatures, 50);
	});

	autoFitFeatures();
	window.addEventListener('resize', autoFitFeatures, { passive: true });
}

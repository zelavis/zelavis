export class ZelavisSegmentedControl extends HTMLElement {
	private buttons: HTMLButtonElement[] = [];
	private indicator: HTMLElement | null = null;
	private resizeObserver: ResizeObserver | null = null;

	connectedCallback(): void {
		if (this.dataset.initialized === 'true') return;
		this.dataset.initialized = 'true';
		this.buttons = Array.from(this.querySelectorAll<HTMLButtonElement>('[data-segment-value]'));
		this.indicator = this.querySelector<HTMLElement>('.segmented-indicator');

		this.buttons.forEach((button) => {
			button.addEventListener('click', () => this.select(button));
			button.addEventListener('keydown', (event) => this.onKeydown(event, button));
		});

		const sync = () => {
			const active =
				this.buttons.find((button) => button.dataset.segmentValue === this.dataset.value) ??
				this.buttons[0];
			if (active && active.offsetWidth > 0) this.updateIndicator(active, true);
		};

		sync();
		requestAnimationFrame(sync);

		if (document.fonts && 'ready' in document.fonts) {
			void document.fonts.ready.then(sync);
		}

		if ('ResizeObserver' in window) {
			this.resizeObserver = new ResizeObserver(() => {
				const current = this.activeButton();
				if (current && current.offsetWidth > 0) this.updateIndicator(current, true);
			});
			this.resizeObserver.observe(this);
		}
	}

	disconnectedCallback(): void {
		this.resizeObserver?.disconnect();
	}

	private activeButton(): HTMLButtonElement | undefined {
		return this.buttons.find((button) => button.dataset.segmentValue === this.dataset.value);
	}

	private updateIndicator(button: HTMLButtonElement, immediate = false): void {
		if (!this.indicator) return;
		if (immediate) this.classList.add('segmented--measuring');
		this.indicator.style.transform = `translate3d(${button.offsetLeft}px, 0, 0)`;
		this.indicator.style.width = `${button.offsetWidth}px`;
		this.classList.add('segmented--ready');
		if (immediate) requestAnimationFrame(() => this.classList.remove('segmented--measuring'));
	}

	setValue(value: string, emit = true): void {
		const target = this.buttons.find((button) => button.dataset.segmentValue === value);
		if (target) this.select(target, emit);
	}

	private select(button: HTMLButtonElement, emit = true): void {
		const nextValue = button.dataset.segmentValue;
		if (!nextValue) return;
		this.dataset.value = nextValue;
		const tablist = this.getAttribute('role') === 'tablist';
		this.buttons.forEach((item) => {
			const active = item === button;
			item.tabIndex = active ? 0 : -1;
			item.setAttribute(tablist ? 'aria-selected' : 'aria-checked', String(active));
		});
		this.updateIndicator(button);
		if (emit) {
			this.dispatchEvent(
				new CustomEvent('segmented-change', {
					bubbles: true,
					detail: { value: nextValue, index: this.buttons.indexOf(button) },
				}),
			);
		}
	}

	private onKeydown(event: KeyboardEvent, current: HTMLButtonElement): void {
		const currentIndex = this.buttons.indexOf(current);
		if (currentIndex === -1) return;
		let nextIndex = -1;
		if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
			nextIndex = (currentIndex + 1) % this.buttons.length;
		} else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
			nextIndex = (currentIndex - 1 + this.buttons.length) % this.buttons.length;
		} else if (event.key === 'Home') {
			nextIndex = 0;
		} else if (event.key === 'End') {
			nextIndex = this.buttons.length - 1;
		}
		if (nextIndex === -1) return;
		event.preventDefault();
		const target = this.buttons[nextIndex];
		target.focus();
		this.select(target);
	}
}

export function initSegmentedControls(): void {
	if (!customElements.get('zelavis-segmented')) {
		customElements.define('zelavis-segmented', ZelavisSegmentedControl);
	}
}

import {
	agenticFeatures,
	architectureCapabilities,
	dataLenses,
	platformTabs,
} from '../data/landing';

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

export function initLanding(): void {
	const page = document.querySelector('.page-home');
	if (!page) return;

	// 1. Hero Launch Tabs
	const heroLaunchControl = page.querySelector<HTMLElement>('#hero-launch-tabs');
	if (heroLaunchControl) {
		const panels = page.querySelectorAll<HTMLElement>('[data-hero-panel]');
		heroLaunchControl.addEventListener('segmented-change', (event) => {
			const value = (event as CustomEvent<{ value?: string }>).detail?.value;
			if (!value) return;
			panels.forEach((panel) => {
				const active = panel.dataset.heroPanel === value;
				panel.hidden = !active;
				panel.classList.toggle('is-active', active);
			});
		});
	}

	// 1b. Hero terminal copy button
	const heroCopyBtn = page.querySelector<HTMLButtonElement>('.hero-terminal-copy');
	if (heroCopyBtn) {
		heroCopyBtn.addEventListener('click', () => {
			const cmd = heroCopyBtn.dataset.copyCmd ?? heroCopyBtn.dataset.copy ?? 'npx zelavis create my-app';
			void copyText(cmd).then(() => {
				heroCopyBtn.classList.add('copied');
				window.setTimeout(() => heroCopyBtn.classList.remove('copied'), 1800);
			});
		});
	}

	// 2. Hero 3D product stage pointer tilt
	const stage = page.querySelector<HTMLElement>('.amp-product-stage');
	const stageWindow = page.querySelector<HTMLElement>('.stage-window');
	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	if (stage && stageWindow && !reducedMotion) {
		stage.addEventListener('pointermove', (event) => {
			if (event.pointerType !== 'mouse') return;
			const rect = stage.getBoundingClientRect();
			const x = (event.clientX - rect.left) / rect.width - 0.5;
			const y = (event.clientY - rect.top) / rect.height - 0.5;
			stageWindow.style.transform = `rotateY(${(-4 + x * 6).toFixed(2)}deg) rotateX(${(2 - y * 4).toFixed(2)}deg)`;
		});
		stage.addEventListener('pointerleave', () => {
			stageWindow.style.transform = 'rotateY(-4deg) rotateX(2deg)';
		});
	}

	// 3. Platform Tabs
	const platformControl = page.querySelector<HTMLElement>('#platform-tabs');
	if (platformControl) {
		const panes = page.querySelectorAll<HTMLElement>('.amp-platform-panel .visual-pane');
		const labelEl = page.querySelector<HTMLElement>('[data-panel-label]');
		const titleEl = page.querySelector<HTMLElement>('[data-panel-title]');
		const bodyEl = page.querySelector<HTMLElement>('[data-panel-body]');
		const highlightsEl = page.querySelector<HTMLElement>('[data-panel-highlights]');
		const linkEl = page.querySelector<HTMLAnchorElement>('[data-panel-link]');
		const linkTextEl = page.querySelector<HTMLElement>('[data-panel-link-text]');

		platformControl.addEventListener('segmented-change', (event) => {
			const value = (event as CustomEvent<{ value?: string }>).detail?.value;
			const selected = platformTabs.find((tab) => tab.id === value);
			if (!selected) return;

			panes.forEach((pane) => {
				pane.classList.toggle('active', pane.dataset.pane === selected.id);
			});

			if (labelEl) labelEl.textContent = selected.eyebrow;
			if (titleEl) titleEl.textContent = selected.title;
			if (bodyEl) bodyEl.textContent = selected.body;
			if (linkEl) linkEl.setAttribute('href', selected.link);
			if (linkTextEl) linkTextEl.textContent = selected.linkLabel;

			if (highlightsEl) {
				highlightsEl.replaceChildren();
				selected.highlights.forEach((text) => {
					const li = document.createElement('li');
					li.innerHTML =
						'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
					const span = document.createElement('span');
					span.textContent = text;
					li.appendChild(span);
					highlightsEl.appendChild(li);
				});
			}
		});
	}

	// 4. Agentic Section Tabs
	const agenticControl = page.querySelector<HTMLElement>('#agentic-tabs');
	if (agenticControl) {
		const promptEl = page.querySelector<HTMLElement>('[data-user-prompt]');
		const badgeEl = page.querySelector<HTMLElement>('[data-agent-badge]');
		const statusEl = page.querySelector<HTMLElement>('[data-agent-status-text]');
		const stepsEl = page.querySelector<HTMLElement>('[data-agent-steps]');
		const replyEl = page.querySelector<HTMLElement>('[data-agent-reply]');
		const actionsEl = page.querySelector<HTMLElement>('[data-agent-actions]');
		const fileEl = page.querySelector<HTMLElement>('[data-code-title]');
		const codeEl = page.querySelector<HTMLElement>('[data-code-snippet]');
		const metricsEl = page.querySelector<HTMLElement>('[data-metrics-strip]');

		agenticControl.addEventListener('segmented-change', (event) => {
			const value = (event as CustomEvent<{ value?: string }>).detail?.value;
			const feature = agenticFeatures.find((item) => item.id === value);
			if (!feature) return;

			if (promptEl) promptEl.textContent = `"${feature.userPrompt}"`;
			if (badgeEl) badgeEl.textContent = feature.badge;
			if (statusEl) statusEl.textContent = feature.agentStatus;
			if (replyEl) replyEl.textContent = feature.agentReply;
			if (fileEl) fileEl.textContent = feature.codeTitle;
			if (codeEl) codeEl.textContent = feature.codeSnippet;

			if (stepsEl) {
				stepsEl.replaceChildren();
				feature.agentSteps.forEach((step) => {
					const div = document.createElement('div');
					div.className = 'step-item';
					div.innerHTML =
						'<svg class="step-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
					const span = document.createElement('span');
					span.textContent = step;
					div.appendChild(span);
					stepsEl.appendChild(div);
				});
			}

			if (actionsEl) {
				actionsEl.replaceChildren();
				feature.actionPills.forEach((act) => {
					const a = document.createElement('a');
					a.className = 'agent-action-btn';
					a.href = act.href;
					const labelSpan = document.createElement('span');
					labelSpan.textContent = act.label;
					const arrow = document.createElement('span');
					arrow.className = 'arrow';
					arrow.textContent = '→';
					a.append(labelSpan, arrow);
					actionsEl.appendChild(a);
				});
			}

			if (metricsEl) {
				metricsEl.replaceChildren();
				feature.metrics.forEach((metric) => {
					const block = document.createElement('div');
					block.className = 'metric-block';
					const l = document.createElement('span');
					l.className = 'm-label';
					l.textContent = metric.label;
					const v = document.createElement('b');
					v.className = 'm-val';
					v.textContent = metric.value;
					const h = document.createElement('small');
					h.className = 'm-hint';
					h.textContent = metric.hint;
					block.append(l, v, h);
					metricsEl.appendChild(block);
				});
			}
		});
	}

	// 5. Data Lenses
	const lensButtons = Array.from(page.querySelectorAll<HTMLButtonElement>('[data-lens-id]'));
	if (lensButtons.length > 0) {
		const titleEl = page.querySelector<HTMLElement>('[data-output-title]');
		const perfEl = page.querySelector<HTMLElement>('.output-perf');
		const codeEl = page.querySelector<HTMLElement>('[data-output-code]');

		const activateLens = (btn: HTMLButtonElement, moveFocus: boolean) => {
			const id = btn.dataset.lensId ?? '';
			const target = dataLenses[id];
			if (!target) return;

			lensButtons.forEach((b) => {
				const active = b === btn;
				b.classList.toggle('active', active);
				b.setAttribute('aria-selected', String(active));
				b.setAttribute('tabindex', active ? '0' : '-1');
			});

			if (moveFocus) btn.focus();
			if (titleEl) titleEl.textContent = target.title;
			if (perfEl) perfEl.textContent = target.perf;
			if (codeEl) codeEl.textContent = target.code;
		};

		lensButtons.forEach((btn, index) => {
			btn.setAttribute('tabindex', btn.classList.contains('active') ? '0' : '-1');
			btn.addEventListener('click', () => activateLens(btn, false));
			btn.addEventListener('keydown', (event) => {
				let nextIndex = -1;
				if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
					nextIndex = (index + 1) % lensButtons.length;
				} else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
					nextIndex = (index - 1 + lensButtons.length) % lensButtons.length;
				} else if (event.key === 'Home') {
					nextIndex = 0;
				} else if (event.key === 'End') {
					nextIndex = lensButtons.length - 1;
				}
				if (nextIndex !== -1) {
					event.preventDefault();
					activateLens(lensButtons[nextIndex], true);
				}
			});
		});
	}

	// 6. Architecture Capabilities
	const capButtons = Array.from(page.querySelectorAll<HTMLButtonElement>('[data-capability-id]'));
	if (capButtons.length > 0) {
		const visual = page.querySelector<HTMLElement>('.together-visual');
		const description = page.querySelector<HTMLElement>('[data-capability-description]');
		const views = page.querySelectorAll<HTMLElement>('.topo-view');

		capButtons.forEach((button) => {
			button.addEventListener('click', () => {
				const id = button.dataset.capabilityId;
				const item = architectureCapabilities.find((entry) => entry.id === id);
				if (!item) return;

				capButtons.forEach((other) => {
					const active = other === button;
					other.classList.toggle('active', active);
					other.setAttribute('aria-pressed', String(active));
				});

				if (visual) visual.dataset.accent = item.accent;
				if (description) description.textContent = item.body;
				views.forEach((view) => view.classList.toggle('active', view.dataset.view === item.id));
			});
		});
	}
}

import { initDocs } from './docs';
import { initInstall } from './install';
import { initLanding } from './landing';
import { initNavigation } from './navigation';
import { initPricing } from './pricing';
import { initSegmentedControls } from './segmented-control';

function boot(): void {
	initNavigation();
	initSegmentedControls();
	initLanding();
	initInstall();
	initPricing();
	initDocs();
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
	boot();
}

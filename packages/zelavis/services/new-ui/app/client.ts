import { ready } from "virtual:fuzor/client";
import { mount } from "../islands/dashboard.ts";
let cleanup: (() => void) | undefined;
let disposed = false;
const dispose = () => { disposed = true; cleanup?.(); cleanup = undefined; };
void ready.then(() => { if (!disposed) cleanup = mount(document.getElementById("dashboard-shell")!); }).catch(error => { document.getElementById("dashboard-shell")!.textContent = `Dashboard startup failed: ${String(error)}`; });
const hide = (event: PageTransitionEvent) => { if (!event.persisted) dispose(); };
window.addEventListener("pagehide", hide);
if (import.meta.hot) import.meta.hot.dispose(() => { window.removeEventListener("pagehide", hide); dispose(); });

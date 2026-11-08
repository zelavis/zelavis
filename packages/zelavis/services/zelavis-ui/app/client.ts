import { ready } from "virtual:fuzor/client";
import { mount } from "../behaviors/dashboard.ts";
let cleanup: (() => void) | undefined;
let disposed = false;
const dispose = () => { disposed = true; cleanup?.(); cleanup = undefined; };
void ready.then(() => { if (!disposed) cleanup = mount(document.getElementById("dashboard-shell")!); }).catch(error => {
  console.error("Dashboard startup failed", error);
  const errors = document.querySelector<HTMLElement>("#dashboard-shell .errors");
  if (errors) { errors.setAttribute("role", "alert"); errors.textContent = "The dashboard could not start. Reload to try again."; }
});
const hide = (event: PageTransitionEvent) => { if (!event.persisted) dispose(); };
window.addEventListener("pagehide", hide);
if (import.meta.hot) import.meta.hot.dispose(() => { window.removeEventListener("pagehide", hide); dispose(); });

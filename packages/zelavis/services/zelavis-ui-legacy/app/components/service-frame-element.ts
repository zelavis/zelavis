import {
  installServicePageBroker,
  type ServicePageBrokerGrant,
} from "#/lib/service-page-broker";

const ELEMENT_NAME = "zelavis-service-frame";

/**
 * A page from a service the operator composed themselves runs same-origin:
 * they already chose to run its code, and its page adds no authority its
 * service does not already have in-process.
 */
const TRUSTED_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

/**
 * A page from a service installed at runtime gets an opaque origin. It cannot
 * reach the dashboard, cannot send the session cookie, and cannot call the
 * Platform except through the broker, which confines it to its own API.
 *
 * `allow-popups` is dropped with it: a popup from an opaque-origin document is
 * a window the dashboard cannot see but the viewer will read as part of it.
 */
const SANDBOXED = "allow-scripts allow-forms";

class ZelavisServiceFrameElement extends HTMLElement {
  static get observedAttributes() {
    return ["src", "title", "sandboxed", "grant"];
  }

  private readonly iframe: HTMLIFrameElement;
  private readonly loading: HTMLDivElement;
  private teardownBroker?: () => void;

  constructor() {
    super();

    const shadowRoot = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        display: block;
        inline-size: 100%;
        min-block-size: 70vh;
      }

      .frame-shell {
        position: relative;
        inline-size: 100%;
        block-size: 100%;
        min-block-size: 70vh;
        overflow: hidden;
        border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
        border-radius: 8px;
        background: color-mix(in srgb, currentColor 2%, transparent);
      }

      iframe {
        inline-size: 100%;
        block-size: 100%;
        min-block-size: 70vh;
        border: 0;
        background: white;
      }

      .loading {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        font: 500 0.875rem/1.4 system-ui, sans-serif;
        color: color-mix(in srgb, currentColor 68%, transparent);
        background: color-mix(in srgb, currentColor 3%, transparent);
        transition: opacity 160ms ease;
      }

      .loading[data-hidden="true"] {
        opacity: 0;
        pointer-events: none;
      }
    `;

    const shell = document.createElement("div");
    shell.className = "frame-shell";

    this.loading = document.createElement("div");
    this.loading.className = "loading";
    this.loading.textContent = "Loading service page...";

    this.iframe = document.createElement("iframe");
    this.iframe.setAttribute("loading", "lazy");
    // Sandboxed until told otherwise. A missing or malformed attribute must
    // fail closed: the cost of over-restricting a trusted page is a page that
    // does not work, and the cost of under-restricting an untrusted one is the
    // operator's session.
    this.iframe.setAttribute("sandbox", SANDBOXED);
    this.iframe.addEventListener("load", () => {
      this.loading.dataset.hidden = "true";
    });

    shell.append(this.iframe, this.loading);
    shadowRoot.append(style, shell);
  }

  connectedCallback() {
    this.sync();
  }

  disconnectedCallback() {
    this.teardownBroker?.();
    this.teardownBroker = undefined;
  }

  attributeChangedCallback() {
    this.sync();
  }

  private sync() {
    const src = this.getAttribute("src") ?? "about:blank";
    const title = this.getAttribute("title") ?? "Service page";
    const sandboxed = this.getAttribute("sandboxed") !== "false";

    const sandbox = sandboxed ? SANDBOXED : TRUSTED_SANDBOX;
    if (this.iframe.getAttribute("sandbox") !== sandbox) {
      // Changing the sandbox of a loaded document does not re-apply to it, so
      // the frame is reloaded rather than left running under the old flags.
      this.iframe.setAttribute("sandbox", sandbox);
      this.iframe.removeAttribute("src");
    }

    this.teardownBroker?.();
    this.teardownBroker = undefined;

    if (sandboxed) {
      const grant = this.readGrant();
      if (grant) {
        this.teardownBroker = installServicePageBroker({
          grant,
          frame: this.iframe,
        });
      }
    }

    if (this.iframe.getAttribute("src") !== src) {
      this.loading.dataset.hidden = "false";
      this.iframe.setAttribute("src", src);
    }

    this.iframe.title = title;
  }

  private readGrant(): ServicePageBrokerGrant | undefined {
    const raw = this.getAttribute("grant");
    if (!raw) return undefined;

    try {
      const parsed = JSON.parse(raw) as Partial<ServicePageBrokerGrant>;
      return typeof parsed?.serviceName === "string" &&
        typeof parsed?.apiPath === "string"
        ? { serviceName: parsed.serviceName, apiPath: parsed.apiPath }
        : undefined;
    } catch {
      // No grant means no brokered access, which is the safe outcome.
      return undefined;
    }
  }
}

export function defineServiceFrameElement() {
  if (typeof window === "undefined") {
    return;
  }

  if (!window.customElements.get(ELEMENT_NAME)) {
    window.customElements.define(ELEMENT_NAME, ZelavisServiceFrameElement);
  }
}

export { ELEMENT_NAME as serviceFrameElementName };

const ELEMENT_NAME = "zelavis-service-frame";

class ZelavisServiceFrameElement extends HTMLElement {
  static get observedAttributes() {
    return ["src", "title"];
  }

  private readonly iframe: HTMLIFrameElement;
  private readonly loading: HTMLDivElement;

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
    this.iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-popups",
    );
    this.iframe.addEventListener("load", () => {
      this.loading.dataset.hidden = "true";
    });

    shell.append(this.iframe, this.loading);
    shadowRoot.append(style, shell);
  }

  connectedCallback() {
    this.sync();
  }

  attributeChangedCallback() {
    this.sync();
  }

  private sync() {
    const src = this.getAttribute("src") ?? "about:blank";
    const title = this.getAttribute("title") ?? "Service page";

    if (this.iframe.getAttribute("src") !== src) {
      this.loading.dataset.hidden = "false";
      this.iframe.setAttribute("src", src);
    }

    this.iframe.title = title;
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

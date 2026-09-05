/**
 * Components a service page renders with.
 *
 * A service page runs in its own document, so it inherits nothing from the
 * dashboard. The design tokens stylesheet already closes half of that gap — a
 * page can use the installation's palette — but a page still had to write the
 * markup for every card, badge, field, and empty state itself, which is why
 * the marketplace page was a placeholder built from bare `div`s and a private
 * copy of the layout rules.
 *
 * These are custom elements, served the same way the stylesheet is: from a
 * stable Platform path, with a frontend free to supply its own implementation.
 * The Platform owns neither, and that separation is the point — a design system
 * belongs to a frontend, and the Platform ships a baseline only so a page is
 * never left composing nothing.
 *
 * Each element renders into a shadow root, so a page's own CSS cannot reach in
 * and a component's rules cannot leak out. The tokens still reach the
 * components, because custom properties inherit through shadow boundaries —
 * which is exactly the seam that lets a frontend restyle every service page in
 * the installation by defining different values for `--border`, `--primary`,
 * and the rest.
 *
 * The elements stay deliberately small and presentational. Anything that talks
 * to the Platform is the page's own code calling the versioned API, because a
 * component library that fetched on its own behalf would become a second,
 * undocumented client.
 */

/**
 * The baseline element library.
 *
 * A module rather than a classic script: a service page loads it with
 * `<script type="module">`, so it runs deferred and in strict mode, and the
 * elements are defined before the page's own module body runs its first line.
 */
export const ZELAVIS_BASELINE_SERVICE_ELEMENTS = `/* Zelavis baseline service page elements. */

// Defining a tag twice throws, and a page that loads this module through two
// different URLs — a relative link and an absolute one — would otherwise take
// down the whole page on the second load.
const define = (tag, constructor) => {
  if (!customElements.get(tag)) customElements.define(tag, constructor);
};

const SHARED = \`
  :host { display: block; }
  :host([hidden]) { display: none !important; }
  * { box-sizing: border-box; }
\`;

/**
 * A component whose shadow root is built once from a template.
 *
 * Rendering on \`connectedCallback\` rather than in the constructor: a parser-
 * created element has no attributes or children in its constructor, so reading
 * them there sees an empty element.
 */
class ZelavisElement extends HTMLElement {
  static styles = "";
  static template = "<slot></slot>";

  connectedCallback() {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML =
        "<style>" + SHARED + this.constructor.styles + "</style>" +
        this.constructor.template;
    }
    this.render?.();
  }

  attributeChangedCallback() {
    if (this.shadowRoot) this.render?.();
  }

  /** Slots a text attribute into a named node, hiding the node when empty. */
  slotText(selector, value) {
    const node = this.shadowRoot?.querySelector(selector);
    if (!node) return;
    node.textContent = value ?? "";
    node.hidden = !value;
  }
}

/** Page frame: the outer stack every service page opens with. */
class ZelavisPage extends ZelavisElement {
  static styles = \`
    :host { display: grid; gap: 1rem; max-width: 60rem; }
    h1 { margin: 0; font-size: 1.25rem; font-weight: 600; line-height: 1.25; }
    p { margin: 0.25rem 0 0; color: var(--muted-foreground); font-size: 0.875rem; }
    header:empty { display: none; }
  \`;
  static template = \`
    <header><h1 part="heading"></h1><p part="description"></p></header>
    <slot></slot>
  \`;
  static observedAttributes = ["heading", "description"];

  render() {
    this.slotText("[part=heading]", this.getAttribute("heading"));
    this.slotText("[part=description]", this.getAttribute("description"));
  }
}

/** A titled group within a page. */
class ZelavisSection extends ZelavisElement {
  static styles = \`
    :host { display: grid; gap: 0.75rem; }
    h2 { margin: 0; font-size: 1rem; font-weight: 600; }
    p { margin: 0.125rem 0 0; color: var(--muted-foreground); font-size: 0.8125rem; }
    header:has(h2:empty):has(p:empty) { display: none; }
  \`;
  static template = \`
    <header><h2 part="heading"></h2><p part="description"></p></header>
    <slot></slot>
  \`;
  static observedAttributes = ["heading", "description"];

  render() {
    this.slotText("[part=heading]", this.getAttribute("heading"));
    this.slotText("[part=description]", this.getAttribute("description"));
  }
}

/** The surface everything else sits on. */
class ZelavisCard extends ZelavisElement {
  static styles = \`
    :host {
      display: block;
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      background: var(--card);
      color: var(--card-foreground);
      padding: 1rem 1.25rem;
    }
    :host([tone="danger"]) { border-color: var(--destructive); color: var(--destructive); }
    :host([interactive]) { cursor: pointer; }
    :host([interactive]:hover) { border-color: color-mix(in srgb, var(--primary) 50%, var(--border)); }
  \`;
}

/** Vertical rhythm without every page inventing its own. */
class ZelavisStack extends ZelavisElement {
  static styles = \`
    :host { display: grid; gap: var(--zv-gap, 0.75rem); }
    :host([gap="tight"]) { --zv-gap: 0.375rem; }
    :host([gap="loose"]) { --zv-gap: 1.25rem; }
  \`;
}

/** Label on the left, actions on the right — the row a list item is made of. */
class ZelavisRow extends ZelavisElement {
  static styles = \`
    :host {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }
  \`;
}

/** Primary label with a secondary line under it. */
class ZelavisTitle extends ZelavisElement {
  static styles = \`
    :host { display: grid; gap: 0.125rem; min-width: 0; }
    .name { font-weight: 600; overflow-wrap: anywhere; }
    .detail { color: var(--muted-foreground); font-size: 0.8125rem; overflow-wrap: anywhere; }
    .detail:empty { display: none; }
  \`;
  static template = \`<span class="name"><slot></slot></span><span class="detail"></span>\`;
  static observedAttributes = ["detail"];

  render() {
    this.slotText(".detail", this.getAttribute("detail"));
  }
}

class ZelavisBadge extends ZelavisElement {
  static styles = \`
    :host {
      display: inline-block;
      padding: 0.125rem 0.5rem;
      border-radius: 999px;
      border: 1px solid var(--border);
      font-size: 0.75rem;
      color: var(--muted-foreground);
      white-space: nowrap;
    }
    :host([tone="active"]) {
      border-color: color-mix(in srgb, var(--primary) 60%, var(--border));
      color: var(--primary);
    }
    :host([tone="danger"]) { border-color: var(--destructive); color: var(--destructive); }
  \`;
}

/**
 * A button that is a real button.
 *
 * The native element lives in the shadow root so the component controls its
 * appearance, which costs one thing worth naming: a \`submit\` from inside a
 * shadow root does not cross out of it, so a form containing only these would
 * never see one. \`type="submit"\` therefore asks the enclosing form to submit
 * itself, which runs its validation and fires the event the page listens for.
 */
class ZelavisButton extends ZelavisElement {
  static styles = \`
    :host { display: inline-block; }
    button {
      font: inherit;
      padding: 0.375rem 0.875rem;
      border-radius: 0.5rem;
      border: 1px solid transparent;
      background: var(--primary);
      color: var(--primary-foreground);
      cursor: pointer;
    }
    button:disabled { opacity: 0.5; cursor: default; }
    :host([variant="outline"]) button {
      background: transparent;
      color: var(--foreground);
      border-color: var(--border);
    }
    :host([variant="quiet"]) button {
      background: transparent;
      color: var(--muted-foreground);
      border-color: transparent;
      padding-inline: 0.25rem;
    }
  \`;
  static template = \`<button part="button"><slot></slot></button>\`;
  static observedAttributes = ["disabled", "busy", "type"];

  connectedCallback() {
    super.connectedCallback();
    if (this.wired) return;
    this.wired = true;
    this.shadowRoot?.querySelector("button")?.addEventListener("click", () => {
      if (this.getAttribute("type") !== "submit") return;
      // requestSubmit rather than submit: it runs the form's validation and
      // fires a cancelable submit event, which is what the page is listening
      // for. form.submit() would navigate instead.
      this.closest("form")?.requestSubmit();
    });
  }

  render() {
    const button = this.shadowRoot?.querySelector("button");
    if (!button) return;
    button.disabled = this.hasAttribute("disabled") || this.hasAttribute("busy");
    // Always a plain button inside the shadow root: the enclosing form is
    // asked to submit explicitly above, and a native submit here would be
    // swallowed by the shadow boundary anyway.
    button.type = "button";
  }
}

/**
 * A labelled input.
 *
 * The input is in the shadow root, so \`value\` is proxied rather than left for
 * the page to dig out — reaching through \`shadowRoot\` from page code is
 * exactly the coupling shadow DOM exists to prevent.
 */
class ZelavisField extends ZelavisElement {
  static styles = \`
    :host { display: grid; gap: 0.25rem; flex: 1 1 18rem; }
    label { font-size: 0.8125rem; color: var(--muted-foreground); }
    label:empty { display: none; }
    input {
      font: inherit;
      width: 100%;
      padding: 0.375rem 0.625rem;
      border-radius: 0.5rem;
      border: 1px solid var(--border);
      background: var(--background);
      color: var(--foreground);
    }
  \`;
  static template = \`<label part="label"></label><input part="input" />\`;
  static observedAttributes = ["label", "placeholder", "type", "required", "disabled"];

  get input() {
    return this.shadowRoot?.querySelector("input") ?? undefined;
  }

  get value() {
    return this.input?.value ?? "";
  }

  set value(next) {
    if (this.input) this.input.value = next ?? "";
  }

  render() {
    const input = this.input;
    if (!input) return;
    this.slotText("[part=label]", this.getAttribute("label"));
    input.placeholder = this.getAttribute("placeholder") ?? "";
    input.type = this.getAttribute("type") ?? "text";
    input.required = this.hasAttribute("required");
    input.disabled = this.hasAttribute("disabled");
    input.setAttribute("aria-label", this.getAttribute("label") ?? "");
  }
}

/**
 * What a list says when it has nothing in it.
 *
 * Its own element because "nothing here yet", "still loading", and "that
 * failed" are three different states, and a page that renders one grey line for
 * all three tells the reader nothing.
 */
class ZelavisEmpty extends ZelavisElement {
  static styles = \`
    :host {
      display: block;
      padding: 1rem 1.25rem;
      border: 1px dashed var(--border);
      border-radius: 0.75rem;
      color: var(--muted-foreground);
      font-size: 0.875rem;
    }
    :host([tone="danger"]) {
      border-style: solid;
      border-color: var(--destructive);
      color: var(--destructive);
    }
  \`;
}

/** A short status line, announced when it changes. */
class ZelavisStatus extends ZelavisElement {
  static styles = \`
    :host { display: block; color: var(--muted-foreground); font-size: 0.8125rem; }
    :host([tone="danger"]) { color: var(--destructive); }
    :host(:empty) { display: none; }
  \`;

  connectedCallback() {
    // Set before the shadow root so a page assigning textContent immediately
    // still announces. Both are idempotent.
    if (!this.hasAttribute("role")) this.setAttribute("role", "status");
    if (!this.hasAttribute("aria-live")) this.setAttribute("aria-live", "polite");
    super.connectedCallback();
  }
}

define("zv-page", ZelavisPage);
define("zv-section", ZelavisSection);
define("zv-card", ZelavisCard);
define("zv-stack", ZelavisStack);
define("zv-row", ZelavisRow);
define("zv-title", ZelavisTitle);
define("zv-badge", ZelavisBadge);
define("zv-button", ZelavisButton);
define("zv-field", ZelavisField);
define("zv-empty", ZelavisEmpty);
define("zv-status", ZelavisStatus);
`;

/** The tags the baseline library defines, in the order it defines them. */
export const ZELAVIS_SERVICE_ELEMENT_TAGS = Object.freeze([
  "zv-page",
  "zv-section",
  "zv-card",
  "zv-stack",
  "zv-row",
  "zv-title",
  "zv-badge",
  "zv-button",
  "zv-field",
  "zv-empty",
  "zv-status",
] as const);

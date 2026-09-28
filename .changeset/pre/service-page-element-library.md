---
"zelavis": minor
---

Serve a component library service pages render with, and rebuild the
marketplace page on it.

A service page runs in its own document and inherits nothing from the
dashboard. The design tokens at `runtime/service-page.css` closed half that gap;
a page still wrote the markup for every card, badge, field, and empty state
itself, which is why the marketplace page was a placeholder built from bare
`div`s and a private copy of the layout rules.

`runtime/service-elements.js` now serves an element library — `zv-page`,
`zv-section`, `zv-card`, `zv-stack`, `zv-row`, `zv-title`, `zv-badge`,
`zv-button`, `zv-field`, `zv-empty`, `zv-status` — and a frontend may supply its
own through `serviceElementsScript`, exactly as it supplies the stylesheet.
Components belong to a design system, and the Platform ships a baseline only so
a page is never left composing nothing.

Each element renders into a shadow root, so a page's CSS cannot reach in and a
component's rules cannot leak out, while the tokens still reach the components
because custom properties inherit through shadow boundaries — the seam that lets
a frontend restyle every service page in the installation.

The frame stays. Shadow DOM scopes styles, not scripts, and rendering an
installed service's page inside the dashboard's document would give its code the
dashboard's origin and session.

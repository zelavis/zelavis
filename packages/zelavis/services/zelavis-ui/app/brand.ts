import { defineBrand } from "fuzor/ui/core";

/** The Zelavis components are fuzor/ui's under the `zv` prefix: `<zv-select>`, `<zv-dialog>` (styled by `zv-ui.css`). */
export function ensureBrand(): void {
  defineBrand("zv");
}

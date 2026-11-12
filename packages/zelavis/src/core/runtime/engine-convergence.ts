/**
 * Whether a Project's engine may follow the Platform's.
 *
 * A bound App follows the control plane's engine so it stays current without anyone choosing it. That is safe only while
 * the engines write the same data layout: an engine opens exactly its own layout and refuses another, so moving a
 * Project across a layout change would leave its data unopenable. A layout change is migrated by the Project's own recipe
 * upgrade (see the format-migration plan), never by the Platform update, so across one the Project stays on the engine
 * that wrote its data and waits for that upgrade.
 *
 * Both formats are declared by the engine releases themselves; nothing here reads or interprets stored data.
 */
export type EngineConvergence =
  | { readonly converge: true }
  | { readonly converge: false; readonly reason: string };

export const engineConvergence = (input: { readonly from: number; readonly to: number }): EngineConvergence => {
  for (const [name, format] of [["current", input.from], ["target", input.to]] as const) {
    if (!Number.isSafeInteger(format) || format < 1) return { converge: false, reason: `The ${name} engine declares no usable data format.` };
  }
  if (input.from === input.to) return { converge: true };
  return {
    converge: false,
    reason: input.from < input.to
      ? `The Project's data layout (format ${input.from}) is older than this Platform's (format ${input.to}); it stays on its current engine until its recipe is upgraded.`
      : `The Project's data layout (format ${input.from}) is newer than this Platform's (format ${input.to}); it stays on its current engine.`,
  };
};

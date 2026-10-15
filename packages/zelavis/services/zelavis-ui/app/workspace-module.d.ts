/** The adapter loads the existing, separately typed React workspace modules. */
declare module "*.jsx" {
  export function mount(host: HTMLElement): () => void;
}

declare module "virtual:fuzor/client" {
  export const router: import("fuzor/runtime").FuzorRouter | undefined;
  export const ready: Promise<(() => Promise<void>) | undefined>;
}
interface ImportMeta { readonly hot?: { dispose(callback: () => void): void }; }

declare module "*.css";

declare module "*.fragment.html" { const template: import("fuzor/server-components/protocol").CompiledFragment; export default template; }

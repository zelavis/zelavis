export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-1 flex-col justify-center px-6 py-16 sm:px-10">
      <div className="grid gap-10 lg:grid-cols-[1.2fr_0.8fr] lg:items-start">
        <div className="space-y-6">
          <div className="inline-flex items-center rounded-full border border-black/10 bg-black/5 px-3 py-1 text-sm text-black/70 dark:border-white/10 dark:bg-white/5 dark:text-white/70">
            Next.js App Router embedding demo
          </div>
          <div className="space-y-4">
            <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-black dark:text-white sm:text-5xl">
              Zelavis mounted through a Web handler inside Next.js.
            </h1>
            <p className="max-w-2xl text-base leading-7 text-black/70 dark:text-white/70 sm:text-lg">
              This example forwards App Router requests directly into Zelavis
              through the new universal fetch-style runtime instead of using a
              Node-specific adapter.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <a
              className="inline-flex h-11 items-center justify-center rounded-full bg-black px-5 text-sm font-medium text-white transition hover:bg-black/85 dark:bg-white dark:text-black dark:hover:bg-white/85"
              href="/zelavis"
            >
              Open dashboard
            </a>
            <a
              className="inline-flex h-11 items-center justify-center rounded-full border border-black/10 px-5 text-sm font-medium text-black transition hover:bg-black/5 dark:border-white/10 dark:text-white dark:hover:bg-white/5"
              href="/zelavis/api/v1/dashboard/config"
            >
              Inspect runtime config
            </a>
          </div>
        </div>

        <div className="rounded-3xl border border-black/10 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-black/20">
          <div className="space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-black/50 dark:text-white/50">
              What this proves
            </h2>
            <ul className="space-y-3 text-sm leading-6 text-black/70 dark:text-white/70">
              <li>• Zelavis can run without a mount-specific adapter.</li>
              <li>
                • Next.js can host the dashboard under <strong>/zelavis</strong>
                .
              </li>
              <li>
                • The same runtime can target fetch-oriented platforms next.
              </li>
            </ul>
            <div className="rounded-2xl bg-zinc-950 px-4 py-3 font-mono text-xs leading-6 text-zinc-100 dark:bg-zinc-900">
              <div>GET /zelavis</div>
              <div>GET /zelavis/settings</div>
              <div>GET /zelavis/api/v1/dashboard/config</div>
              <div>GET /zelavis/api/v1/auth/providers</div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

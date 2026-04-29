import Head from "next/head";
import { Geist, Geist_Mono } from "next/font/google";
import styles from "@/styles/Home.module.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export default function Home() {
  return (
    <>
      <Head>
        <title>Zelavis Next.js Pages Router demo</title>
        <meta
          name="description"
          content="Zelavis embedded through the legacy Next.js Pages Router."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <div
        className={`${styles.page} ${geistSans.variable} ${geistMono.variable}`}
      >
        <main className={styles.main}>
          <div className={styles.intro}>
            <span className={styles.eyebrow}>
              Next.js Pages Router embedding demo
            </span>
            <h1>Zelavis mounted through a Pages Router API route.</h1>
            <p>
              This example rewrites <strong>/zelavis</strong> requests into a
              legacy <strong>pages/api</strong> catch-all handler, then forwards
              them into the Zelavis runtime through a native Pages Router
              adapter.
            </p>
          </div>
          <div className={styles.ctas}>
            <a className={styles.primary} href="/zelavis">
              Open dashboard
            </a>
            <a
              className={styles.secondary}
              href="/zelavis/api/v1/dashboard/config"
            >
              Open config endpoint
            </a>
          </div>
          <ul className={styles.links}>
            <li>
              Dashboard root: <a href="/zelavis">/zelavis</a>
            </li>
            <li>
              Settings page: <a href="/zelavis/settings">/zelavis/settings</a>
            </li>
            <li>
              Config API:{" "}
              <a href="/zelavis/api/v1/dashboard/config">
                /zelavis/api/v1/dashboard/config
              </a>
            </li>
          </ul>
        </main>
      </div>
    </>
  );
}

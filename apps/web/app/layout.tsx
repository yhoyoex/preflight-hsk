import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { LogoMark } from "@/components/logo";
import { GITHUB_URL, mainnetContracts } from "@/lib/deployments";
import { SiteNav } from "./nav";
import "./globals.css";

const mainnetPending = mainnetContracts.some((c) => !c.address);

const TITLE = "Preflight · execution guard for AI agents on HSK Chain";
const DESCRIPTION =
  "Preflight tells an AI agent what a swap costs before it is sent, and reverts on-chain past its limit.";

// Icons and the OG image come from the file conventions in app/ (icon.svg, favicon.ico, apple-icon.png,
// opengraph-image.tsx); Next adds those tags itself.
export const metadata: Metadata = {
  metadataBase: new URL("https://preflight-hsk.vercel.app"),
  title: { default: TITLE, template: "%s · Preflight" },
  description: DESCRIPTION,
  applicationName: "Preflight",
  openGraph: {
    type: "website",
    siteName: "Preflight",
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export const viewport = { themeColor: "#0b0c0f" };

const footerLinks = [
  { href: "/playground", label: "Playground" },
  { href: "/leaderboard", label: "Execution-cost leaderboard" },
  { href: "/api/leaderboard", label: "Leaderboard JSON API" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col bg-ground font-sans text-soft antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-raised focus:px-3 focus:py-2 focus:text-sm focus:text-ink"
        >
          Skip to content
        </a>
        <header className="sticky top-0 z-40 bg-ground">
          <SiteNav />
        </header>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 pt-10 pb-24 sm:px-6 sm:pt-14">
          {children}
        </main>
        <footer className="bg-surface">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr]">
            <div className="space-y-3">
              <p className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-ink">
                <LogoMark className="size-9" />
                Preflight
              </p>
              <p className="max-w-md text-sm leading-relaxed text-muted">
                Execution guard for AI agents on HSK Chain mainnet (177){mainnetPending ? " (pending)" : ""}, pricing the HSKSwap Uniswap V3 pool WHSK/USDT
                0.3%. Built for the HSK Chain Horizon Hackathon, Seoul. Not trading advice.
              </p>
            </div>
            <ul className="grid content-start gap-2 text-sm sm:grid-cols-2">
              {footerLinks.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-soft underline-offset-4 hover:text-ink hover:underline">
                    {l.label}
                  </Link>
                </li>
              ))}
              <li>
                <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="text-soft underline-offset-4 hover:text-ink hover:underline">
                  Source on GitHub<span className="sr-only"> (opens in a new tab)</span>
                </a>
              </li>
            </ul>
          </div>
        </footer>
      </body>
    </html>
  );
}

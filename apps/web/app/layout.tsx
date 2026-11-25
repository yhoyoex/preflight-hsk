import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteNav } from "./nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Preflight",
  description: "Preflight tells an AI agent what a swap costs before it is sent, and reverts on-chain past its limit.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-950 text-zinc-200 antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-zinc-800 focus:px-3 focus:py-2 focus:text-sm"
        >
          Skip to content
        </a>
        <header className="border-b border-zinc-800/80">
          <SiteNav />
        </header>
        <main id="main" className="mx-auto max-w-5xl px-5 py-10">
          {children}
        </main>
        <footer className="mx-auto max-w-5xl px-5 pb-10 text-xs text-zinc-500">
          HSK Chain mainnet (177) · HSKSwap Uniswap V3 pool WHSK/USDT 0.3%
        </footer>
      </body>
    </html>
  );
}

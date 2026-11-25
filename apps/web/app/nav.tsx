"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui";
import { GITHUB_URL } from "@/lib/deployments";

const LINKS = [
  { href: "/playground", label: "Playground" },
  { href: "/leaderboard", label: "Leaderboard" },
] as const;

export function SiteNav() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
      <Link href="/" className="flex items-center gap-2 rounded-sm text-lg font-semibold tracking-tight text-ink">
        <span aria-hidden="true" className="size-2.5 rounded-full bg-accent" />
        Preflight
      </Link>
      <ul className="flex items-center gap-1 text-sm">
        {LINKS.map((l) => {
          const active = path === l.href || path.startsWith(`${l.href}/`);
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-10 items-center rounded-md px-2.5 transition-colors sm:px-3",
                  active ? "bg-raised text-ink" : "text-muted hover:text-ink",
                )}
              >
                {l.label}
              </Link>
            </li>
          );
        })}
        <li>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-10 items-center gap-2 rounded-md px-2.5 text-muted transition-colors hover:text-ink sm:px-3"
          >
            <GitHubMark />
            <span className="sr-only sm:not-sr-only">GitHub</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </li>
      </ul>
    </nav>
  );
}

function GitHubMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 fill-current">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

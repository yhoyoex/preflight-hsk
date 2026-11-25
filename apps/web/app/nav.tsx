"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/playground", label: "Playground" },
  { href: "/leaderboard", label: "Leaderboard" },
] as const;

export function SiteNav() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4">
      <Link href="/" className="rounded-sm font-semibold tracking-tight text-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-400">
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
                className={`rounded-md px-3 py-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-emerald-400 ${
                  active ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:text-zinc-100"
                }`}
              >
                {l.label}
              </Link>
            </li>
          );
        })}
        <li>
          <a
            href="/api/leaderboard"
            className="rounded-md px-3 py-1.5 text-zinc-400 transition-colors hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-emerald-400"
          >
            API
          </a>
        </li>
      </ul>
    </nav>
  );
}

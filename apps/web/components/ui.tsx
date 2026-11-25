import type { VerdictKind } from "@preflight/core";
import Link from "next/link";
import type { ReactNode } from "react";
import { TONE_CLASSES, VERDICT_COPY } from "@/lib/verdict-copy";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** Page title block shared by every page. */
export function PageHeader({ title, lead, children }: { title: string; lead: ReactNode; children?: ReactNode }) {
  return (
    <header className="max-w-3xl space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight text-balance text-ink sm:text-4xl">{title}</h1>
      <p className="text-base leading-relaxed text-soft sm:text-lg">{lead}</p>
      {children}
    </header>
  );
}

/** Section with a naming heading and optional lead paragraph. */
export function Section({
  id,
  title,
  lead,
  children,
  className,
}: {
  id: string;
  title: string;
  lead?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn("scroll-mt-24", className)}>
      <div className="max-w-3xl">
        <h2 id={id} className="text-2xl font-semibold tracking-tight text-balance text-ink sm:text-3xl">
          {title}
        </h2>
        {lead && <p className="mt-3 text-base leading-relaxed text-soft">{lead}</p>}
      </div>
      <div className="mt-8">{children}</div>
    </section>
  );
}

/** Surface panel: a tone step above the ground, no border or shadow. */
export function Panel({
  children,
  className,
  as: Tag = "div",
  labelledBy,
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
  labelledBy?: string;
}) {
  return (
    <Tag aria-labelledby={labelledBy} className={cn("rounded-lg bg-surface p-5 sm:p-6", className)}>
      {children}
    </Tag>
  );
}

export function PanelTitle({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h2 id={id} className="text-base font-semibold text-ink">
      {children}
    </h2>
  );
}

/** Key figure. Render inside a <dl>. */
export function Stat({ label, value, hint, size = "md" }: { label: string; value: string; hint?: ReactNode; size?: "md" | "lg" }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd
        className={cn(
          "mt-1 font-semibold tracking-tight text-ink",
          size === "lg" ? "text-3xl sm:text-4xl" : "text-2xl",
        )}
      >
        {value}
      </dd>
      {hint && <dd className="mt-1 text-sm leading-snug text-muted">{hint}</dd>}
    </div>
  );
}

const BUTTON = {
  primary: "bg-accent text-on-accent hover:bg-accent-strong",
  secondary: "bg-raised text-ink hover:bg-edge",
} as const;

export function buttonClass(variant: keyof typeof BUTTON = "primary", extra?: string): string {
  return cn(
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-5 text-sm font-semibold transition-colors",
    BUTTON[variant],
    extra,
  );
}

export function ButtonLink({
  href,
  children,
  variant = "primary",
  external,
}: {
  href: string;
  children: ReactNode;
  variant?: keyof typeof BUTTON;
  external?: boolean;
}) {
  if (external)
    return (
      <a href={href} target="_blank" rel="noreferrer" className={buttonClass(variant)}>
        {children}
      </a>
    );
  return (
    <Link href={href} className={buttonClass(variant)}>
      {children}
    </Link>
  );
}

export const linkClass = "text-accent-strong underline-offset-4 hover:underline";

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cn(linkClass, className)}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function VerdictBadge({ kind, className }: { kind: VerdictKind; className?: string }) {
  const copy = VERDICT_COPY[kind];
  const tone = TONE_CLASSES[copy.tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        tone.chip,
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone.dot)} />
      {copy.label}
    </span>
  );
}

import { cn } from "./ui";

/** Paths shared with public/brand/preflight-mark.svg (64×64): shield + check that turns into a trade arrow. */
export const MARK_SHIELD = "M32 4 55 12.5V30c0 14.4-9.6 25.4-23 30C18.6 55.4 9 44.4 9 30V12.5Z";
export const MARK_CHECK = "M20 33l8.5 8.5L44 24M34 23.5h10.5V34";

/** Decorative mark; pair it with visible text (the wordmark) for the accessible name. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" className={cn("shrink-0", className)}>
      <path className="fill-accent" d={MARK_SHIELD} />
      <path
        className="stroke-ground"
        d={MARK_CHECK}
        fill="none"
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

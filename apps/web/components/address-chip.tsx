import { shortAddress } from "@/lib/leaderboard";
import { CopyButton } from "./copy-button";
import { cn, linkClass } from "./ui";

/** Address or tx hash: shortened link to the explorer plus a copy button. */
export function AddressChip({
  value,
  href,
  kind = "address",
  className,
}: {
  value: string;
  href: string;
  kind?: "address" | "transaction";
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={value}
        className={cn("font-mono text-sm", linkClass)}
      >
        {shortAddress(value)}
        <span className="sr-only">
{` (view ${kind} on explorer, new tab)`}
        </span>
      </a>
      <CopyButton value={value} label={`Copy ${kind} ${value}`} />
    </span>
  );
}

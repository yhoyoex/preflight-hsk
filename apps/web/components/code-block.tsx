import { CopyButton } from "./copy-button";

/** Real code with a copy action. `title` names the snippet for the copy button label. */
export function CodeBlock({ code, title }: { code: string; title: string }) {
  return (
    <figure className="overflow-hidden rounded-lg bg-surface">
      <figcaption className="flex items-center justify-between gap-3 bg-raised px-4 py-2 text-sm text-soft">
        <span>{title}</span>
        <CopyButton value={code} label={`Copy ${title}`} className="bg-surface" />
      </figcaption>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed text-soft">
        <code>{code}</code>
      </pre>
    </figure>
  );
}

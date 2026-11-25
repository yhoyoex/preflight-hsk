const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("en-US");

export const fmtUsd = (x: number) => usd.format(x);
export const fmtInt = (x: number) => int.format(x);
export const fmtBps = (x: number | null) =>
  x === null ? "–" : `${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} bps`;
export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const fmtAmount = (x: number, maxFrac = 2) => x.toLocaleString("en-US", { maximumFractionDigits: maxFrac });

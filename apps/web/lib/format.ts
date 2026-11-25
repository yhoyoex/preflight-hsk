const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("en-US");

const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const fmtUsd = (x: number) => usd.format(x);
/** Like fmtUsd but drops ".00" for whole-dollar sizes ($5,000 instead of $5,000.00). */
export const fmtUsdSize = (x: number) => (Number.isInteger(x) ? usdWhole.format(x) : usd.format(x));
export const fmtInt = (x: number) => int.format(x);
export const fmtBps = (x: number | null) =>
  x === null ? "–" : `${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} bps`;
export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const fmtAmount = (x: number, maxFrac = 2) => x.toLocaleString("en-US", { maximumFractionDigits: maxFrac });

import { ImageResponse } from "next/og";
import { MARK_CHECK, MARK_SHIELD } from "@/components/logo";

// ImageResponse (Satori) only accepts inline styles; colours mirror the tokens in globals.css.
const C = { ground: "#0b0c0f", surface: "#13151a", ink: "#f3f4f6", soft: "#c7cad1", muted: "#9aa0ab", accent: "#34d399" };

export const alt = "Preflight: execution guard for AI agents on HSK Chain";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: C.ground,
          color: C.soft,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <svg width="96" height="96" viewBox="0 0 64 64">
            <path d={MARK_SHIELD} fill={C.accent} />
            <path d={MARK_CHECK} fill="none" stroke={C.ground} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div style={{ fontSize: 64, fontWeight: 700, color: C.ink, letterSpacing: -1.5 }}>Preflight</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 68, fontWeight: 700, color: C.ink, letterSpacing: -2, lineHeight: 1.05 }}>
            Know the cost before the swap
          </div>
          <div style={{ fontSize: 32, lineHeight: 1.35, maxWidth: 960 }}>
            Execution guard for AI agents on HSK Chain: quote the cost, sign it, and revert on-chain past the limit.
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 26, color: C.muted }}>
          <div style={{ display: "flex", color: C.accent }}>preflight-hsk.vercel.app</div>
          <div style={{ display: "flex", padding: "10px 20px", borderRadius: 999, background: C.surface }}>
            HSK Chain Horizon Hackathon · Seoul
          </div>
        </div>
      </div>
    ),
    size,
  );
}

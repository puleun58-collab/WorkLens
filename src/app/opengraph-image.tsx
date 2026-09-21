import { ImageResponse } from "next/og";
import { WORKLENS_FRAME_PATH, WORKLENS_W_PATH } from "./worklens-logo";

export const alt = "WorkLens | 업무 문서 분석·비교·검수";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        padding: "0 104px",
        background: "#0f172a",
        color: "#ffffff",
        display: "flex",
        alignItems: "center",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 48,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <svg width="104" height="104" viewBox="0 0 32 32" aria-label="WorkLens">
            <path d={WORKLENS_FRAME_PATH} fill="#3b82f6" />
            <path d={WORKLENS_W_PATH} fill="#ffffff" />
          </svg>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              fontSize: 70,
              fontWeight: 700,
              letterSpacing: -2.5,
              lineHeight: 1,
            }}
          >
            <span style={{ display: "flex", color: "#ffffff" }}>Work</span>
            <span style={{ display: "flex", color: "#3b82f6" }}>Lens</span>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            maxWidth: 900,
            color: "#d7e0ec",
            fontSize: 40,
            fontWeight: 500,
            letterSpacing: -1,
            lineHeight: 1.35,
          }}
        >
          업무 문서 분석·비교·검수
        </div>
      </div>
    </div>,
    size,
  );
}

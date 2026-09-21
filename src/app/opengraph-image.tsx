import { ImageResponse } from "next/og";

export const alt = "WorkLens 업무 문서 작업 공간";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px",
        background: "#f7f9fc",
        color: "#10213d",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
        <div
          style={{
            width: 68,
            height: 68,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "2px solid #2563eb",
            borderRadius: 12,
            color: "#2563eb",
            fontSize: 30,
            fontWeight: 700,
          }}
        >
          W
        </div>
        <div style={{ display: "flex", fontSize: 34, fontWeight: 700 }}>WorkLens</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        <div style={{ display: "flex", maxWidth: 900, fontSize: 64, lineHeight: 1.16, fontWeight: 700, letterSpacing: -2 }}>
          업무 문서를 더 정확하고 빠르게
        </div>
        <div style={{ display: "flex", fontSize: 29, color: "#52627a" }}>
          분석 · 비교 · 검수 · 윤문 · 추출 · 요약
        </div>
      </div>
      <div style={{ display: "flex", width: "100%", height: 6, background: "#2563eb", borderRadius: 3 }} />
    </div>,
    size,
  );
}

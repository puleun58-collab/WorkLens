import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./workspace-shell.css";
import { AssistantWidget } from "@/components/assistant/AssistantWidget";

const origin = new URL(process.env.WORKLENS_ORIGIN ?? "https://worklens.puleun58.workers.dev");
const title = "WorkLens | 업무 문서 작업 공간";
const description = "문서 분석·비교·검수·추출·취합과 법령 리서치를 한곳에서 처리합니다.";
const shareImage = "/brand/worklens-og-document-lens.png?v=3";
const shareImageAlt = "WorkLens 문서 레이어와 돋보기 로고 | 업무 문서 작업 공간";

export const metadata: Metadata = {
  metadataBase: origin,
  title,
  description,
  alternates: { canonical: "/" },
  openGraph: {
    title,
    description,
    siteName: "WorkLens",
    type: "website",
    locale: "ko_KR",
    url: "/",
    images: [{ url: shareImage, width: 1200, height: 630, type: "image/png", alt: shareImageAlt }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [{ url: shareImage, alt: shareImageAlt }],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}<AssistantWidget /></body>
    </html>
  );
}

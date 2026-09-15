import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "WorkLens | Analyze. Compare. Verify.",
  description: "WorkLens 파일 분석 및 비교 작업 공간",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" className="h-full antialiased">
      <head>
        {/* Single self-hosted variable font; preloaded because every surface depends on it. */}
        <link
          rel="preload"
          href="/fonts/pretendard/PretendardVariable.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

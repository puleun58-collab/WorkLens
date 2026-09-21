import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const origin = new URL(process.env.WORKLENS_ORIGIN ?? "https://worklens.puleun58.workers.dev");
const title = "WorkLens | 업무 문서 분석·비교·검수";
const description = "업무 문서를 분석하고 비교·검수할 수 있는 문서 작업 공간";

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
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "WorkLens | 업무 문서 분석·비교·검수" }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/opengraph-image"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

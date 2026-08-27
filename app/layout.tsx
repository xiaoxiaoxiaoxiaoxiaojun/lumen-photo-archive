import type { Metadata } from "next";
import { Geist, Noto_Serif_SC } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geist = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const notoSerif = Noto_Serif_SC({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["400", "600"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "LUMEN｜私人摄影档案";
  const description = "收藏、管理与分享你的云端摄影作品。使用 Google 安全登录。";
  return {
    metadataBase: new URL(origin),
    title,
    description,
    icons: { icon: "/favicon.svg?v=4" },
    openGraph: { title, description, type: "website", images: [{ url: `${origin}/og.png`, width: 1731, height: 909, alt: "LUMEN 私人摄影档案" }] },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og.png`] },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`${geist.variable} ${notoSerif.variable}`}>
        {children}
      </body>
    </html>
  );
}

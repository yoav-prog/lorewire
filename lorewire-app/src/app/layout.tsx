import type { Metadata, Viewport } from "next";
import { Archivo, Hanken_Grotesk, Spline_Sans_Mono, Caveat } from "next/font/google";
import RegisterSW from "@/components/RegisterSW";
import "./globals.css";

const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo" });
const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken" });
const spline = Spline_Sans_Mono({ subsets: ["latin"], variable: "--font-spline" });
const caveat = Caveat({ subsets: ["latin"], variable: "--font-caveat" });

export const metadata: Metadata = {
  applicationName: "LoreWire",
  title: "LoreWire — The internet's stories, retold",
  description: "Netflix for true internet stories. Watch the short, read the article, or read along.",
  appleWebApp: { capable: true, title: "LoreWire", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#0A0A0C",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${hanken.variable} ${spline.variable} ${caveat.variable}`}
    >
      <body>
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}

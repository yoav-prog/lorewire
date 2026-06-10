import type { Metadata } from "next";
import { Archivo, Hanken_Grotesk, Spline_Sans_Mono, Caveat } from "next/font/google";
import "./globals.css";

const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo" });
const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken" });
const spline = Spline_Sans_Mono({ subsets: ["latin"], variable: "--font-spline" });
const caveat = Caveat({ subsets: ["latin"], variable: "--font-caveat" });

export const metadata: Metadata = {
  title: "LoreWire — The internet's stories, retold",
  description: "Netflix for true internet stories. Watch the short, read the article, or read along.",
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
      <body>{children}</body>
    </html>
  );
}

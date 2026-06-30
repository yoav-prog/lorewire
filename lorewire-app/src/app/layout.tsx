import type { Metadata, Viewport } from "next";
import { Archivo, Fraunces, Hanken_Grotesk, Spline_Sans_Mono, Caveat } from "next/font/google";
import ConditionalAnalytics from "@/components/ConditionalAnalytics";
import RegisterSW from "@/components/RegisterSW";
import { getSiteSeo } from "@/lib/site-seo";
import {
  ThemeProvider,
  THEME_INIT_SCRIPT,
} from "@/components/ThemeProvider";
import "./globals.css";

const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo" });
// 2026-06-26 visual-distance pass: Fraunces on --font-display.
// Variable serif with optical sizing — letterforms physically reshape
// between large display sizes and small chrome sizes. Modern
// editorial vibe (Substack / Linear / Vercel-blog adjacent), not the
// wedding-invitation feel of older serifs like Playfair. Variable
// font so no `weight` array — all weights via one file.
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces" });
const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken" });
const spline = Spline_Sans_Mono({ subsets: ["latin"], variable: "--font-spline" });
const caveat = Caveat({ subsets: ["latin"], variable: "--font-caveat" });

// Site-wide metadata + viewport. Both functions read the admin-configured
// seo.* settings from settings_kv, with safe defaults baked into
// lib/site-seo.ts so a brand-new install still ships with a sensible title
// and theme color before anyone visits Settings → SEO.

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSiteSeo();
  return {
    applicationName: seo.siteName,
    title: {
      default: seo.siteName,
      // Per-page generateMetadata calls handle their own templates; this
      // is the fallback title for any page that doesn't set its own.
      template: seo.titleTemplate,
    },
    description: seo.defaultMetaDescription,
    appleWebApp: {
      capable: true,
      title: seo.siteName,
      statusBarStyle: "black-translucent",
    },
    verification: {
      google: seo.googleVerification || undefined,
      other: seo.bingVerification
        ? { "msvalidate.01": seo.bingVerification }
        : undefined,
    },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const seo = await getSiteSeo();
  return {
    themeColor: seo.themeColor,
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${fraunces.variable} ${hanken.variable} ${spline.variable} ${caveat.variable}`}
    >
      <head>
        {/* Runs BEFORE React hydration so the document paints with the
         * right palette on first paint. No FOUC. Reads localStorage,
         * checks prefers-color-scheme when choice="system", applies
         * data-theme="light" when needed. */}
        <script
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
        <RegisterSW />
        <ConditionalAnalytics />
      </body>
    </html>
  );
}

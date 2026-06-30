"use client";

// Analytics surface, gated on cookie consent.
//
// Loads Google Analytics 4, Vercel Analytics, and Vercel Speed Insights
// ONLY when the user has pressed Accept on the cookie banner. When consent
// is null (banner not yet answered) or "rejected", this component renders
// null — no scripts in the DOM, no beacons fired.
//
// GA4 configuration choices (intentional, see Privacy Policy §3):
//   - anonymize_ip: true
//   - allow_google_signals: false
//   - allow_ad_personalization_signals: false
//   - No remarketing
//
// SPA navigation: Next.js client-side route changes don't trigger a fresh
// page load, so GA4's initial gtag('config') only counts the first view.
// usePathname() lets us send a page_view event on every subsequent route
// change. Vercel Analytics handles its own route change detection.
//
// Env vars:
//   NEXT_PUBLIC_GA_MEASUREMENT_ID — when unset, GA4 is silently skipped
//                                   even with consent accepted (so Vercel
//                                   Analytics and Speed Insights can still
//                                   run on a deploy with no GA configured).
//
// Mounted from src/app/layout.tsx so it covers every page.

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { useConsent } from "@/lib/consent-client";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

export default function ConditionalAnalytics() {
  const consent = useConsent();
  const accepted = consent === "accepted";
  const pathname = usePathname();

  useEffect(() => {
    console.info("[analytics consent] state", {
      consent,
      ga_configured: !!GA_MEASUREMENT_ID,
      ga_active: accepted && !!GA_MEASUREMENT_ID,
      vercel_active: accepted,
    });
  }, [consent, accepted]);

  useEffect(() => {
    if (!accepted || !GA_MEASUREMENT_ID) return;
    if (typeof window === "undefined" || !window.gtag) return;
    window.gtag("event", "page_view", {
      page_path: pathname,
      page_location: window.location.href,
    });
    console.info("[analytics consent] pageview", { pathname });
  }, [pathname, accepted]);

  if (!accepted) return null;

  return (
    <>
      {GA_MEASUREMENT_ID ? (
        <>
          <Script
            id="ga4-loader"
            src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
            strategy="afterInteractive"
            onLoad={() =>
              console.info("[analytics consent] mount", { provider: "ga4" })
            }
            onError={() =>
              console.warn("[analytics consent] script-error", {
                provider: "ga4",
              })
            }
          />
          <Script id="ga4-init" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              window.gtag = gtag;
              gtag('js', new Date());
              gtag('config', '${GA_MEASUREMENT_ID}', {
                anonymize_ip: true,
                allow_google_signals: false,
                allow_ad_personalization_signals: false,
                send_page_view: true
              });
            `}
          </Script>
        </>
      ) : null}
      <Analytics />
      <SpeedInsights />
    </>
  );
}

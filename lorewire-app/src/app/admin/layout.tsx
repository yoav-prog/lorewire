import type { Metadata } from "next";

// Admin segment layout. Sole job today: declare metadata.robots so every
// page under /admin/* emits <meta name="robots" content="noindex,nofollow">,
// matching the Disallow rule in app/robots.ts. The (panel) layout still
// owns the actual chrome (sidebar + header); this layer adds nothing visual
// — `children` passes straight through.

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
    },
  },
};

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}

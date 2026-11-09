import type { Metadata } from "next";

// Auth segment layout. Sole job: declare metadata.robots so every page
// under /auth/* (signin, signup, account, signout, magic-link, provider
// callbacks) emits noindex — none of these belong in search results, and
// signout / OAuth callback URLs should never be crawled at all. Mirrors
// the pattern app/admin/layout.tsx uses; `children` passes straight
// through, no chrome.

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

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}

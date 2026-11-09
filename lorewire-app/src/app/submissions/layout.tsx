import type { Metadata } from "next";

// Submissions segment layout. Sole job: declare metadata.robots so the
// user's personal submissions area (/submissions, /submissions/new) emits
// noindex, follow — same policy as /settings: a per-user utility surface
// with no search value. follow stays true so internal links keep passing
// crawl. Mirrors app/admin/layout.tsx; `children` passes straight through.

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: true,
  },
};

export default function SubmissionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}

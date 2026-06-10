// Optimistic auth guard. Runs before /admin routes render and bounces anyone
// without a valid session cookie to the login page. This is a fast cookie-only
// check; the authoritative DB/role check happens in requireAdmin() at the data
// source. Kept self-contained per the proxy convention (no shared app modules).

import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "lw_session";

async function isAuthed(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;
  try {
    await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
    });
    return true;
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authed = await isAuthed(request.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === "/admin/login") {
    if (authed) return NextResponse.redirect(new URL("/admin", request.url));
    return NextResponse.next();
  }

  if (!authed) {
    return NextResponse.redirect(new URL("/admin/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};

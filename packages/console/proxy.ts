import { NextRequest, NextResponse } from "next/server";
import {
  credentialsFromEnv,
  isAuthorizedHeader,
  isLoopbackHostname,
} from "./lib/operator-auth";

export function proxy(request: NextRequest) {
  if (
    process.env.ALLOW_REMOTE_OPERATOR_CONSOLE !== "true" &&
    !isLoopbackHostname(request.nextUrl.hostname)
  ) {
    return new NextResponse("Operator console is restricted to localhost.", { status: 403 });
  }

  const credentials = credentialsFromEnv();
  if (!credentials) {
    return new NextResponse("Operator credentials are not configured.", { status: 503 });
  }
  if (!isAuthorizedHeader(request.headers.get("authorization"), credentials)) {
    return new NextResponse("Authentication required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="api-migrator operator", charset="UTF-8"' },
    });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

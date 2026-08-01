import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "api-migrator operator console",
  description: "Preview and approve local API migration pilots",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a href="/" className="brand">api-migrator</a>
          <span className="operator-label">local operator pilot</span>
          <nav>
            <a href="/campaigns">Campaigns</a>
            <a href="/campaigns/new" className="btn">New campaign</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}

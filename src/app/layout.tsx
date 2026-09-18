/**
 * Root layout.
 *
 * This service is an API, not a site — the layout exists because Next requires
 * one. There is deliberately no page: a billing service with a browsable UI is
 * a second place for balances to be shown, and crewpe-ui already owns that.
 */
export const metadata = { title: "enginos-billing" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

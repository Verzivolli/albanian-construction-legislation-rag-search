import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KTP Search — KodiAI demo",
  description: "Grounded AI answers over Albania's technical design codes (KTP), with clickable citations. Demo of ongoing work.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sq">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}

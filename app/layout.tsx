import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

// Swapped from Next.js's own default Geist fonts (2026-08-01, via
// /frontend-design) -- Geist is the single most recognizable "unstyled
// create-next-app starter" signal, worth losing on principle for a
// portfolio piece. IBM Plex has real engineering-documentation heritage
// (IBM's own technical design system) -- Sans for chat/body text, Mono
// for citations/labels so they read as stamped reference codes.
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Asistent AI · Legjislacioni i Ndërtimit",
  description: "AI chat i bazuar në legjislacionin shqiptar të ndërtimit, me citime nga burimi.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="sq"
      className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

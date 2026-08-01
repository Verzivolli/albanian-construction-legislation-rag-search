import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Disabled (2026-08-01): Next's own dev-only overlay (the "N" icon) has
  // no documented way to remove individual menu items -- it's an internal
  // devtool, not a configurable component. Its light/dark option only
  // ever affected its own popup chrome, never the real page, which is
  // exactly the confusion this was disabled to fix. Replaced by a real
  // in-app toggle (components/ThemeToggle.tsx) that actually works.
  // Dev-only either way -- never shipped to production regardless.
  devIndicators: false,
};

export default nextConfig;

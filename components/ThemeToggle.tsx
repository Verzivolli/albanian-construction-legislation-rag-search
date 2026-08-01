// Real in-app light/dark toggle (2026-08-01) -- replaces relying on
// Next.js's own dev-only indicator popup, whose light/dark option only
// ever affected that popup's own chrome, never the actual page. This one
// writes a `data-theme` attribute onto <html>, which globals.css's
// [data-theme="light"/"dark"] blocks key off of.
"use client";

import { useState, useEffect } from "react";

const STORAGE_KEY = "albanian-construction-theme";

export default function ThemeToggle() {
  // Starts null (not "dark") on purpose: the real saved preference only
  // exists in localStorage, which isn't readable during server render --
  // reading it in the initial state would mismatch the server's HTML and
  // trigger the same kind of hydration warning explained earlier today.
  // null just means "haven't checked yet," resolved in the effect below.
  const [theme, setTheme] = useState<"dark" | "light" | null>(null);

  // Runs once on mount: reads any saved preference, defaults to "dark"
  // (the site's original/tested look) if this is a first visit.
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    setTheme(saved === "light" ? "light" : "dark");
  }, []);

  // Applies the theme to the real DOM + persists it, every time it
  // changes. Skipped on the very first render (theme is still null then)
  // so it doesn't fight with the effect above.
  useEffect(() => {
    if (theme === null) return;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  function toggle() {
    setTheme((t) => (t === "light" ? "dark" : "light"));
  }

  return (
    <button
      onClick={toggle}
      aria-label="Ndrysho temën e faqes"
      className="font-mono text-xs tracking-[0.1em] text-steel underline hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rebar focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
    >
      {theme === "light" ? "ERR" : "DITA"}
    </button>
  );
}

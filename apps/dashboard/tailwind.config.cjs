/* global module */
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "media",
  content: ["./apps/dashboard/src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      fontSize: {
        xs: ["0.8125rem", { lineHeight: "1.25rem" }],
      },
      colors: {
        background: "hsl(var(--background))",
        surface: "hsl(var(--surface))",
        foreground: "hsl(var(--foreground))",
        subtle: "hsl(var(--subtle))",
        muted: "hsl(var(--muted))",
        border: "hsl(var(--border))",
        primary: "hsl(var(--primary))",
        "primary-foreground": "hsl(var(--primary-foreground))",
        ring: "hsl(var(--ring))",
      },
    },
  },
  plugins: [],
};

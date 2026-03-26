/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Brand — hsl(222, 82%, 44%) = #1448CC
        brand: {
          DEFAULT: "#1448CC",
          light: "rgba(20,72,204,.08)",
          light2: "rgba(20,72,204,.15)",
        },
        // Semantic
        success: "#16A34A",
        warning: "#D97706",
        danger: "#DC2626",
        info: "#0891B2",
        // Surfaces
        background: "#F4F6FA",
        card: "#FFFFFF",
        muted: "#F0F2F5",
        // Text
        fg: "#1A1F36",
        "muted-fg": "#6B7280",
        // Border
        border: "#E5E7EB",
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', "system-ui", "sans-serif"],
        display: ['"Unbounded"', "system-ui", "sans-serif"],
      },
      borderRadius: {
        DEFAULT: "10px",
      },
      boxShadow: {
        card: "0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.02)",
      },
    },
  },
  plugins: [],
};

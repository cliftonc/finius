const path = require("path");
const { heroui } = require("@heroui/react");

// @heroui/theme is not always hoisted to the top-level node_modules (npm dedupe
// can nest it under @heroui/react/node_modules). Resolve its real dist path so
// Tailwind scans HeroUI's component class names — otherwise components render unstyled.
const herouiThemeDir = path.dirname(
  require.resolve("@heroui/theme/package.json", {
    paths: [path.dirname(require.resolve("@heroui/react/package.json"))]
  })
);

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    path.join(herouiThemeDir, "dist/**/*.{js,ts,jsx,tsx}")
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif"
        ]
      }
    }
  },
  darkMode: "class",
  plugins: [heroui()]
};

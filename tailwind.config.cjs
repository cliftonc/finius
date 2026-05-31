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
      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "0.875rem" }]
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif"
        ],
        // "Money" display face — a high-contrast serif for the wordmark and section headings,
        // giving the dashboard an established, private-banking feel against the Inter UI body.
        display: ["Fraunces", "ui-serif", "Georgia", "Cambria", "Times New Roman", "serif"]
      }
    }
  },
  darkMode: "class",
  plugins: [
    heroui({
      themes: {
        // Brand palette, anchored to the logo green (#5C9E31) as `primary`, paired with a
        // trustworthy banking blue as `secondary`, plus a faintly green-tinted neutral scale.
        light: {
          colors: {
            background: "#fafbf8",
            foreground: "#16201a",
            focus: "#5c9e31",
            primary: {
              50: "#f2f9ec",
              100: "#e0f0d0",
              200: "#c4e2a4",
              300: "#a3d176",
              400: "#82bb4d",
              500: "#5c9e31",
              600: "#4a8127",
              700: "#39651f",
              800: "#2b4c18",
              900: "#1d3310",
              DEFAULT: "#5c9e31",
              foreground: "#ffffff"
            },
            secondary: {
              50: "#eef4fb",
              100: "#d6e4f6",
              200: "#aecbed",
              300: "#7eaae0",
              400: "#4f88d4",
              500: "#2f6fc4",
              600: "#245aa3",
              700: "#1d477f",
              800: "#173860",
              900: "#112a47",
              DEFAULT: "#2f6fc4",
              foreground: "#ffffff"
            },
            success: {
              50: "#e9f9f1",
              100: "#c9f0dd",
              200: "#94e1bb",
              300: "#5bcd97",
              400: "#2db575",
              500: "#149a5e",
              600: "#0f7c4c",
              700: "#0c603b",
              800: "#08462b",
              900: "#05301d",
              DEFAULT: "#149a5e",
              foreground: "#ffffff"
            },
            default: {
              50: "#f4f6f2",
              100: "#e9ece6",
              200: "#dadfd6",
              300: "#c4ccbe",
              400: "#9aa593",
              500: "#73806b",
              600: "#586250",
              700: "#41493b",
              800: "#2d332a",
              900: "#1d211b",
              DEFAULT: "#dadfd6",
              foreground: "#16201a"
            }
          }
        },
        dark: {
          colors: {
            background: "#0e140f",
            foreground: "#e7ece4",
            focus: "#82bb4d",
            content1: "#161d18",
            content2: "#1f2a21",
            content3: "#29372b",
            content4: "#34472f",
            // Tints run dark -> light (50 -> 900) so utilities like bg-primary-100 stay subtle
            // and text-primary-600 stays legible on dark surfaces.
            primary: {
              50: "#0f1c09",
              100: "#16290d",
              200: "#1f3a12",
              300: "#2c5119",
              400: "#3d6f22",
              500: "#5c9e31",
              600: "#74b84a",
              700: "#93cd6e",
              800: "#b7e09c",
              900: "#dcf0cb",
              DEFAULT: "#5c9e31",
              foreground: "#0a1206"
            },
            secondary: {
              50: "#0c1726",
              100: "#112138",
              200: "#173052",
              300: "#1f4170",
              400: "#2a5896",
              500: "#3a74c0",
              600: "#5c93d8",
              700: "#8bb4e6",
              800: "#b6d1f0",
              900: "#ddeafa",
              DEFAULT: "#4f88d4",
              foreground: "#06101a"
            },
            success: {
              50: "#052c1c",
              100: "#08462b",
              200: "#0c603b",
              300: "#0f7c4c",
              400: "#149a5e",
              500: "#1fb472",
              600: "#42c98e",
              700: "#74dcae",
              800: "#a8ebcd",
              900: "#d6f6e6",
              DEFAULT: "#1fb472",
              foreground: "#04190f"
            },
            default: {
              50: "#151b16",
              100: "#1d251e",
              200: "#2a332b",
              300: "#3a453b",
              400: "#5c6a5c",
              500: "#7e8d7d",
              600: "#9aa899",
              700: "#b9c4b8",
              800: "#d6ddd4",
              900: "#eef2ec",
              DEFAULT: "#2a332b",
              foreground: "#e7ece4"
            }
          }
        }
      }
    })
  ]
};

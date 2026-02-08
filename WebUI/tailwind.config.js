/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: { page: "#BDB7B2", shell: "#C9C0BC", surface: "#EBDFD8", surface2: "#F1EBE6", elevated: "#FFFFFF" },
        text: { primary: "#2A2723", secondary: "#8F8C89", muted: "#C2C0BE", inverse: "#F9F7F5" },
        border: { DEFAULT: "#E1D4CD", subtle: "#EFE4DE" },
        accent: { DEFAULT: "#E65E2A", hover: "#D95525", soft: "#EFD6C5" },
        success: { DEFAULT: "#2F9A57", soft: "#C8EAC6" },
        warning: { DEFAULT: "#D6A33A", soft: "#FFE08C" },
        danger: { DEFAULT: "#E05A5A", soft: "#F3C8C4" },
        info: { DEFAULT: "#71A0E3", soft: "#C7D4F9" },
        sidebar: "#060606",
      },
      fontFamily: { sans: ["Poppins", "Inter", "system-ui", "sans-serif"] },
      borderRadius: { sm: "12px", md: "14px", lg: "16px", xl: "32px", "2xl": "40px", "3xl": "56px", pill: "9999px" },
      boxShadow: {
        card: "0 10px 30px rgba(0,0,0,0.06), 0 1px 0 rgba(0,0,0,0.03)",
        pill: "0 12px 28px rgba(0,0,0,0.08)",
        shell: "0 24px 60px rgba(0,0,0,0.18)",
      },
    },
  },
  plugins: [],
}

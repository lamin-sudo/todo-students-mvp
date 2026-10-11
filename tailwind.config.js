/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Segoe UI"', 'Tahoma', 'system-ui', 'sans-serif'],
      },
      colors: {
        // matches the MELLORA-era brand background used across the user's apps
        surface: { DEFAULT: '#0C0315', soft: '#160A24', line: '#2A1740' },
      },
      keyframes: {
        'fade-up': { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'none' } },
      },
      animation: { 'fade-up': 'fade-up .18s ease-out' },
    },
  },
  plugins: [],
};

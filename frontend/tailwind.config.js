/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#f3efe4',
        card: '#fffdf8',
        ink: '#1a1814',
        muted: '#5e584e',
        line: '#e3d9c6',
        rail: '#1c2822',
        copper: '#9a4d24',
        moss: '#1f6b4a',
        tide: '#1e4d6b',
        warn: '#8a5a00',
        bad: '#9f2d2d',
      },
      fontFamily: {
        sans: ['"Avenir Next"', '"Segoe UI"', 'sans-serif'],
        serif: ['Palatino', '"Palatino Linotype"', '"Iowan Old Style"', 'Georgia', 'serif'],
      },
      boxShadow: {
        card: '0 1px 0 rgba(28, 24, 20, 0.04), 0 12px 32px rgba(28, 24, 20, 0.05)',
      },
    },
  },
  plugins: [],
};

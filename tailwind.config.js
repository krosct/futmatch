/** Configuração do Tailwind (CSS compilado e servido localmente em static/css/tailwind.css).
 *  Regenerar após mudar classes ou tema:  npx tailwindcss@3.4.19 -c tailwind.config.js -i static/css/tailwind.input.css -o static/css/tailwind.css --minify
 */
module.exports = {
  content: ['./static/index.html', './static/app.js', './static/audio.js', './static/audit.js'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', 'sans-serif'],
      },
      colors: {
        pitch: '#080c14',
        surface: '#111827',
        card: '#162032',
        cardLight: '#1e293b',
        borderLight: '#26354a',
        neon: {
          green: '#10b981',
          emerald: '#059669',
          accent: '#00f59b',
          glow: '#10b98133',
        },
      },
    },
  },
  plugins: [],
};

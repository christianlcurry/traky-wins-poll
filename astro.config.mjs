import { defineConfig } from 'astro/config';

// Served from GitHub Pages at https://christianlcurry.github.io/traky-wins-poll/
export default defineConfig({
  site: 'https://christianlcurry.github.io',
  base: '/traky-wins-poll',
  output: 'static',
});

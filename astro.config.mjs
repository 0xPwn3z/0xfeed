// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://0xPwn3z.github.io',
  base: '/0xfeed',
  output: 'static',
  vite: {
    plugins: [tailwindcss()]
  }
});
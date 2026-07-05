import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://church.yunfei-song.com',
  // Every route renders per-user (session, language); server output means a
  // forgotten `prerender = false` can never leak one user's page to another.
  output: 'server',
  adapter: cloudflare(),
  vite: {
    plugins: [tailwindcss()],
    // Lets a Docker-hosted headless browser reach astro dev/preview for visual checks.
    server: { allowedHosts: ['host.docker.internal'] },
    preview: { allowedHosts: ['host.docker.internal'] },
  },
});

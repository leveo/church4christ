import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { resolveLocalPersistence } from './scripts/setup/persistence.mjs';

const persistTo = resolveLocalPersistence(process.cwd(), process.env);

export default defineConfig({
  site: 'https://church.yunfei-song.com',
  // Every route renders per-user (session, language); server output means a
  // forgotten `prerender = false` can never leak one user's page to another.
  output: 'server',
  adapter: cloudflare({ persistState: { path: persistTo } }),
  // React exists for ONE admin island (the page builder, client:only) — public
  // pages stay zero-JS and the worker never server-renders React.
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    // Lets a Docker-hosted headless browser reach astro dev/preview for visual checks.
    server: { allowedHosts: ['host.docker.internal'] },
    preview: { allowedHosts: ['host.docker.internal'] },
  },
});

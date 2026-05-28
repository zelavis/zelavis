// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://www.zelavis.com',
  integrations: [
      starlight({
          title: 'Zelavis Docs',
          description: 'Composable backend platform for self-hostable app foundations.',
          favicon: '/favicon.svg',
          expressiveCode: false,
          head: [
              { tag: 'meta', attrs: { property: 'og:image', content: 'https://www.zelavis.com/brand/zelavis-social-card.png' } },
              { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
              { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
              { tag: 'meta', attrs: { property: 'og:image:alt', content: 'Zelavis logo and wordmark' } },
              { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://www.zelavis.com/brand/zelavis-social-card.png' } },
              { tag: 'meta', attrs: { name: 'twitter:image:alt', content: 'Zelavis logo and wordmark' } },
          ],
          social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/zelavis/zelavis' }],
          sidebar: [
              {
                  label: 'Getting Started',
                  items: [{ autogenerate: { directory: 'getting-started' } }],
              },
              {
                  label: 'Architecture',
                  items: [{ autogenerate: { directory: 'architecture' } }],
              },
              {
                  label: 'Packages',
                  items: [{ autogenerate: { directory: 'packages' } }],
              },
              {
                  label: 'CLI',
                  items: [{ autogenerate: { directory: 'cli' } }],
              },
              {
                  label: 'Adapters',
                  items: [{ autogenerate: { directory: 'adapters' } }],
              },
              {
                  label: 'Guides',
                  items: [{ autogenerate: { directory: 'guides' } }],
              },
              {
                  label: 'Reference',
                  items: [{ autogenerate: { directory: 'reference' } }],
              },
          ],
      }),
	],

});

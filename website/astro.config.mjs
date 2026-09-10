// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://zelavis.com',
  integrations: [
      starlight({
          title: 'Zelavis Docs',
          customCss: ['./src/styles/theme.css'],
          description: 'Zelavis is the App Platform. Plan, build, and manage apps together, from first ticket to production.',
          favicon: '/favicon.svg',
          head: [
              { tag: 'meta', attrs: { property: 'og:image', content: 'https://zelavis.com/brand/zelavis-social-card.png' } },
              { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
              { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
              { tag: 'meta', attrs: { property: 'og:image:alt', content: 'Zelavis logo and wordmark' } },
              { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://zelavis.com/brand/zelavis-social-card.png' } },
              { tag: 'meta', attrs: { name: 'twitter:image:alt', content: 'Zelavis logo and wordmark' } },
          ],
          social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/zelavis/zelavis' }],
          sidebar: [
              { label: 'Overview', link: '/docs' },
              {
                  label: 'Getting Started',
                  items: [{ autogenerate: { directory: 'getting-started' } }],
              },
              {
                  label: 'API',
                  items: [{ autogenerate: { directory: 'api' } }],
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

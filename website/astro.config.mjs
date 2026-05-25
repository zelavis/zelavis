// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  integrations: [
      starlight({
          title: 'Zelavis Docs',
          expressiveCode: false,
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

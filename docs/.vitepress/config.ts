import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Homeport',
  description: 'A self-hosted deploy platform for a Mac mini: git push, pm2, Caddy, Cloudflare Tunnel, Prometheus and Grafana.',
  // Served from https://<user>.github.io/homeport-management/ by the docs workflow.
  base: process.env.DOCS_BASE ?? '/homeport-management/',
  cleanUrls: true,
  // Local addresses in the guides are not pages.
  ignoreDeadLinks: [/^https?:\/\/(localhost|127\.0\.0\.1)/],
  lastUpdated: true,
  head: [['link', { rel: 'icon', href: `${process.env.DOCS_BASE ?? '/homeport-management/'}favicon.svg` }]],
  themeConfig: {
    logo: '/favicon.svg',
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Architecture', link: '/reference/architecture' },
      { text: 'Decisions', link: '/decisions/' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Why Homeport', link: '/guide/introduction' },
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Synology NAS and Linux', link: '/guide/synology' },
          { text: 'Deploying apps', link: '/guide/deploying-apps' },
          { text: 'Domains and tunnels', link: '/guide/domains-and-tunnels' },
          { text: 'Public dashboard', link: '/guide/public-dashboard' },
          { text: 'Monitoring and alerts', link: '/guide/monitoring' },
          { text: 'Security model', link: '/guide/security' },
          { text: 'Troubleshooting', link: '/guide/troubleshooting' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Architecture', link: '/reference/architecture' },
          { text: 'Configuration', link: '/reference/configuration' },
          { text: 'HTTP API', link: '/reference/api' },
          { text: 'Metrics', link: '/reference/metrics' },
          { text: 'Development', link: '/reference/development' },
        ],
      },
      {
        text: 'Design decisions',
        items: [
          { text: 'Overview', link: '/decisions/' },
          { text: '1. pm2 instead of containers', link: '/decisions/0001-pm2-not-containers' },
          { text: '2. Cloudflare Tunnel, no open ports', link: '/decisions/0002-cloudflare-tunnel' },
          { text: '3. One Caddy in front of everything', link: '/decisions/0003-single-caddy' },
          { text: '4. Generate config, validate, then swap', link: '/decisions/0004-generated-config' },
          { text: '5. A JSON file as the database', link: '/decisions/0005-json-store' },
          { text: '6. Dashboards and diagrams as code', link: '/decisions/0006-as-code' },
          { text: '7. Public dashboard, local-first trust', link: '/decisions/0007-public-dashboard' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/DarmawanWeb/homeport-management' }],
    editLink: { pattern: 'https://github.com/DarmawanWeb/homeport-management/edit/main/docs/:path', text: 'Edit this page' },
    search: { provider: 'local' },
    footer: { message: 'MIT licensed', copyright: 'Homeport' },
  },
});

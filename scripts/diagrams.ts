/**
 * Generates the architecture diagrams as `.drawio.svg` files.
 *
 * Each file is a normal SVG (so GitHub and the docs site render it) that also carries the
 * draw.io model in its `content` attribute, so it opens as an editable diagram in draw.io /
 * diagrams.net or the VS Code draw.io extension. One source, two renderings that agree.
 *
 *   npm run diagrams
 */
import fs from 'node:fs';
import path from 'node:path';

type Kind = 'external' | 'edge' | 'system' | 'app' | 'store' | 'monitor' | 'step' | 'decision' | 'good' | 'bad' | 'group' | 'note';
type Side = 'l' | 'r' | 't' | 'b';

interface Node {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub?: string;
  kind: Kind;
}
interface Edge {
  from: string;
  to: string;
  fs: Side;
  ts: Side;
  label?: string;
  dashed?: boolean;
  /** x (for horizontal-first) or y (for vertical-first) of the middle segment */
  mid?: number;
}
interface Diagram {
  file: string;
  title: string;
  width: number;
  height: number;
  nodes: Node[];
  edges: Edge[];
}

const C = {
  ink: '#14283b',
  soft: '#3e5266',
  faint: '#6c7d8c',
  paper: '#f2f4ef',
  rule: '#b9c2b6',
  sea: '#1d5c88',
  seaWash: '#dde9f1',
  buoy: '#e3a80b',
  buoyWash: '#fbf0cf',
  green: '#1e8a5a',
  greenWash: '#dcefe5',
  red: '#c2392f',
  redWash: '#f7e0dd',
};

const STYLE: Record<Kind, { fill: string; stroke: string; font: string; dashed?: boolean; radius: number; bold?: boolean }> = {
  external: { fill: '#ffffff', stroke: C.faint, font: C.ink, radius: 10, dashed: true },
  edge: { fill: C.seaWash, stroke: C.sea, font: C.ink, radius: 10 },
  system: { fill: '#ffffff', stroke: C.sea, font: C.ink, radius: 8, bold: true },
  app: { fill: C.greenWash, stroke: C.green, font: C.ink, radius: 8 },
  store: { fill: '#ffffff', stroke: C.faint, font: C.ink, radius: 4 },
  monitor: { fill: C.buoyWash, stroke: C.buoy, font: C.ink, radius: 8 },
  step: { fill: '#ffffff', stroke: C.sea, font: C.ink, radius: 8 },
  decision: { fill: C.buoyWash, stroke: C.buoy, font: C.ink, radius: 8 },
  good: { fill: C.greenWash, stroke: C.green, font: C.ink, radius: 8 },
  bad: { fill: C.redWash, stroke: C.red, font: C.ink, radius: 8 },
  group: { fill: 'none', stroke: C.rule, font: C.soft, radius: 14, dashed: true },
  note: { fill: 'none', stroke: 'none', font: C.faint, radius: 0 },
};

const FONT = 'Barlow, Helvetica Neue, Arial, sans-serif';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- geometry

function anchor(n: Node, s: Side): [number, number] {
  if (s === 'l') return [n.x, n.y + n.h / 2];
  if (s === 'r') return [n.x + n.w, n.y + n.h / 2];
  if (s === 't') return [n.x + n.w / 2, n.y];
  return [n.x + n.w / 2, n.y + n.h];
}

const horizontal = (s: Side) => s === 'l' || s === 'r';

/** Orthogonal route with explicit bends; the same bends are given to draw.io as waypoints. */
function route(e: Edge, a: Node, b: Node): { pts: [number, number][]; bends: [number, number][] } {
  const p1 = anchor(a, e.fs);
  const p2 = anchor(b, e.ts);
  let bends: [number, number][] = [];
  if (horizontal(e.fs) && horizontal(e.ts)) {
    if (p1[1] !== p2[1]) {
      const mx = e.mid ?? (p1[0] + p2[0]) / 2;
      bends = [
        [mx, p1[1]],
        [mx, p2[1]],
      ];
    }
  } else if (!horizontal(e.fs) && !horizontal(e.ts)) {
    if (p1[0] !== p2[0]) {
      const my = e.mid ?? (p1[1] + p2[1]) / 2;
      bends = [
        [p1[0], my],
        [p2[0], my],
      ];
    }
  } else if (horizontal(e.fs)) {
    bends = [[p2[0], p1[1]]];
  } else {
    bends = [[p1[0], p2[1]]];
  }
  return { pts: [p1, ...bends, p2], bends };
}

const SIDE_XY: Record<Side, [number, number]> = { l: [0, 0.5], r: [1, 0.5], t: [0.5, 0], b: [0.5, 1] };

// ---------------------------------------------------------------- draw.io model

function drawioXml(d: Diagram): string {
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  for (const n of d.nodes) {
    const st = STYLE[n.kind];
    const label = n.sub
      ? `<b>${esc(n.label)}</b><br><font style="font-size:11px" color="${C.soft}">${esc(n.sub)}</font>`
      : `<b>${esc(n.label)}</b>`;
    const style = [
      'rounded=1',
      `arcSize=${n.kind === 'group' ? 4 : 12}`,
      'whiteSpace=wrap',
      'html=1',
      `fillColor=${st.fill}`,
      `strokeColor=${st.stroke}`,
      `fontColor=${st.font}`,
      'fontFamily=Barlow',
      'fontSize=13',
      st.dashed ? 'dashed=1' : '',
      n.kind === 'group' ? 'verticalAlign=top;align=left;spacingLeft=14;spacingTop=8;container=0' : '',
      n.kind === 'note' ? 'align=left' : '',
    ]
      .filter(Boolean)
      .join(';');
    cells.push(
      `<mxCell id="${n.id}" value="${esc(label)}" style="${esc(style)};" vertex="1" parent="1"><mxGeometry x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" as="geometry"/></mxCell>`,
    );
  }
  d.edges.forEach((e, i) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) throw new Error(`${d.file}: edge ${e.from} → ${e.to} references a missing node`);
    const { bends } = route(e, a, b);
    const [ex, ey] = SIDE_XY[e.fs];
    const [nx, ny] = SIDE_XY[e.ts];
    const style = [
      'edgeStyle=orthogonalEdgeStyle',
      'rounded=1',
      'html=1',
      `strokeColor=${C.soft}`,
      `fontColor=${C.soft}`,
      'fontFamily=Barlow',
      'fontSize=11',
      'endArrow=block',
      'endFill=1',
      `exitX=${ex};exitY=${ey};exitDx=0;exitDy=0`,
      `entryX=${nx};entryY=${ny};entryDx=0;entryDy=0`,
      e.dashed ? 'dashed=1' : '',
      'labelBackgroundColor=#ffffff',
    ]
      .filter(Boolean)
      .join(';');
    const points = bends.length ? `<Array as="points">${bends.map(([x, y]) => `<mxPoint x="${x}" y="${y}"/>`).join('')}</Array>` : '';
    cells.push(
      `<mxCell id="e${i}" value="${esc(e.label ?? '')}" style="${esc(style)};" edge="1" parent="1" source="${e.from}" target="${e.to}"><mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell>`,
    );
  });
  const model = `<mxGraphModel dx="${d.width}" dy="${d.height}" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" background="${C.paper}" math="0" shadow="0"><root>${cells.join('')}</root></mxGraphModel>`;
  return `<mxfile host="homeport" agent="scripts/diagrams.ts" type="device"><diagram id="${path.basename(d.file, '.drawio.svg')}" name="${esc(d.title)}">${model}</diagram></mxfile>`;
}

// ---------------------------------------------------------------- SVG rendering

function wrap(text: string, maxChars: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (`${cur} ${w}`.trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = `${cur} ${w}`.trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

function svgNode(n: Node): string {
  const st = STYLE[n.kind];
  const out: string[] = [];
  if (n.kind !== 'note') {
    out.push(
      `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${st.radius}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="${n.kind === 'group' ? 1.2 : 1.5}"${st.dashed ? ' stroke-dasharray="6 4"' : ''}/>`,
    );
  }
  if (n.kind === 'group') {
    out.push(
      `<text x="${n.x + 14}" y="${n.y + 24}" font-family="${FONT}" font-size="14" font-weight="600" fill="${st.font}">${esc(n.label)}</text>`,
    );
    if (n.sub)
      out.push(`<text x="${n.x + 14}" y="${n.y + 42}" font-family="${FONT}" font-size="11.5" fill="${C.faint}">${esc(n.sub)}</text>`);
    return out.join('');
  }
  const chars = Math.max(10, Math.floor(n.w / 6.6));
  const subLines = n.sub ? wrap(n.sub, chars) : [];
  const align = n.kind === 'note' ? 'start' : 'middle';
  const tx = n.kind === 'note' ? n.x : n.x + n.w / 2;
  const total = 17 + subLines.length * 15;
  let y = n.y + n.h / 2 - total / 2 + 13;
  out.push(
    `<text x="${tx}" y="${y}" text-anchor="${align}" font-family="${FONT}" font-size="14" font-weight="600" fill="${st.font}">${esc(n.label)}</text>`,
  );
  for (const l of subLines) {
    y += 15;
    out.push(`<text x="${tx}" y="${y}" text-anchor="${align}" font-family="${FONT}" font-size="11.5" fill="${C.soft}">${esc(l)}</text>`);
  }
  return out.join('');
}

function svgEdge(e: Edge, a: Node, b: Node): string {
  const { pts } = route(e, a, b);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
  const out = [
    `<path d="${d}" fill="none" stroke="${C.soft}" stroke-width="1.4"${e.dashed ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#arrow)"/>`,
  ];
  if (e.label) {
    // label on the longest segment
    let best = 0;
    let bestLen = -1;
    for (let i = 0; i < pts.length - 1; i++) {
      const len = Math.abs(pts[i + 1]![0] - pts[i]![0]) + Math.abs(pts[i + 1]![1] - pts[i]![1]);
      if (len > bestLen) {
        bestLen = len;
        best = i;
      }
    }
    const [x1, y1] = pts[best]!;
    const [x2, y2] = pts[best + 1]!;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const w = e.label.length * 6.1 + 10;
    out.push(`<rect x="${mx - w / 2}" y="${my - 9}" width="${w}" height="18" rx="4" fill="${C.paper}"/>`);
    out.push(
      `<text x="${mx}" y="${my + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${C.soft}">${esc(e.label)}</text>`,
    );
  }
  return out.join('');
}

function render(d: Diagram): string {
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const groups = d.nodes.filter((n) => n.kind === 'group');
  const rest = d.nodes.filter((n) => n.kind !== 'group');
  const body = [
    `<rect width="${d.width}" height="${d.height}" fill="${C.paper}"/>`,
    ...groups.map(svgNode),
    ...d.edges.map((e) => svgEdge(e, byId.get(e.from)!, byId.get(e.to)!)),
    ...rest.map(svgNode),
  ].join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by scripts/diagrams.ts. Edit in draw.io, or change the script and run: npm run diagrams -->
<svg xmlns="http://www.w3.org/2000/svg" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}" content="${esc(drawioXml(d))}">
<title>${esc(d.title)}</title>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${C.soft}"/></marker></defs>
${body}
</svg>
`;
}

// ---------------------------------------------------------------- the diagrams

const architecture: Diagram = {
  file: 'architecture.drawio.svg',
  title: 'Homeport architecture',
  width: 1200,
  height: 650,
  nodes: [
    { id: 'visitors', x: 20, y: 120, w: 160, h: 64, label: 'Visitors', sub: 'HTTPS to shop.example.com', kind: 'external' },
    { id: 'github', x: 20, y: 250, w: 160, h: 64, label: 'GitHub', sub: 'POST /hooks/<app-id>', kind: 'external' },
    { id: 'cf', x: 230, y: 170, w: 160, h: 90, label: 'Cloudflare edge', sub: 'TLS, DNS, DDoS. No open ports at home.', kind: 'edge' },
    {
      id: 'mac',
      x: 420,
      y: 30,
      w: 760,
      h: 590,
      label: 'Mac mini',
      sub: 'everything below runs under pm2 and binds to 127.0.0.1',
      kind: 'group',
    },
    { id: 'cfd', x: 540, y: 180, w: 140, h: 70, label: 'cloudflared', sub: 'outbound tunnel', kind: 'system' },
    { id: 'caddy', x: 720, y: 180, w: 150, h: 70, label: 'Caddy :8080', sub: 'routes by Host header', kind: 'system' },
    { id: 'shop', x: 940, y: 90, w: 140, h: 50, label: 'shop :3001', kind: 'app' },
    { id: 'api', x: 940, y: 160, w: 140, h: 50, label: 'api :3002', kind: 'app' },
    { id: 'blog', x: 940, y: 230, w: 140, h: 50, label: 'blog :3003', kind: 'app' },
    { id: 'hooks', x: 940, y: 300, w: 140, h: 56, label: 'Webhooks :9000', sub: 'HMAC verified', kind: 'system' },
    { id: 'core', x: 700, y: 400, w: 190, h: 80, label: 'Homeport :7070', sub: 'deploy queue, config, dashboard', kind: 'system' },
    { id: 'repo', x: 460, y: 410, w: 150, h: 60, label: '~/apps/*', sub: 'git checkouts', kind: 'store' },
    { id: 'db', x: 460, y: 530, w: 150, h: 60, label: 'data/', sub: 'db.json, Caddyfile, logs', kind: 'store' },
    { id: 'prom', x: 990, y: 400, w: 175, h: 76, label: 'Prometheus :9090', sub: 'scrapes Homeport, Caddy, tunnel, host', kind: 'monitor' },
    { id: 'graf', x: 990, y: 520, w: 175, h: 60, label: 'Grafana :3300', sub: 'provisioned dashboards', kind: 'monitor' },
    { id: 'notify', x: 690, y: 530, w: 210, h: 60, label: 'Discord / Telegram', sub: 'deploys and alerts', kind: 'external' },
  ],
  edges: [
    { from: 'visitors', to: 'cf', fs: 'r', ts: 'l' },
    { from: 'github', to: 'cf', fs: 'r', ts: 'l' },
    { from: 'cfd', to: 'cf', fs: 'l', ts: 'r', label: 'QUIC, outbound' },
    { from: 'cfd', to: 'caddy', fs: 'r', ts: 'l' },
    { from: 'caddy', to: 'shop', fs: 'r', ts: 'l', mid: 905 },
    { from: 'caddy', to: 'api', fs: 'r', ts: 'l', mid: 905 },
    { from: 'caddy', to: 'blog', fs: 'r', ts: 'l', mid: 905 },
    { from: 'caddy', to: 'hooks', fs: 'r', ts: 'l', mid: 905 },
    { from: 'hooks', to: 'core', fs: 'b', ts: 't', label: 'queue deploy', mid: 380 },
    { from: 'core', to: 'repo', fs: 'l', ts: 'r', label: 'clone, build' },
    { from: 'core', to: 'db', fs: 'b', ts: 't', mid: 505 },
    { from: 'core', to: 'caddy', fs: 't', ts: 'b', label: 'reload', dashed: true, mid: 330 },
    { from: 'prom', to: 'core', fs: 'l', ts: 'r', label: '/metrics', dashed: true },
    { from: 'graf', to: 'prom', fs: 't', ts: 'b', dashed: true },
    { from: 'core', to: 'notify', fs: 'b', ts: 't' },
  ],
};

const pipeline: Diagram = {
  file: 'deploy-pipeline.drawio.svg',
  title: 'Deploy pipeline',
  width: 1180,
  height: 470,
  nodes: [
    { id: 'push', x: 30, y: 60, w: 140, h: 64, label: 'git push', sub: 'or poll, or button', kind: 'external' },
    { id: 'verify', x: 210, y: 60, w: 150, h: 64, label: 'Verify', sub: 'HMAC-SHA256, branch', kind: 'step' },
    { id: 'queue', x: 400, y: 60, w: 170, h: 64, label: 'Queue per app', sub: 'bursts collapse into one', kind: 'step' },
    { id: 'fetch', x: 610, y: 60, w: 150, h: 64, label: 'Fetch', sub: 'clone or fetch, reset --hard', kind: 'step' },
    { id: 'build', x: 800, y: 60, w: 160, h: 64, label: 'Install and build', sub: 'npm, pnpm, yarn or bun', kind: 'step' },
    { id: 'reload', x: 1000, y: 60, w: 150, h: 64, label: 'pm2 reload', sub: 'old process serves until ready', kind: 'step' },
    {
      id: 'health',
      x: 990,
      y: 190,
      w: 170,
      h: 74,
      label: 'Healthy?',
      sub: 'port answers, no crash loop, within timeout',
      kind: 'decision',
    },
    { id: 'live', x: 990, y: 340, w: 170, h: 64, label: 'Live', sub: 'mark as last good commit', kind: 'good' },
    { id: 'rollback', x: 700, y: 195, w: 200, h: 64, label: 'Roll back', sub: 'rebuild last good commit', kind: 'bad' },
    { id: 'notify', x: 700, y: 340, w: 200, h: 64, label: 'Notify', sub: 'Discord, Telegram, metrics', kind: 'step' },
  ],
  edges: [
    { from: 'push', to: 'verify', fs: 'r', ts: 'l' },
    { from: 'verify', to: 'queue', fs: 'r', ts: 'l' },
    { from: 'queue', to: 'fetch', fs: 'r', ts: 'l' },
    { from: 'fetch', to: 'build', fs: 'r', ts: 'l' },
    { from: 'build', to: 'reload', fs: 'r', ts: 'l' },
    { from: 'reload', to: 'health', fs: 'b', ts: 't' },
    { from: 'health', to: 'live', fs: 'b', ts: 't', label: 'yes' },
    { from: 'health', to: 'rollback', fs: 'l', ts: 'r', label: 'no' },
    { from: 'build', to: 'rollback', fs: 'b', ts: 't', label: 'fails', dashed: true },
    { from: 'rollback', to: 'notify', fs: 'b', ts: 't' },
    { from: 'live', to: 'notify', fs: 'l', ts: 'r' },
  ],
};

const monitoring: Diagram = {
  file: 'monitoring.drawio.svg',
  title: 'Metrics and alerts',
  width: 1060,
  height: 420,
  nodes: [
    { id: 'hp', x: 30, y: 40, w: 220, h: 70, label: 'Homeport exporter', sub: 'app up, crashes, deploys, webhooks, host', kind: 'system' },
    { id: 'caddy', x: 30, y: 130, w: 220, h: 64, label: 'Caddy', sub: 'requests, status codes, latency by host', kind: 'system' },
    { id: 'cfd', x: 30, y: 214, w: 220, h: 64, label: 'cloudflared', sub: 'edge connections, tunnel errors', kind: 'system' },
    { id: 'node', x: 30, y: 298, w: 220, h: 64, label: 'node_exporter', sub: 'CPU, disk I/O, network', kind: 'system' },
    {
      id: 'prom',
      x: 380,
      y: 160,
      w: 220,
      h: 90,
      label: 'Prometheus',
      sub: 'scrape every 15s, keep 30 days, evaluate 11 alert rules',
      kind: 'monitor',
    },
    { id: 'graf', x: 720, y: 60, w: 300, h: 64, label: 'Grafana', sub: 'history, deploy annotations', kind: 'monitor' },
    { id: 'ui', x: 720, y: 170, w: 300, h: 64, label: 'Homeport dashboard', sub: 'built-in charts over query_range', kind: 'system' },
    {
      id: 'alert',
      x: 720,
      y: 290,
      w: 300,
      h: 70,
      label: 'Alert forwarder',
      sub: 'firing and resolved alerts to Discord and Telegram',
      kind: 'bad',
    },
  ],
  edges: [
    { from: 'hp', to: 'prom', fs: 'r', ts: 'l', mid: 320 },
    { from: 'caddy', to: 'prom', fs: 'r', ts: 'l', mid: 320 },
    { from: 'cfd', to: 'prom', fs: 'r', ts: 'l', mid: 320 },
    { from: 'node', to: 'prom', fs: 'r', ts: 'l', mid: 320 },
    { from: 'prom', to: 'graf', fs: 'r', ts: 'l', mid: 660 },
    { from: 'prom', to: 'ui', fs: 'r', ts: 'l', mid: 660 },
    { from: 'prom', to: 'alert', fs: 'r', ts: 'l', mid: 660, label: '/api/v1/alerts' },
  ],
};

const out = path.resolve('docs/public/diagrams');
fs.mkdirSync(out, { recursive: true });
for (const d of [architecture, pipeline, monitoring]) {
  fs.writeFileSync(path.join(out, d.file), render(d));
  console.log(`wrote docs/public/diagrams/${d.file}`);
}

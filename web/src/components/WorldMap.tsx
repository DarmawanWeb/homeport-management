import { geoEqualEarth, geoPath } from 'd3-geo';
import countries from 'i18n-iso-countries';
import { useMemo, useState } from 'react';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import world from 'world-atlas/countries-110m.json';
import { countryName, fmtCount } from '../lib/format';

interface Props {
  /** Visitors per ISO alpha-2 country. */
  values: { code: string; visitors: number }[];
  /** Optional city dots from Cloudflare's visitor location headers. */
  cities?: { name: string; country: string; lat: number | null; lon: number | null; visitors: number }[];
}

const W = 960;
const H = 470;

/** Choropleth of visitors by country, drawn with d3-geo from Natural Earth (110m) shapes. */
export default function WorldMap({ values, cities = [] }: Props) {
  const [hover, setHover] = useState<{ name: string; value: number; x: number; y: number } | null>(null);

  const { shapes, path, projection } = useMemo(() => {
    const topo = world as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
    const fc = feature(topo, topo.objects.countries);
    const proj = geoEqualEarth().fitExtent(
      [
        [4, 4],
        [W - 4, H - 4],
      ],
      fc,
    );
    // Antarctica takes a lot of room and gets no visitors.
    return { shapes: fc.features.filter((f) => f.id !== '010'), path: geoPath(proj), projection: proj };
  }, []);

  const byNumeric = useMemo(() => {
    const m = new Map<string, { code: string; visitors: number }>();
    for (const v of values) {
      const num = countries.alpha2ToNumeric(v.code);
      if (num) m.set(num, v);
    }
    return m;
  }, [values]);

  const max = Math.max(1, ...values.map((v) => v.visitors));
  const maxCity = Math.max(1, ...cities.map((c) => c.visitors));
  // Square-root scale so one busy country does not wash out the rest.
  const shade = (v: number) => 0.18 + 0.82 * Math.sqrt(v / max);

  return (
    <div className="worldmap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Visitors by country" onMouseLeave={() => setHover(null)}>
        <title>Visitors by country</title>
        {shapes.map((f) => {
          const hit = byNumeric.get(String(f.id));
          const d = path(f) ?? '';
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: hover only adds a tooltip; the same numbers are in the country list
            <path
              key={String(f.id ?? f.properties?.name)}
              d={d}
              className={hit ? 'land on' : 'land'}
              style={hit ? { fillOpacity: shade(hit.visitors) } : undefined}
              onMouseMove={(e) => {
                const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                setHover({
                  name: hit ? countryName(hit.code) : (f.properties?.name ?? ''),
                  value: hit?.visitors ?? 0,
                  x: ((e.clientX - r.left) / r.width) * 100,
                  y: ((e.clientY - r.top) / r.height) * 100,
                });
              }}
            />
          );
        })}
        {cities
          .filter((c) => c.lat != null && c.lon != null)
          .map((c) => {
            const p = projection([c.lon!, c.lat!]);
            if (!p) return null;
            return (
              <circle key={`${c.name}-${c.country}`} cx={p[0]} cy={p[1]} r={3 + 9 * Math.sqrt(c.visitors / maxCity)} className="city">
                <title>
                  {c.name}, {countryName(c.country)}: {c.visitors} visitor{c.visitors === 1 ? '' : 's'}
                </title>
              </circle>
            );
          })}
      </svg>
      {hover && (
        <div className="map-tip" style={{ left: `${hover.x}%`, top: `${hover.y}%` }}>
          <strong>{hover.name}</strong>
          <span>{hover.value ? `${fmtCount(hover.value)} visitor${hover.value === 1 ? '' : 's'}` : 'No visitors'}</span>
        </div>
      )}
    </div>
  );
}

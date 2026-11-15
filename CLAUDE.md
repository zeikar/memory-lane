# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is

Memory Lane: a browser game. Pick a place, draw the streets within 500 m of it from memory on a
1 km sheet, then reveal the real OpenStreetMap street network over the drawing and get scored.
Live at https://zeikar.dev/memory-lane/. It is one of the projects on the owner's site
(zeikar/zeikar.github.io), which is a separate repo with its own conventions.

Static site: Vite + TypeScript, no framework, no backend. Canvas for the sheet, plain DOM for the
rest.

## Commands

- `npm run dev`: dev server at http://localhost:5173/memory-lane/ (the base path is `/memory-lane/`)
- `npm test`: unit tests (Vitest, `src/**/*.test.ts`)
- `npm run calibrate`: scoring checks against live map data; run after touching scoring. Needs the
  network, so it isn't in `npm test` or CI
- `npm run build`: typecheck, then production build to `dist/`

## Layout

- `src/geo.ts`: local projection (metres, x east, y north, around the play area's centre),
  clipping, distances. `HALF` = 500 m.
- `src/osm.ts`: map data (vector tiles to `MapData`), landmarks, place search (Nominatim).
- `src/score.ts`: scoring and the verdict line. Read [docs/scoring.md](docs/scoring.md) before
  changing it.
- `src/sheet.ts`: everything drawn on the canvas, for the drawing screen and the reveal. `INK`
  holds the canvas colours.
- `src/card.ts`: the 1200×675 share image.
- `src/main.ts`: screens (start, loading, draw, result), pointer input, undo, reveal animation.
- `src/style.css`: page styles. Colour tokens on `:root`; the legend colours mirror `INK`.

## Non-obvious decisions

### Map data is OpenFreeMap vector tiles, not Overpass

The first version queried Overpass, and a single request sat in its queue for about 36 s. The
tiles (OpenMapTiles schema, z14, the deepest level) are CDN-cached and CORS-open, and the one to
four tiles a square needs load in under a second. The tile URL names the current planet build, so it
is read from the TileJSON at runtime (`tileTemplate`), never hard-coded.

Tiles repeat features in a buffer around their edges. Lines are clipped to their own tile's
bounds before the play square, or streets near a seam would be counted twice. POIs are kept only
inside their own tile. Polygons aren't clipped: they are opaque fills, so overlap doesn't show.

Street names live on separate lines (`transportation_name`), so they are matched to the network
(`transportation`) by geometry, not id. Places astride the antimeridian are handled: longitudes
wrap in `bboxAround`, `tilesFor` and `makeProjection`.

The footer attribution (OpenStreetMap, OpenFreeMap, OpenMapTiles) is required; keep it.

### What counts as a street

Roads from residential up to motorway, plus pedestrian streets. Service roads, footways and paths
are out (`roadClass` in `osm.ts`); tunnels are dropped by the `brunnel` check in `collectTile`.
Street names come on separate lines without `brunnel`, so `score.ts` counts a name only where it
lies on the network, or underpass names would pass as streets. Recall asks only for key streets
(through roads and long named streets, never motorways or ramps); docs/scoring.md has the rule
and why.

### Help levels

`Mode` is `landmarks` | `roads` | `buildings`. Every level shows the landmarks, parks, woods, water
and railways.

- Landmarks: up to 12, from an allowlist of POI class/subclass pairs (`LANDMARK_TIERS`), plus
  named mountain tops. The classes alone are too broad: `hospital` includes clinics, `library`
  bookshops, `town_hall` community centres. `pickLandmarks` sorts by tier, then the tiles' `rank`,
  takes at most 3 per class, keeps them 120 m apart (stations 250 m), and keeps all but stations
  off the pin, since a station is often what the player searched for.
- Parks and woods come from `landcover` (grass, wood). The `park` layer is protected areas and
  historic districts, which painted all of Prague's old town green.

`roads` adds the major roads (secondary and up) as dashed hints, which are left out of the score,
names and all. `buildings` adds building footprints. There used to be a "Blank sheet" level with only
the pin; a player found it impossible, which is why landmarks are on every level.

### Scoring has been attacked, and hardened against it

The matching constants in `score.ts` (`TOLERANCE`, `MIN_ALIGNMENT`, `RETRACE`, `SMOOTHING`, `STEP`)
each close a specific exploit. docs/scoring.md lists each one with numbers. A change that looks
like a harmless loosening (a wider tolerance, a finer printed grid, dropping the dedupe) has
reopened one before. The key-street constants (`NAME_MATCH`, `KEY_NAME_LENGTH`, `SIDE_STREET`,
`MIN_KEY_SHARE`, `MIN_STREET_LENGTH`) are fairness tuning and fine to adjust; re-run calibrate
after, since `MIN_KEY_SHARE` also stops one street from being the whole game.

### Privacy

"Use my location" rounds the position to 3 decimals (about 100 m) before using it. The share image
names the district (`areaLabel`, never a street), but its map still shows the area around the pin,
and the start screen's fine print says so. If data handling changes, keep that fine print and the
README's Data section accurate.

### Input and accessibility

- One pointer draws at a time (`pointerId` in main.ts); a second finger or a palm is ignored.
- Undo, Clear and Reveal are ignored mid-stroke.
- The count-up score isn't a live region. The final result is announced once through `#announce`,
  and focus moves with `preventScroll: true`, or phones scroll the sheet away during the reveal.
- `prefers-reduced-motion` skips the reveal animation.

### Look

A green self-healing cutting mat (page background) under an engineering pad (the sheet): pale
green grid every 100 m, graphite strokes, one tomato red for the pin, score and primary buttons.
The reveal colours are blue (remembered), grey (forgotten; faint for non-key alleys) and orange
highlighter (imaginary). The UI copy is English; place and street names come out in the local
language. In page copy, keep the tone plain and a little dry, like the verdict lines in `score.ts`.

## Verifying a change

- Unit tests and `npm run build` for everything. `npm run calibrate` for scoring or street rules.
- UI: run the dev server and drive it. If the Playwright MCP browser is busy in another session, a
  Node script using Playwright's `chromium` works the same way. In a page served by the dev
  server, `await import('/memory-lane/src/osm.ts')` gives live `fetchMap` for ad-hoc checks.
- Check phone width (390 px) as well as desktop: the toolbar wraps, and the result panel moves
  under the sheet.

## Deploy

Push to `main`: `.github/workflows/deploy.yml` runs the tests, builds, and publishes to GitHub
Pages (source: GitHub Actions). The custom domain comes from the owner's user site, so there is no
CNAME here.

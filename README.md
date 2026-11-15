# Memory Lane

Draw the streets of a place you know from memory, then lay the real map over your drawing.

Pick a place, and you get a blank 1 km square with a pin in the middle. Draw every street you can
remember within 500 m of it. Reveal the real map and see which streets you remembered, which you
forgot, and which ones exist only in your head.

Play it at https://zeikar.dev/memory-lane/.

## How much help

- **Blank sheet**: only the pin, a scale bar and north.
- **Main roads**: big roads, rivers and railways are printed. They are left out of the score.
- **Buildings**: main roads plus every building footprint, so the streets show as gaps.

## Scoring

Real streets and your lines are cut into short pieces. A real street piece counts as remembered when
one of your lines runs within 18 m of it, in roughly the same direction (within 30°). Direction
matters: a line that only crosses a street doesn't remember it. Your line's direction is read over
about 15 m either side, so a shaky hand still counts.

- **Streets you remembered**: share of the real street length you drew.
- **Your lines on real streets**: share of your drawn length that lies on a real street.
- **Score**: the harmonic mean of the two, out of 100. Drawing lines everywhere drags the second
  number down, and going over the same line again counts it once.

Streets are OpenStreetMap roads from residential up to motorways, plus pedestrian streets. Service
roads, footways and tunnels are left out.

## Data

The map comes from [OpenFreeMap](https://openfreemap.org)'s vector tiles ([OpenMapTiles](https://openmaptiles.org/)
schema, zoom 14), built from [OpenStreetMap](https://www.openstreetmap.org/copyright) data. Place
search uses [Nominatim](https://nominatim.org), and the font comes from Google Fonts. There is no
server of its own: scoring runs in the browser, and nothing you draw leaves your device unless you
save the image. "Use my location" rounds your position to about 100 m before using it.

## Development

```sh
npm install
npm run dev     # http://localhost:5173/memory-lane/
npm test
npm run build
```

## License

MIT

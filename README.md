# Memory Lane

Draw the streets of a place you know from memory, then lay the real map over your drawing.

Pick a place, and you get a 1 km square with a pin in the middle and a few landmarks marked. Draw
the streets you remember within 500 m of it. Reveal the real map and see which streets you
remembered, which you forgot, and which ones exist only in your head.

Play it at https://zeikar.dev/memory-lane/.

## How much help

Every level marks up to 12 landmarks (stations first, then universities, museums, hilltops,
hospitals, parks, schools and so on), plus parks, woods, rivers and railways.

- **Landmarks**: just those.
- **Main roads**: plus the big roads (secondary and up), which are left out of the score.
- **Side streets**: plus every street you aren't asked for, so you draw the through roads between
  them. The printed streets are left out of the score.
- **Buildings**: main roads plus every building footprint, so the streets show as gaps.

## Scoring

You're asked for the key streets: through roads (tertiary up to trunk), and streets with a name
that runs at least 300 m through the square. Korean numbered side streets (와우산로21길 and the
like) are alleys, not key streets, and motorways and their ramps aren't asked for. Where that
leaves too little, the next longest named streets are asked for too. Alleys you draw still count
as real streets; alleys you leave out cost nothing.

Real streets and your lines are cut into short pieces. A real street piece counts as remembered when
one of your lines runs within 18 m of it, in roughly the same direction (within 30°). For the key
streets, a line further off still earns part of it, less the further it is, down to nothing at
40 m. Direction matters: a line that only crosses a street doesn't remember it. Your line's
direction is read over about 15 m either side, so a shaky hand still counts.

- **Streets you remembered**: share of the key street length you drew (partly, for lines further
  off).
- **Your lines on real streets**: share of your drawn length that lies on a real street (likewise).
- **Score**: the harmonic mean of the two, out of 100. Drawing lines everywhere drags the second
  number down, and going over the same line again counts it once.

[docs/scoring.md](docs/scoring.md) has the full rules and the reasons for each.

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
npm run calibrate  # scoring checks against live map data
npm run build
```

## License

MIT

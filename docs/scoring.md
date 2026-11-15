# Scoring

How a drawing is scored, why each rule is there, and the attacks each one closes. Every rule
below was added because a simpler version was either unfair to honest players or easy to game,
so check this list before loosening one. After any change to `src/score.ts`, or to what
`src/osm.ts` counts as a street, run `npm test` and `npm run calibrate`.

## The pipeline

1. **Pieces.** Real streets and drawn lines are cut into pieces of at most 8 m (`STEP`).
2. **Direction.** A real piece's direction is its own. A drawn piece's direction is the chord
   across 15 m of the line on either side (`SMOOTHING`). Hand tremor at the pointer's sampling
   rate points individual segments every which way.
3. **Hint roads out first.** On the Main roads and Buildings levels, the major roads are printed.
   Any drawn piece aligned within 18 m of one is dropped before anything else. A real street piece
   in the same position is dropped from the recall total, since it can't be drawn without
   tracing the printed road. On the Side streets level the same happens with every street that
   isn't key (worked out first, as on the Landmarks level), except motorways and ramps: printed,
   an expressway hid the key road beneath it, 22% of Shibuya's key length. That leaves the key
   streets in play, plus the motorways, unasked. If it would leave under 600 m of key street,
   nothing is printed and the level plays like Landmarks.
4. **Retrace dedupe.** A drawn piece aligned within 12 m (`RETRACE`) of a piece already counted
   is skipped, for precision and for recall. The current stroke's own pieces join the counted
   set once the pen has moved `RETRACE + STEP` (20 m) past them, so neighbouring pieces of one
   line don't cancel each other.
5. **Matching.** Two pieces match when they are within 30° of each other (`MIN_ALIGNMENT`) and
   close. Within 18 m (`TOLERANCE`) a match earns full credit. For key streets, credit then fades
   linearly to nothing at 40 m (`FADE`); for alleys it stops at 18 m. A piece earning at least half
   shows as remembered (or as a real street, for a drawn piece) on the reveal.
6. **Recall** is the key street length, weighted by the credit of the nearest kept drawn piece, as
   a share of all key street length. **Precision** is the kept drawn length, weighted by its credit
   against the nearest real street, key or not, as a share of all kept drawn length.
7. **Score** is the harmonic mean of the two, × 100, rounded.

## Key streets

Recall asks only for key streets. People don't carry every alley in their head, and in a dense
city the alleys are most of the length: Seogyo-dong has about 21.5 km of streets in its square,
and most of it is alleys.

A real street piece is key when either:

- its road class is trunk, primary, secondary or tertiary, and it isn't a ramp (`Road.key`, set in
  `osm.ts`), or
- a named line of a key name runs within 8 m of it and within 30° of its direction (`NAME_MATCH`,
  `MIN_ALIGNMENT`). A key name is one with at least 300 m of named line inside the square
  (`KEY_NAME_LENGTH`) that isn't a Korean numbered side street (`SIDE_STREET`, e.g. 와우산로21길).

Names come from the tiles' `transportation_name` layer, which is separate from the street network
in `transportation`, so a name is attached by geometry rather than by id. The rule exists because
Seoul names nearly every alley (20.2 km of the 21.5 km in Seogyo-dong is named), so "has a name"
alone filtered nothing.

What a key name can't be:

- **An underpass.** The name layer has no tunnel flag, so only the parts of a named line lying on
  the network (within 8 m, aligned) count towards its 300 m and towards the street list. A name
  line sits on its own street's geometry, so a piece closer to a tunnel (`MapData.tunnels`) than to
  any surface street is the tunnel's, even with a surface street right above it. 여의도지하차도
  used to be asked for, and listed at 22% when every surface street was drawn.
- **A motorway or ramp** (`Road.motorway`). On the network both are flagged; name lines carry no
  ramp flag in these tiles, so only motorway names are. Nobody draws an interchange from memory;
  in Yeouido, expressways and ramps were most of the asked-for length. A motorway or ramp piece
  isn't key even beside a key name. They still count as real for precision.
- **A printed road**, on the levels that print the major roads. Its minor stretches aren't asked
  for either.

Key streets, leaving out the longest key name, should be at least 20% of the streets in play
(`MIN_KEY_SHARE`) and at least as long as that name. Below that, the next longest names, numbered
side streets included, are asked for as well until they are. With the main roads printed, Gangnam
had 990 m key out of 11.6 km, and drawing that one street scored 100; Jamsil had 53% key, but
잠실로 was 70% of it and alone scored 82 (69 now, against calibrate's limit of 70, so live map
edits there can trip it). Asking for every street instead closed that too, but put Hongdae, Koenji, Gangnam and Mapo back
at 14–26 km asked on the default level. A place whose streets have no names to add keeps what it
has.

Alleys aren't wasted effort: a drawn alley counts as a real street for precision. If the key
streets add up to less than 600 m (`MIN_STREET_LENGTH`), recall would be all or nothing, so every
street is asked for. The start screen turns a place down below the same length of scoreable street.

Grid-plan districts are mostly key, and that's accepted: Midtown Manhattan is 92% key, because
every block-long cross street passes 300 m. A grid is also the easiest layout to remember.

## Partial credit past 18 m

Placing a street from memory within 18 m is hard: 18 m is under 7 px on a phone-width sheet. With
an all-or-nothing 18 m, drawing every key street with the right shape but 25 m off scored 18 on
average, below tracing the printed 100 m grid (30). The fade to 40 m makes that 72–95.

It is limited to key streets because alleys are what a uniform grid of lines lands near: a fade
on every street raised the 100 m grid to 49 on average, against 41 with the fade on key streets
only. When every street is asked for (the 600 m fallback), nothing fades. Giving each drawn piece
fade credit only for the one street it is nearest to was tried, and changed the grid by about one
point, so it isn't there.

The price is a higher floor for drawing lines everywhere (see below), traded for a game a player
can score on.

## Attacks and the rule that closes each

| Attack | Before the fix | Rule |
|---|---|---|
| One straight line through a dense grid of alleys earns a little from every alley it crosses | crossings credited ~50 m each | 30° direction match |
| Shaky hand: tremor makes segments point anywhere, so honest lines missed | precision 0.75 on a careful trace | 15 m direction smoothing (simplifying the line first didn't work: it kept the zigzag) |
| Trace the printed sheet grid | 54–74 with a 50 m grid and 25 m tolerance | grid printed every 100 m, tolerance 18 m, fade on key streets only: now 1–50 (52 in Koenji) |
| Retrace one known street many times | 54 → 83 | retrace dedupe |
| Dedupe by grid cell instead of geometry | precision swung 0.24–0.76 with pointer sampling density | geometric dedupe on real length |
| Hedge: draw a guess plus spare lines ±11 m either side | 69 → 81 | recall only from kept (deduped) pieces |
| Zigzag shading along a street | precision 0.73 instead of 0.50 | retrace delay cut from 36 m to `RETRACE + STEP` |
| Trace the printed main roads, crediting a parallel side street too | small leak | hint pieces dropped before indexing |

Known and accepted: hand-drawing your own 50 m grid scores 30–71 (Seogyo-dong 30, Le Marais 52,
Shibuya 52, Midtown 63, Koenji 71; Yeouido 3), up from 24–61 before the fade. Drawing lines
everywhere does cost precision, but a uniform grid over a dense, grid-like district genuinely lies
near many streets.

## Calibration

`npm run calibrate` (`scripts/calibrate.test.ts`) fetches seven live places (Seogyo-dong, Shibuya,
Le Marais, Midtown Manhattan, Yeouido for its expressways and underpasses, Gangnam for its
numbered side streets, and Jamsil for one street dominating a sparse square) and checks:

- a careful full drawing (every street, 8 m to one side with ±3 m jitter) scores 95 or more;
- the west half of the sheet scores between 50 and 90 (not every other street: that draws one side
  of each dual carriageway, which credits the other side too);
- drawing only the key streets scores 95 or more;
- no motorway or ramp piece is key, and no listed street runs mostly in a tunnel;
- drawing any one of the ten longest asked-for streets scores 70 or less, with nothing, the main
  roads or the side streets printed;
- drawing only the streets that aren't key gives recall 0.45 or less and precision 0.95 or more.
  Not 0, because a side lane or alley beside a key street earns part of it, as any line that close
  would, and so does an expressway built over one (Shibuya's Shuto line over Route 246; Shibuya is
  the highest, at 0.34). If every street became key, this fails;
- every key street drawn 25 m to one side scores 60 or more, with nothing, the main roads or the
  side streets printed (72–95 now);
- tracing the 100 m sheet grid scores 55 or less (40 before the fade; Midtown is 50);
- tracing the printed main roads, or the printed side streets, scores 10 or less;
- printing the side streets drops at most 15% of key length (Shibuya is the highest, at 12%).

It needs the network, so it isn't in `npm test` or CI. Unit tests in `src/score.test.ts` pin each
rule above with synthetic streets.

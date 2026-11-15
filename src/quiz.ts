import type { NamedStreet, ScoreResult } from './score';

/** Streets asked in a round of the one-street-at-a-time level. */
export const QUESTIONS = 5;
/** Fewer named streets than this and there is no round to play. */
export const MIN_QUESTIONS = 3;
/**
 * A street that spans less than this inside the square, in metres, is too small to place by name.
 * Measured across its extent, not along its pieces, which count both sides of a dual carriageway.
 */
const MIN_SPAN = 200;
/** Questions are drawn from this many of the longest streets, so a replay can ask something else. */
const POOL = 8;

/** The diagonal of the box around a street's asked-for pieces, in metres. */
function span(s: NamedStreet): number {
  const xs = s.pieces.flatMap((p) => [p.a.x, p.b.x]);
  const ys = s.pieces.flatMap((p) => [p.a.y, p.b.y]);
  return xs.length ? Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) : 0;
}

/**
 * Picks the streets to ask: at random from the longest few, then longest first, since the long
 * streets are the ones people know and an easy start helps.
 */
export function pickQuestions(streets: NamedStreet[], random: () => number = Math.random): NamedStreet[] {
  const left = streets
    .filter((s) => span(s) >= MIN_SPAN)
    .sort((a, b) => b.length - a.length)
    .slice(0, POOL);
  const picked: NamedStreet[] = [];
  while (picked.length < QUESTIONS && left.length) picked.push(left.splice(Math.floor(random() * left.length), 1)[0]!);
  return picked.sort((a, b) => b.length - a.length);
}

/** The line under one checked street. Plain and a little dry, like the round's verdict. */
export function answerLine(r: ScoreResult, skipped: boolean): string {
  if (skipped) return 'Skipped.';
  if (r.score >= 85) return 'Spot on.';
  if (r.score >= 65) return 'Close, mostly.';
  if (r.score >= 40) return 'Roughly there.';
  if (r.score > 0) return 'Somewhere else entirely.';
  return 'Not that one.';
}

/** The line under the round's score: the full-map verdicts talk about alleys, which aren't asked here. */
export function roundVerdict(r: ScoreResult): string {
  if (r.strokePieces.length === 0) return 'Skipped the lot. Bold.';
  if (r.score >= 85) return 'You could give directions here in your sleep.';
  if (r.score >= 65) return 'You know your way around.';
  if (r.score >= 40) return "You'd get there, eventually.";
  if (r.score >= 15) return "You'd be asking for directions.";
  return 'A tourist, then.';
}

/**
 * One result for the whole round, for the reveal, the panel and the share card: the score is the
 * average of the questions', recall is weighted by street length, and precision is averaged over
 * the questions that were drawn.
 */
export function combine(results: ScoreResult[]): ScoreResult {
  const length = (r: ScoreResult) => r.streets[0]?.length ?? 0;
  const total = results.reduce((s, r) => s + length(r), 0);
  const drawn = results.filter((r) => r.strokePieces.length > 0);
  return {
    score: results.length ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length) : 0,
    recall: total > 0 ? results.reduce((s, r) => s + r.recall * length(r), 0) / total : 0,
    precision: drawn.length ? drawn.reduce((s, r) => s + r.precision, 0) / drawn.length : 0,
    roadPieces: results.flatMap((r) => r.roadPieces),
    strokePieces: results.flatMap((r) => r.strokePieces),
    streets: results.flatMap((r) => r.streets),
    printed: [],
  };
}

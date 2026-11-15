import './style.css';
import { makeCard, pct } from './card';
import { HALF, type Pt, dist, distToSegment, makeProjection as project } from './geo';
import { type MapData, type Place, fetchMap, reversePlace, searchPlaces } from './osm';
import { MIN_QUESTIONS, answerLine, combine, pickQuestions, roundVerdict } from './quiz';
import {
  MIN_STREET_LENGTH,
  type NamedStreet,
  type Piece,
  type ScoreResult,
  scoreDrawing,
  scoreStreet,
  verdict,
} from './score';
import { INK, type Mode, drawAnswer, drawBase, drawPin, drawResult, drawStrokes, printedFor, toMetres } from './sheet';

type Screen = 'start' | 'loading' | 'draw' | 'result';

const MODE_CHIP: Record<Mode, string> = {
  quiz: 'One street at a time',
  landmarks: 'Landmarks given',
  roads: 'Main roads given',
  alleys: 'Side streets given',
  buildings: 'Buildings given',
};

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing`);
  return el as T;
};

const ui = {
  placeLabel: $('place-label'),
  modeChip: $('mode-chip'),
  change: $<HTMLButtonElement>('change'),
  start: $('start'),
  searchForm: $<HTMLFormElement>('search-form'),
  q: $<HTMLInputElement>('q'),
  locate: $<HTMLButtonElement>('locate'),
  results: $<HTMLUListElement>('results'),
  startBtn: $<HTMLButtonElement>('start-btn'),
  startError: $('start-error'),
  play: $('play'),
  prompt: $('prompt'),
  promptCount: $('prompt-count'),
  promptText: $('prompt-text'),
  wrap: $('sheet-wrap'),
  canvas: $<HTMLCanvasElement>('sheet'),
  msg: $('sheet-msg'),
  toolbar: $('toolbar'),
  undo: $<HTMLButtonElement>('undo'),
  clear: $<HTMLButtonElement>('clear'),
  reveal: $<HTMLButtonElement>('reveal'),
  panel: $('panel'),
  announce: $('announce'),
  pen: $<HTMLButtonElement>('pen'),
  score: $('score'),
  verdict: $('verdict'),
  recall: $('recall'),
  precisionLabel: $('precision-label'),
  precision: $('precision'),
  best: $<HTMLUListElement>('best'),
  bestWrap: $('best-wrap'),
  streets: $('streets'),
  answers: $<HTMLOListElement>('answers'),
  forgot: $<HTMLUListElement>('forgot'),
  forgotWrap: $('forgot-wrap'),
  save: $<HTMLButtonElement>('save'),
  again: $<HTMLButtonElement>('again'),
  newPlace: $<HTMLButtonElement>('new-place'),
};

const ctx = ui.canvas.getContext('2d')!;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

interface Quiz {
  questions: NamedStreet[];
  /** One per question checked so far, with the lines drawn for it. */
  answers: { result: ScoreResult; strokes: Pt[][] }[];
  /** The current question has been checked and its answer is on the sheet. */
  checked: boolean;
}

const state = {
  screen: 'start' as Screen,
  place: null as Place | null,
  mode: 'quiz' as Mode,
  map: null as MapData | null,
  /** Side streets printed on the Side streets level. */
  printed: [] as Piece[],
  /** The round on the one-street-at-a-time level. */
  quiz: null as Quiz | null,
  strokes: [] as Pt[][],
  history: [] as Pt[][][],
  tool: 'pen' as 'pen' | 'eraser',
  result: null as ScoreResult | null,
  /** Canvas side in CSS pixels. */
  size: 0,
  base: null as HTMLCanvasElement | null,
  revealFrame: 0,
};

function setScreen(screen: Screen): void {
  state.screen = screen;
  document.body.dataset.screen = screen;
  ui.start.hidden = screen !== 'start';
  ui.play.hidden = screen === 'start';
  ui.toolbar.hidden = screen !== 'draw';
  ui.prompt.hidden = screen !== 'draw' || !state.quiz;
  document.body.dataset.mode = state.mode;
  ui.panel.hidden = screen !== 'result';
  ui.placeLabel.textContent = screen === 'start' ? '' : (state.place?.label ?? '');
  ui.modeChip.textContent = screen === 'start' ? '' : MODE_CHIP[state.mode];
  ui.change.hidden = screen !== 'draw' && screen !== 'result';
  if (screen !== 'start') resize();
}

/* ---------- Start screen ---------- */

function choosePlace(place: Place | null): void {
  state.place = place;
  ui.startBtn.disabled = !place;
  ui.startBtn.textContent = place ? `Start drawing ${place.label}` : 'Pick a place first';
}

function showResults(found: Place[]): void {
  ui.results.replaceChildren();
  // Nominatim often returns the same district twice (the area and its postcode area).
  const places = found.filter(
    (p, i) =>
      found.findIndex((q) => q.label === p.label && dist(project(q.center)(p.center), { x: 0, y: 0 }) < 300) === i,
  );
  if (!places.length) {
    ui.startError.textContent = 'No place by that name. Try a district, a station or a full address.';
    return;
  }
  for (const place of places) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    const label = document.createElement('span');
    label.className = 'r-label';
    label.textContent = place.label;
    const detail = document.createElement('span');
    detail.className = 'r-detail';
    detail.textContent = place.detail;
    btn.append(label, detail);
    btn.addEventListener('click', () => {
      for (const b of ui.results.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-pressed', 'true');
      choosePlace(place);
    });
    li.append(btn);
    ui.results.append(li);
  }
  // The first hit is usually the one meant.
  ui.results.querySelector('button')?.click();
}

ui.searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = ui.q.value.trim();
  if (!q) return;
  ui.startError.textContent = '';
  choosePlace(null);
  ui.results.replaceChildren();
  try {
    showResults(await searchPlaces(q));
  } catch (err) {
    ui.startError.textContent = `Search didn't go through: ${(err as Error).message}. Check your connection and try again.`;
  }
});

ui.locate.addEventListener('click', () => {
  ui.startError.textContent = '';
  if (!navigator.geolocation) {
    ui.startError.textContent = 'This browser cannot share your location. Search for the place instead.';
    return;
  }
  ui.locate.disabled = true;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      // Rounded to about 100 m, so the pin, and any saved image, doesn't mark the player's door.
      const round = (v: number) => Math.round(v * 1000) / 1000;
      const place = await reversePlace({ lat: round(pos.coords.latitude), lon: round(pos.coords.longitude) });
      ui.locate.disabled = false;
      ui.results.replaceChildren();
      showResults([{ ...place, detail: 'Your current location' }]);
    },
    (err) => {
      ui.locate.disabled = false;
      ui.startError.textContent =
        err.code === err.PERMISSION_DENIED
          ? 'Location access is off for this site. Search for the place instead.'
          : 'Could not find your location. Search for the place instead.';
    },
    { enableHighAccuracy: false, timeout: 10000 },
  );
});

ui.startBtn.addEventListener('click', () => void startRound());

async function startRound(): Promise<void> {
  if (!state.place) return;
  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  state.mode = (checked?.value as Mode | undefined) ?? 'quiz';
  state.map = null;
  resetDrawing();
  ui.announce.textContent = '';
  setScreen('loading');
  ui.msg.textContent = `Fetching the streets around ${state.place.label}…`;
  try {
    state.map = await fetchMap(state.place.center, HALF);
  } catch (err) {
    setScreen('start');
    ui.startError.textContent = `Couldn't load the map: ${(err as Error).message}. The map server may be busy; try again in a moment.`;
    return;
  }
  const scoreable = state.map.roads
    .filter((r) => printedFor(state.mode) !== 'major' || r.cls === 'minor')
    .reduce((sum, r) => sum + r.pts.slice(1).reduce((s, p, i) => s + dist(r.pts[i]!, p), 0), 0);
  if (scoreable < MIN_STREET_LENGTH) {
    setScreen('start');
    ui.startError.textContent =
      printedFor(state.mode) !== 'major'
        ? 'OpenStreetMap has almost no streets mapped here. Pick a spot closer to a town centre.'
        : 'Apart from the main roads there are almost no streets mapped here. Pick another spot, or choose Landmarks.';
    return;
  }
  // The Side streets level prints whatever isn't asked for, which only scoring knows.
  state.printed =
    state.mode === 'alleys' ? scoreDrawing(state.map.roads, [], 'alleys', state.map.named, state.map.tunnels).printed : [];
  state.quiz = null;
  if (state.mode === 'quiz') {
    const questions = pickQuestions(questionPool());
    if (questions.length < MIN_QUESTIONS) {
      setScreen('start');
      ui.startError.textContent =
        'Too few named streets here for one at a time. Pick a spot closer to a town centre, or choose Landmarks.';
      return;
    }
    state.quiz = { questions, answers: [], checked: false };
  }
  ui.msg.textContent = '';
  setScreen('draw');
  showQuestion();
  // A history entry for the round, so the browser's back button (a phone's back gesture) returns
  // to the start screen instead of leaving the game. Reused if Forward or a reload left one here.
  if (inRoundEntry()) history.replaceState({ round: true }, '');
  else history.pushState({ round: true }, '');
  ui.pen.focus({ preventScroll: true });
}

const inRoundEntry = () => !!(history.state as { round?: boolean } | null)?.round;

/** Back to the start screen, with the place and help level still picked. False if the player stays. */
function leaveRound(): boolean {
  // Like Undo, Clear and Reveal, nothing happens mid-stroke.
  if (active || erasing) return false;
  // Undo can bring back a cleared drawing, so a cleared one still counts, and so does a round of
  // questions under way.
  const unsaved =
    state.screen === 'draw' &&
    (state.strokes.length > 0 || state.history.length > 0 || (state.quiz?.answers.length ?? 0) > 0);
  if (unsaved && !confirm('Leave this drawing? It will be lost.')) return false;
  resetDrawing();
  ui.announce.textContent = '';
  setScreen('start');
  // Not the search box: on a phone that would pop the keyboard up after a back gesture.
  ui.startBtn.focus({ preventScroll: true });
  return true;
}

/** Set between history.back() and its popstate, so a double click doesn't go back twice. */
let backPending = false;

/** Leaves through the round's history entry when there is one, so Back doesn't go round again. */
function goBack(): void {
  if (backPending) return;
  if (inRoundEntry()) {
    backPending = true;
    history.back();
  } else leaveRound();
}

window.addEventListener('popstate', () => {
  backPending = false;
  if (state.screen !== 'draw' && state.screen !== 'result') return;
  if (!leaveRound()) history.pushState({ round: true }, '');
});

ui.change.addEventListener('click', goBack);

/* ---------- Drawing ---------- */

function resetDrawing(): void {
  cancelAnimationFrame(state.revealFrame);
  state.strokes = [];
  state.history = [];
  state.result = null;
  setTool('pen');
  syncButtons();
}

function syncButtons(): void {
  const checked = !!state.quiz?.checked;
  ui.undo.disabled = checked || state.history.length === 0;
  ui.clear.disabled = checked || state.strokes.length === 0;
  for (const b of ui.toolbar.querySelectorAll<HTMLButtonElement>('[data-tool]')) b.disabled = checked;
  const q = state.quiz;
  if (!q) {
    ui.reveal.textContent = 'Reveal the real map';
    ui.reveal.disabled = state.strokes.length === 0;
    return;
  }
  // A question can be skipped by checking it with nothing drawn.
  ui.reveal.disabled = false;
  if (!q.checked) ui.reveal.textContent = state.strokes.length ? 'Check' : 'Skip';
  else ui.reveal.textContent = q.answers.length < q.questions.length ? 'Next street' : 'See how you did';
}

function setTool(tool: 'pen' | 'eraser'): void {
  state.tool = tool;
  document.body.dataset.tool = tool;
  for (const b of ui.toolbar.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  }
}

function snapshot(): void {
  state.history.push(state.strokes.map((s) => s.slice()));
}

function resize(): void {
  const size = ui.wrap.clientWidth;
  if (!size) return;
  const dpr = window.devicePixelRatio || 1;
  state.size = size;
  ui.canvas.width = Math.round(size * dpr);
  ui.canvas.height = Math.round(size * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const base = document.createElement('canvas');
  base.width = ui.canvas.width;
  base.height = ui.canvas.height;
  const bctx = base.getContext('2d')!;
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBase(bctx, size, state.screen === 'loading' ? null : state.map, state.mode, state.printed, answeredNames());
  state.base = base;
  render();
}

function render(): void {
  const size = state.size;
  if (!size) return;
  if (state.screen === 'result' && state.map && state.result) {
    drawResult(ctx, size, state.map, state.mode, state.strokes, state.result);
    return;
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (state.base) ctx.drawImage(state.base, 0, 0);
  ctx.restore();
  if (state.screen === 'loading') return;
  const last = state.quiz?.checked ? state.quiz.answers[state.quiz.answers.length - 1] : undefined;
  // Darker than the forgotten grey of the reveal, so a missed answer stands out from the streets
  // already answered.
  if (last) drawAnswer(ctx, size, last.result, last.strokes, 1, INK.label);
  else drawStrokes(ctx, size, state.strokes);
  drawPin(ctx, size);
}

/* ---------- One street at a time ---------- */

/** Streets already asked and checked, printed on the base so the next can be placed by them. */
function answeredNames(): string[] {
  const q = state.quiz;
  if (!q) return [];
  const done = q.checked ? q.answers.slice(0, -1) : q.answers;
  return done.map((a) => a.result.streets[0]!.name);
}

function showQuestion(): void {
  const q = state.quiz;
  ui.prompt.hidden = !q;
  if (q?.checked) document.body.dataset.checked = '';
  else delete document.body.dataset.checked;
  if (!q) {
    syncButtons();
    return;
  }
  const n = q.answers.length + (q.checked ? 0 : 1);
  ui.promptCount.textContent = `${n} / ${q.questions.length}`;
  if (!q.checked) {
    const name = q.questions[q.answers.length]!.name;
    ui.promptText.replaceChildren(span('prompt-ask', `Draw ${name}`));
    ui.announce.textContent = `Street ${n} of ${q.questions.length}: draw ${name}.`;
  } else {
    const { result } = q.answers[q.answers.length - 1]!;
    const line = answerLine(result, result.strokePieces.length === 0);
    ui.promptText.replaceChildren(
      span('prompt-name', result.streets[0]!.name),
      span('prompt-score', String(result.score)),
      span('prompt-line', line),
    );
    ui.announce.textContent = `${result.streets[0]!.name}: ${result.score}. ${line}`;
  }
  syncButtons();
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

/**
 * When the primary button last moved the round on. Check, Next and Skip share the button, so a
 * double click or a double tap would otherwise answer a question nobody has seen.
 */
let steppedAt = -Infinity;
const STEP_GUARD = 500;

/** The primary button on the one-street-at-a-time level: check, then move on. */
function stepQuiz(q: Quiz): void {
  const now = performance.now();
  if (now - steppedAt < STEP_GUARD) return;
  steppedAt = now;
  if (!q.checked) {
    const street = q.questions[q.answers.length]!;
    q.answers.push({ result: scoreStreet(street, state.strokes), strokes: state.strokes });
    q.checked = true;
    showQuestion();
    render();
    return;
  }
  if (q.answers.length < q.questions.length) {
    q.checked = false;
    state.strokes = [];
    state.history = [];
    setTool('pen');
    showQuestion();
    // The answered street joins the base.
    resize();
    // The button now reads Skip; a stray Enter shouldn't skip the question just asked.
    ui.pen.focus({ preventScroll: true });
    return;
  }
  const result = combine(q.answers.map((a) => a.result));
  state.strokes = q.answers.flatMap((a) => a.strokes);
  showResult(result);
}

new ResizeObserver(() => resize()).observe(ui.wrap);

function pointerMetres(e: PointerEvent): Pt {
  const rect = ui.canvas.getBoundingClientRect();
  return toMetres(e.clientX - rect.left, e.clientY - rect.top, state.size);
}

let active: Pt[] | null = null;
let erasing = false;
/** The one pointer drawing or erasing; a second finger or a resting palm is ignored. */
let pointerId: number | null = null;

ui.canvas.addEventListener('pointerdown', (e) => {
  // A checked question's answer is on the sheet; the next one starts on a fresh page.
  if (state.screen !== 'draw' || state.quiz?.checked || e.button !== 0 || pointerId !== null) return;
  pointerId = e.pointerId;
  ui.canvas.setPointerCapture(e.pointerId);
  if (state.tool === 'pen') {
    snapshot();
    active = [pointerMetres(e)];
    state.strokes.push(active);
  } else {
    erasing = true;
    snapshot();
    eraseAt(pointerMetres(e));
  }
  render();
});

ui.canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== pointerId) return;
  if (active) {
    // Coalesced events keep fast strokes smooth on high-rate pointers.
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      const p = pointerMetres(ev);
      const last = active[active.length - 1]!;
      if (dist(p, last) >= (1.5 * 2 * HALF) / state.size) active.push(p);
    }
    render();
  } else if (erasing) {
    for (const ev of e.getCoalescedEvents?.() ?? [e]) eraseAt(pointerMetres(ev));
  }
});

function endGesture(e: PointerEvent): void {
  if (e.pointerId !== pointerId) return;
  pointerId = null;
  if (active) {
    // A tap leaves a single point; it isn't a street.
    if (active.length < 2) {
      state.strokes.pop();
      state.history.pop();
    }
    active = null;
  }
  if (erasing) {
    erasing = false;
    const before = state.history[state.history.length - 1];
    if (before && before.length === state.strokes.length) state.history.pop();
  }
  syncButtons();
  render();
}

ui.canvas.addEventListener('pointerup', endGesture);
ui.canvas.addEventListener('pointercancel', endGesture);

function eraseAt(p: Pt): void {
  const reach = (14 * 2 * HALF) / state.size;
  const touches = (s: Pt[]) =>
    s.length === 1 ? dist(p, s[0]!) <= reach : s.some((q, i) => i > 0 && distToSegment(p, s[i - 1]!, q) <= reach);
  const kept = state.strokes.filter((s) => !touches(s));
  if (kept.length !== state.strokes.length) {
    state.strokes = kept;
    render();
  }
}

ui.toolbar.addEventListener('click', (e) => {
  const tool = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tool]')?.dataset.tool;
  if (tool === 'pen' || tool === 'eraser') setTool(tool);
});

function undo(): void {
  // Mid-gesture, the live stroke would keep growing in an array that is no longer on the sheet.
  if (active || erasing || state.quiz?.checked) return;
  const prev = state.history.pop();
  if (!prev) return;
  state.strokes = prev;
  syncButtons();
  render();
}

ui.undo.addEventListener('click', undo);
ui.clear.addEventListener('click', () => {
  if (active || erasing) return;
  snapshot();
  state.strokes = [];
  syncButtons();
  render();
});

document.addEventListener('keydown', (e) => {
  if (state.screen === 'draw' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  }
});

/* ---------- Result ---------- */

ui.reveal.addEventListener('click', () => {
  if (!state.map || active || erasing) return;
  if (state.quiz) {
    stepQuiz(state.quiz);
    return;
  }
  if (!state.strokes.length) return;
  const result = scoreDrawing(
    state.map.roads,
    state.strokes,
    printedFor(state.mode),
    state.map.named,
    state.map.tunnels,
  );
  showResult(result);
});

function showResult(result: ScoreResult): void {
  // Ink the real streets outward from the pin.
  const r2 = (p: { a: Pt; b: Pt }) => (p.a.x + p.b.x) ** 2 + (p.a.y + p.b.y) ** 2;
  result.roadPieces.sort((x, y) => r2(x) - r2(y));
  state.result = result;
  fillPanel(result);
  setScreen('result');
  // The toolbar holding the focused Reveal button is gone; put focus on the result.
  ui.panel.focus({ preventScroll: true });
  animateReveal(result);
}

/** The verdict line for a result: the round's own on the one-street-at-a-time level. */
function verdictFor(r: ScoreResult): string {
  return state.quiz ? roundVerdict(r) : verdict(r, state.strokes.length > 0);
}

function fillPanel(r: ScoreResult): void {
  ui.verdict.textContent = verdictFor(r);
  ui.recall.textContent = pct(r.recall);
  ui.precision.textContent = pct(r.precision);
  const q = state.quiz;
  ui.streets.hidden = !!q;
  ui.answers.hidden = !q;
  ui.again.textContent = q ? 'Play again' : 'Draw it again';
  ui.precisionLabel.textContent = q ? 'Your lines on the asked streets' : 'Your lines on real streets';
  if (q) {
    ui.answers.replaceChildren(
      ...q.answers.map(({ result }) => {
        const li = document.createElement('li');
        const skipped = result.strokePieces.length === 0;
        li.classList.toggle('skipped', skipped);
        li.append(span('a-name', result.streets[0]!.name), span('a-score', skipped ? 'skipped' : String(result.score)));
        return li;
      }),
    );
    return;
  }
  const named = r.streets.filter((s) => s.length >= 60);
  const best = named.filter((s) => s.recall >= 0.6).slice(0, 4);
  const forgot = named.filter((s) => s.recall < 0.2).slice(0, 4);
  fillList(ui.best, ui.bestWrap, best.map((s) => s.name));
  fillList(ui.forgot, ui.forgotWrap, forgot.map((s) => s.name));
}

function fillList(list: HTMLUListElement, wrap: HTMLElement, names: string[]): void {
  list.replaceChildren(
    ...names.map((n) => {
      const li = document.createElement('li');
      li.textContent = n;
      li.title = n;
      return li;
    }),
  );
  wrap.hidden = names.length === 0;
}

function animateReveal(r: ScoreResult): void {
  cancelAnimationFrame(state.revealFrame);
  // Screen readers hear the result once, not every frame of the count-up.
  const announce = () => {
    ui.announce.textContent = `Score ${r.score} out of 100. ${ui.verdict.textContent}`;
  };
  if (reducedMotion.matches) {
    ui.score.textContent = String(r.score);
    render();
    announce();
    return;
  }
  const duration = 1400;
  const t0 = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / duration);
    const eased = 1 - (1 - t) ** 3;
    if (state.map && state.size) drawResult(ctx, state.size, state.map, state.mode, state.strokes, r, eased);
    ui.score.textContent = String(Math.round(r.score * eased));
    if (t < 1) state.revealFrame = requestAnimationFrame(step);
    else announce();
  };
  state.revealFrame = requestAnimationFrame(step);
}

ui.again.addEventListener('click', () => {
  resetDrawing();
  ui.announce.textContent = '';
  // Another round of questions on the same map, picked afresh.
  if (state.quiz) state.quiz = { questions: pickQuestions(questionPool()), answers: [], checked: false };
  setScreen('draw');
  showQuestion();
  ui.pen.focus({ preventScroll: true });
});

/** Every key named street on the map, which the questions are picked from. */
function questionPool(): NamedStreet[] {
  if (!state.map) return [];
  return scoreDrawing(state.map.roads, [], 'none', state.map.named, state.map.tunnels).streets;
}

ui.newPlace.addEventListener('click', goBack);

ui.save.addEventListener('click', async () => {
  const r = state.result;
  if (!r || !state.map || !state.place) return;
  ui.save.disabled = true;
  try {
    const blob = await makeCard(state.map, state.mode, state.strokes, r, state.place.label, verdictFor(r));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `memory-lane-${r.score}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    ui.verdict.textContent = `Couldn't save the image: ${(err as Error).message}`;
  } finally {
    ui.save.disabled = false;
  }
});

setScreen('start');

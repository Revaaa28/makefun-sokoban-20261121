// Sokoban solver — push-optimal, room by room.
//
// Strategy. A generated level is a 1-wide hallway with 1-4 small rooms off it
// (3-4 boxes each). A box pushed out of a room into the hallway can never come
// back, so every box stays in its room and the level's push-optimal count is the
// sum of its rooms' optima. We therefore split the level into rooms and solve
// each room on its own with a breadth-first search over *pushes* (not steps):
// a state is the boxes' squares plus the player's reachable region, states are
// expanded in order of pushes made, so the first solved state met is
// push-optimal for that room. Two deadlocks are pruned, both provably safe:
// a box on a dead square (no push, ignoring the other boxes, can ever bring it
// onto a goal) and a box inside a frozen 2x2 block of walls and boxes with a
// box off its goal. The player walks between pushes on the shortest path.
//
// Determinism: the search is bounded by counted states, never by the wall
// clock; direction order is fixed (u, d, l, r) and ties break by insertion
// order, so two runs on the same set write byte-identical answers. No network,
// no environment, no clock reads.
//
// Fallback: if a room's push search exhausts its state budget (the generator
// guarantees rooms solvable inside it, so this should not happen), a
// deadlock-pruned A* over pushes still tries to solve the room, and if the
// level does not split into rooms at all, the whole level is searched the same
// way. An unsolved level still gets a well-formed (empty) answer file.
//
// Run: node main.ts, reading /input/<id>/level.txt and writing
// /output/<id>/solution.txt (MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, counted in search states — never wall-clock time, so the
// program is deterministic. The generator keeps a room only when its own
// push-optimal search solves it inside 250,000 states, so this cap per room
// is generous; the total cap keeps the whole 5-level set far inside the
// 60-second wall budget even on a slow container.
const MAX_STATES_PER_ROOM = 250_000;
const MAX_STATES_TOTAL = 3_000_000;

// The four moves, in fixed order: [dx, dy, step letter].
const DIRS: ReadonlyArray<readonly [number, number, string]> = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall (short rows and the outer frame count as walls)
  goals: number[];
  boxes: number[]; // sorted
  player: number;
}

/** A level in XSB text: # wall, space floor, . goal, $ box, * box on goal, @ player. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Live squares: every square from which a box, pushed on its own (other boxes
 * ignored), can still reach some goal. Computed by pulling backwards from the
 * goals: a square y is live when the player can stand at y - d and push a box
 * from y to y + d, with y + d live. A box off a live square is dead forever.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (wall[y] === 0 && wall[y - d] === 0 && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the squares the player can reach from `from` with `occupied`
 * (boxes) in the way. `seen`/`stamp` mark the region; returns its lowest
 * square, which names the region in a state's key.
 */
function floodLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let n = 0;
  let low = from;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four squares
 * of walls and boxes, at least one of them a box off its goal. Such a box can
 * never move again, so the state is dead.
 */
function inFrozenBlock(
  level: Level,
  occupied: Uint8Array,
  isGoal: Uint8Array,
  t: number,
): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!((wall[a] || occupied[a]) && (wall[b] || occupied[b]) && (wall[c] || occupied[c]) && (wall[d] || occupied[d]))) continue;
    if ((occupied[a] && !isGoal[a]) || (occupied[b] && !isGoal[b]) || (occupied[c] && !isGoal[c]) || (occupied[d] && !isGoal[d])) return true;
  }
  return false;
}

/** A state's key: its region's lowest square and the boxes' squares. */
function stateKey(boxes: number[], low: number): string {
  return `${low}|${boxes.join(',')}`;
}

interface SearchResult {
  pushes: number;
  moves: string;
}

interface SearchState {
  boxes: number[];
  player: number; // square the player stands on after the push that made this state
  parent: number;
  pushFrom: number; // box square before the push that made this state (-1 for the root)
  pushTo: number;
  key: string; // stateKey(boxes, region low) — used to drop stale A* heap entries
}

/**
 * Rebuild the full move string from a solved state: for each push in order,
 * walk the player to the pushing square on the shortest path, then push.
 */
function reconstruct(
  level: Level,
  states: SearchState[],
  solvedIdx: number,
): string {
  const chain: number[] = [];
  for (let s = solvedIdx; s > 0; s = states[s]!.parent) chain.push(s);
  chain.reverse();
  const occupied = new Uint8Array(level.wall.length);
  let moves = '';
  let player = states[0]!.player;
  let boxes = states[0]!.boxes;
  for (const s of chain) {
    const st = states[s]!;
    const d = st.pushTo - st.pushFrom;
    const dir = DIRS.find(([dx, dy]) => dy * level.w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, st.pushFrom - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[2];
    player = st.pushFrom;
    boxes = st.boxes;
  }
  return moves;
}

/** The shortest walk from `from` to `to` around walls and boxes (lowercase LURD). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: pushing square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/**
 * Push-optimal search of one level (or one room's sub-level): breadth-first
 * over pushes, so the first solved state met uses the fewest pushes. Dead
 * squares and frozen 2x2 blocks are pruned. `budget` is a shared object
 * counting states across the whole run; the search stops (returns null) when
 * the per-call cap or the shared budget runs out. Returns null when no
 * solution is found inside the budget.
 */
function solvePushOptimal(
  level: Level,
  maxStates: number,
  budget: { used: number },
): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const isGoal = new Uint8Array(size);
  for (const g of goals) isGoal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const solved = (bs: number[]): boolean => bs.every((b) => isGoal[b]);
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  for (const b of level.boxes) occupied[b] = 1;
  const rootKey = stateKey(level.boxes, floodLow(level, occupied, level.player, seen, ++stamp, stack));
  for (const b of level.boxes) occupied[b] = 0;
  const states: SearchState[] = [
    { boxes: level.boxes, player: level.player, parent: -1, pushFrom: -1, pushTo: -1, key: rootKey },
  ];
  const index = new Map<string, number>();
  index.set(rootKey, 0);

  let solvedIdx = -1;
  for (let head = 0; solvedIdx < 0 && head < states.length; head++) {
    const cur = states[head]!;
    if (budget.used >= MAX_STATES_TOTAL || states.length >= maxStates) return null;
    budget.used++;
    const boxes = cur.boxes;
    for (const b of boxes) occupied[b] = 1;
    const regionStamp = ++stamp;
    floodLow(level, occupied, cur.player, seen, regionStamp, stack);
    for (let bi = 0; bi < boxes.length && solvedIdx < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        // The player must be able to stand behind the box, and the target
        // square must be open floor a box can still be saved from.
        if (seen[b - d] !== regionStamp || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = inFrozenBlock(level, occupied, isGoal, t);
        let key = '';
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = stateKey(next, floodLow(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null || index.has(key)) continue;
        if (states.length >= maxStates || budget.used >= MAX_STATES_TOTAL) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, states.length);
        states.push({ boxes: next, player: b, parent: head, pushFrom: b, pushTo: t, key });
        if (solved(next)) {
          solvedIdx = states.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (solvedIdx < 0) return null;
  return { pushes: chainLength(states, solvedIdx), moves: reconstruct(level, states, solvedIdx) };
}

/** The number of pushes on the path from the root to state `idx`. */
function chainLength(states: SearchState[], idx: number): number {
  let n = 0;
  for (let s = idx; s > 0; s = states[s]!.parent) n++;
  return n;
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row — the hallway,
 * where a box reaches no goal — out of the floor, and each connected part left
 * that holds a box is a room. Returns null when the level is no set of rooms
 * (a box starts in the hallway, a goal lies in the cut, or some part holds a
 * different number of boxes and goals).
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endSquare(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * Solve the level room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the level's.
 */
function solveByRooms(level: Level, budget: { used: number }): SearchResult | null {
  const rooms = roomsOf(level);
  if (rooms === null) return null;
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    let solved = solvePushOptimal(sub, MAX_STATES_PER_ROOM, budget);
    if (solved === null) solved = solvePushAStar(sub, MAX_STATES_PER_ROOM, budget);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endSquare(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/**
 * Fallback: A* over pushes, same deadlock pruning, heuristic = each box's
 * Manhattan distance to its nearest goal, summed. Not push-optimal in general,
 * but it still solves levels the breadth-first search gives up on, which is
 * worth far more than an empty answer. Deterministic: fixed direction order
 * and insertion-order tie-breaks, bounded by counted states.
 */
function solvePushAStar(
  level: Level,
  maxStates: number,
  budget: { used: number },
): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const isGoal = new Uint8Array(size);
  for (const g of goals) isGoal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const solved = (bs: number[]): boolean => bs.every((b) => isGoal[b]);
  if (solved(level.boxes)) return { pushes: 0, moves: '' };
  const dist = (b: number): number =>
    Math.min(...goals.map((g) => Math.abs((g % w) - (b % w)) + Math.abs(Math.floor(g / w) - Math.floor(b / w))));
  const heuristic = (bs: number[]): number => bs.reduce((a, b) => a + dist(b), 0);

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  for (const b of level.boxes) occupied[b] = 1;
  const rootKey = stateKey(level.boxes, floodLow(level, occupied, level.player, seen, ++stamp, stack));
  for (const b of level.boxes) occupied[b] = 0;
  const states: SearchState[] = [
    { boxes: level.boxes, player: level.player, parent: -1, pushFrom: -1, pushTo: -1, key: rootKey },
  ];
  const gScore: number[] = [0];
  const best = new Map<string, number>();
  best.set(rootKey, 0);

  // Open list: a binary heap on (f, h, insertion order).
  type Entry = [number, number, number, number]; // f, h, seq, state index
  const heap: Entry[] = [[heuristic(level.boxes), heuristic(level.boxes), 0, 0]];
  let seq = 1;
  const less = (a: Entry, b: Entry): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: Entry): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): Entry => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let solvedIdx = -1;
  while (heap.length > 0 && solvedIdx < 0) {
    if (budget.used >= MAX_STATES_TOTAL || states.length >= maxStates) return null;
    const [, , , s] = heapPop();
    // A stale heap entry: a cheaper path to this same state was found after
    // this entry was pushed, so skip it.
    if (gScore[s]! > (best.get(states[s]!.key) ?? Infinity)) continue;
    const cur = states[s]!;
    if (solved(cur.boxes)) {
      solvedIdx = s;
      break;
    }
    budget.used++;
    const boxes = cur.boxes;
    for (const b of boxes) occupied[b] = 1;
    const regionStamp = ++stamp;
    floodLow(level, occupied, cur.player, seen, regionStamp, stack);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== regionStamp || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = inFrozenBlock(level, occupied, isGoal, t);
        let key = '';
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = stateKey(next, floodLow(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const g = gScore[s]! + 1;
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= g) continue;
        best.set(key, g);
        const h = heuristic(next);
        states.push({ boxes: next, player: b, parent: s, pushFrom: b, pushTo: t, key });
        gScore.push(g);
        heapPush([g + h, h, seq++, states.length - 1]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (solvedIdx < 0) return null;
  return { pushes: chainLength(states, solvedIdx), moves: reconstruct(level, states, solvedIdx) };
}

/** Solve one level's text into its move string ('' when unsolved). */
function solveLevel(text: string, budget: { used: number }): string {
  const level = parseLevel(text);
  const byRooms = solveByRooms(level, budget);
  if (byRooms !== null) return byRooms.moves;
  const whole = solvePushOptimal(level, MAX_STATES_PER_ROOM, budget);
  if (whole !== null) return whole.moves;
  const greedy = solvePushAStar(level, MAX_STATES_PER_ROOM, budget);
  return greedy !== null ? greedy.moves : '';
}

const budget = { used: 0 };
for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'), budget);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Revaaa28/makefun-sokoban-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Revaaa28/makefun-sokoban-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban Solver — push-optimal, room by room

A push-optimal Sokoban solver for make.fun's
[Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121)
bounty. One program (`main.ts`, Node 22) answers all 5 instances of a set in
one run: it reads `/input/<id>/level.txt` and writes
`/output/<id>/solution.txt` with the player's moves in LURD.

## How it works

A generated level is a 1-wide hallway with 1–4 small rooms off it (3–4 boxes
each). A box pushed out of a room into the hallway can never come back, so
every box stays in its room and the level's push-optimal count is the sum of
its rooms' optima. The solver therefore:

1. splits the level into rooms by cutting the dead squares of the hallway row
   out of the floor;
2. solves each room on its own with a breadth-first search over **pushes**
   (a state is the boxes' squares plus the player's reachable region), so the
   first solved state met uses the fewest pushes;
3. prunes two provably safe deadlocks — boxes on dead squares (no push,
   ignoring the other boxes, can ever bring them onto a goal) and boxes inside
   frozen 2×2 blocks of walls and boxes;
4. walks the player between pushes on the shortest path, and between rooms
   along the hallway.

The search is bounded by counted states, never by the wall clock, with a
fixed direction order — so two runs on the same set write byte-identical
answers. A deadlock-pruned A* over pushes stands by as a fallback for any
room the breadth-first search gives up on.

## Results

| Set | Score (of 1,000,000) | Pushes vs push-optimal P* |
| --- | --- | --- |
| Practice set (kit) | **1,000,000** | 13/13, 16/16, 29/29, 47/47, 60/60 — every instance at P* |
| Fresh set 1 (drawn with the kit generator) | **1,000,000** | at P* on all 5 instances |
| Fresh set 2 | **1,000,000** | at P* on all 5 instances |
| Fresh set 3 | **1,000,000** | at P* on all 5 instances |

House baseline (plain-astar 1.0.0) scores 200,000 on the practice set. The
whole 5-level set solves in about 1 second, far inside the 60-second wall
budget.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

No dependencies, no network, no build step — plain TypeScript with erasable
syntax only, run by Node 22's native type stripping.

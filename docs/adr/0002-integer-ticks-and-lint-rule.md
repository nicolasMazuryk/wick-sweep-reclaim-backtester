# 0002. Integer ticks, enforced by a lint rule

Status: accepted

## Context
Price comparisons drive the level state machine (sweep, reclaim, stop, target). Float rounding in those comparisons would make behaviour depend on how a price was computed, and would break byte-identical reruns.

## Decision
Prices are `Ticks`: integers held in `Int32Array` on the hot path. Decimal strings are converted with exact BigInt arithmetic. Sizes are integer `Lots`. Every rounding of a derived distance has a fixed direction and a named helper (`ceilTicksConservative` for distances price must exceed, `floorTicksConservative` for targets). The custom ESLint rule `wsr/no-float-price` (in `packages/eslint-plugin-wsr`) fails the build when a float price is compared. Related rules: `wsr/no-venue-literal` and `wsr/reserved-identifiers`.

## Consequences
- Price logic is exact and side-symmetric.
- The rule makes the convention a CI gate, not a review habit.
- Contributors must convert at the boundary. The cost is a few helper calls per distance.

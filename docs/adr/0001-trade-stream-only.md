# 0001. Trade-stream-only data model

Status: accepted

## Context
The hypothesis is about stop runs: a fast extreme is swept, then reclaimed. Order-book and quote history is expensive, inconsistent across venues, and often unavailable for a year or more. Public trade archives exist for all six target venues (Binance, Bybit, OKX, Bitget, Gate, KuCoin).

## Decision
The system consumes only trades `(t, p, q, s)`: timestamp, price, size and aggressor side. There are no candles and no quotes. Spread is estimated from the trade stream itself (the median price jump between consecutive opposite-side prints). Fills are modelled as bounds, never as measured execution (`specs/implemenation-spec.md` §1.2, §4).

## Consequences
- Results are reproducible from public archives alone.
- Every execution claim is a conservative bound. The spec lists the weaknesses this leaves open (§12).
- Live trading, order routing and exchange keys are non-goals, so the repo holds no credentials.
- Venues are never mixed within one engine run.

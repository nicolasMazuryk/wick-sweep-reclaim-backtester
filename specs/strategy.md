# Wick-Sweep-Reclaim (WSR) Strategy — Quantitative Specification for Trade-Stream Implementation

Target: crypto perpetual futures (ETHUSDT-class), 24/7, raw trade data only (no order-book or quote feed).
Status: **research specification**, not a validated strategy. Every threshold below is a starting point to be calibrated as described in §9.

---

## 0. Naming map (chart intuition → specification)

| Chart term | Spec name | What it is |
|---|---|---|
| wick | **Spike** | a fast excursion to an extreme that is quickly rejected |
| wick extreme / Base1 / entry level (white) | **WickLevel** | the extreme print of a qualified Spike; the trigger price of the entry order |
| Base2 / stop-loss (red) | **SweepExtreme** | the furthest print of the excursion beyond the WickLevel; stop-loss anchor |
| X | **SweepDepth** | `abs(SweepExtreme − WickLevel)`; the risk distance |
| 2·X / take-profit (green) | **Target** | `WickLevel − TargetMult · SweepDepth` (short) |
| "strong / weak base" | **WickStrength** | score in [0, 1] of how decisive the Spike was |
| local volatility | **VolUnit** | trade-derived scale unit; all distances are in VolUnits |
| "return to Base1" | **Reclaim** | price crossing back through the WickLevel after the sweep |

Every name below is usable verbatim as a code identifier.

---

## 1. Reframing the hypothesis (read first)

The chart description says "price returns to the wick extreme and reacts". Mechanically, the order placed is a **stop-market at the WickLevel in the reversal direction**, so the trade is not "price bounces off the level" — it is:

> After a fast extreme (WickLevel) is swept by a shallow excursion (to the SweepExtreme) and price crosses back through the WickLevel (the Reclaim), the move **continues** in the reclaim direction by ≥ `TargetMult · SweepDepth` before retracing `StopMult · SweepDepth`.

This is a *sweep-and-reclaim* (stop-run reversal) hypothesis. The microstructure story that makes it plausible and testable: resting stops and breakout entries cluster just beyond a fast extreme; the sweep to the SweepExtreme consumes them; participants who entered on the breakout beyond the WickLevel are now trapped with stops back through it, so the Reclaim triggers a second, one-sided aggressor cascade. Prediction that must show up in the data: **aggressor imbalance in the reclaim direction spikes in the first volume units after the Reclaim**, and its size predicts continuation.

Key statistical fact for every evaluation below: with entry at the WickLevel, stop at `1 · SweepDepth` and target at `2 · SweepDepth`, a driftless price path hits the target first with probability **1/3**. Hit rate is meaningless on its own; the edge is `P(target first) − 1/3` after costs (§7.4).

---

## 2. Data, clocks, notation

### 2.1 Trade stream
Each trade `i`: `(t_i, p_i, q_i, s_i)` — timestamp (ms or better), price, size, aggressor side `s_i ∈ {+1 buy, −1 sell}`. Tick size `Tick`.

**No quote feed is available.** Spread is estimated from trades only:
```
SpreadEst_t = median( |p_i − p_{i−1}| : s_i ≠ s_{i−1}, i in last 500 events ),  floored at Tick
```
(bid–ask bounce: consecutive prints from opposite aggressors straddle the spread). Refresh every 100 events.

Exchange feeds aggregate or split taker fills inconsistently; pre-process by **merging records with identical `(t_i, s_i)` and monotone prices** into one aggressor event. All counts below refer to merged events.

### 2.2 Clocks
- **Wall clock** `t` (seconds): only for latency modelling and the burst filter.
- **Event clock** `n`: cumulative aggressor events.
- **Volume clock** `Vol(t) = Σ_{t_i ≤ t} q_i`: primary clock for "fast/slow", dwell and age; it normalises illiquid hours against bursts.

**Volume buckets.** Partition the stream into consecutive buckets each containing `BucketVolume` of traded size. `BucketVolume` is set once per day as the median volume per 60 s over the previous 7 days (a bucket ≈ one median-liquidity minute). Bucket `k` records `High_k, Low_k, Imbalance_k = Σ s_i q_i, Vwap_k, Count_k, WallDuration_k`.

All quantities at time `t` use only data with `t_i ≤ t`, and bucket statistics only from **completed** buckets.

### 2.3 VolUnit (local scale)
```
VolUnit_t = median( High_k − Low_k : k in last UnitWindow completed buckets )     UnitWindow = 60
VolUnit_t = max( VolUnit_t , 4·Tick , 3·SpreadEst_t )
```
Median bucket range: robust to single bursts, online, dimension "typical move per median minute of volume". Alternative to test second: pre-averaged realised volatility per bucket `RVol = sqrt(EWMA((log Vwap_k − log Vwap_{k−1})²))`, scaled to a horizon. Test the median range first (no horizon parameter); keep `RVol` for the regime filter (§6.1).

Each WickLevel freezes `VolUnit_created` at creation; `VolUnit_now` is the live value. Level geometry (SweepDepth bounds, Target, tolerances) uses `VolUnit_created`; ageing and regime checks use `VolUnit_now`. Rationale: the level is an absolute price artefact of the conditions in which it formed.

### 2.4 Side convention
Everything is written for an **upper Spike → short setup** (`Side = +1`). For a lower Spike → long setup (`Side = −1`), swap `max ↔ min`, `≥ ↔ ≤`, `+1 ↔ −1`, and invert imbalance signs. Where one formula must serve both, prices appear as `Side · price`.

---

## 3. Candle-free definition of a Spike

### 3.1 Online extremum detection (VolUnit-scaled zigzag)
State: `(LegDir, LegExtreme, LegExtremeTime)`.
```
PivotReversal_t = max( PivotMult · VolUnit_t , 3·Tick , 2·SpreadEst_t )     PivotMult ∈ [0.8, 2.0], start 1.2

if LegDir == up:
    if p_i > LegExtreme:                  LegExtreme = p_i; LegExtremeTime = t_i
    elif p_i ≤ LegExtreme − PivotReversal: emit PivotHigh(price=LegExtreme, time=LegExtremeTime, confirmed_at=t_i)
                                           LegDir = down; LegExtreme = p_i
(symmetric for LegDir == down)
```
- A pivot exists **only from `confirmed_at` onward**. Nothing downstream may use `LegExtreme` before that. This is the look-ahead boundary of the whole system.
- Oscillations smaller than `PivotReversal` produce no pivot (micro-extrema suppressed). Residual noise is handled by the Spike gates (§3.3) and by **merging**: a new pivot within `MergeTolerance · VolUnit_created` (`MergeTolerance = 0.25`) of an active WickLevel on the same side is not a new level; it increments `PriorTouches` and keeps the more extreme price.
- Use trade prices (the extreme *fill* is where stops were placed beyond). Variant: require the extreme print to have `q_i ≥` 10th percentile of trade size to discard one-lot outliers.

### 3.2 Excursion segment and features
Given `PivotHigh(PivotPrice, PivotTime)`, define the **rejection band edge** `BandEdge = PivotPrice − BandWidthMult · VolUnit_created`, `BandWidthMult ∈ [0.3, 0.8]`, start 0.5.
```
EnterTime = last print before PivotTime with p_i ≤ BandEdge
ExitTime  = first print after PivotTime with p_i ≤ BandEdge      (wait until observed)
Approach  = prints in [EnterTime, PivotTime];   Rejection = prints in [PivotTime, ExitTime]
Anchor    = min price over the AnchorWindow = 20 buckets before EnterTime
```

| Feature | Definition | Meaning |
|---|---|---|
| `SpikeSize` | `(PivotPrice − Anchor) / VolUnit_created` | size of the excursion |
| `ApproachVolume, RejectVolume` | `Σ q_i` over Approach / Rejection | |
| `ApproachDuration, RejectDuration` | volume-clock length, in buckets | "time" in volume units |
| `ApproachSpeed` | `(PivotPrice − BandEdge) / (VolUnit_created · ApproachDuration)` | VolUnits per bucket |
| `RejectSpeed` | same over Rejection | how fast the extreme was rejected |
| `SpeedAsymmetry` | `log(RejectSpeed / ApproachSpeed)` | sharp rejection after slower approach = absorption |
| `ApproachImbalance` | `+Σ s_i q_i / ApproachVolume` | buy share of the approach |
| `RejectImbalance` | `−Σ s_i q_i / RejectVolume ∈ [−1,1]` | sell share of the rejection |
| `VolumeBurst` | `(ApproachVolume + RejectVolume) / ExpectedVolume(wall duration, hour-of-day)` | activity relative to normal |
| `TopDwell` | volume traded within `[PivotPrice − TopBandMult·VolUnit_created, PivotPrice]`, `TopBandMult = 0.15`, divided by `BucketVolume` | dwell at the extreme |
| `RetraceFraction` | `(PivotPrice − min p over [ExitTime, ExitTime + RetraceWindow]) / (PivotPrice − Anchor)`, `RetraceWindow = 5` buckets | did the rejection stick |
| `MaxTradeSize` | largest merged event in the excursion / rolling p99 of event size | liquidation / block signature |
| `MaxAggressorRun` | longest run of same-sign events in Rejection | cascade signature |
| `MaxPrintGap` | `max |p_i − p_{i−1}| / VolUnit_created` inside the excursion | liquidity vacuum (trade-only substitute for spread widening) |

### 3.3 Spike gates (hard filter → pivot becomes a WickLevel)
```
G1  SpikeSize        ≥ MinSpikeSize          [1.0, 3.0] VolUnits, start 1.5
G2  ApproachDuration + RejectDuration ≤ MaxSpikeDuration   [1, 6] buckets, start 3      (fast)
G3  RejectSpeed      ≥ MinRejectSpeed        start 0.5 VolUnit/bucket                   (rejected, not drifted)
G4  RejectImbalance  ≥ MinRejectImbalance    [0.1, 0.4], start 0.2                      (sell aggression out)
G5  RetraceFraction  ≥ MinRetrace            start 0.6, within RetraceWindow            (rejection stuck)
G6  TopDwell         ≤ MaxTopDwell           start 0.5 buckets                          (no dwell at the top)
```
G5 delays usability by up to `RetraceWindow` buckets; acceptable because the sweep comes later. A pivot failing the gates is a **SlowExtreme**: stored, never traded, used as the control group (§9.2).

---

## 4. WickStrength score

### 4.1 Features
`x = (SpikeSize, log RejectSpeed, SpeedAsymmetry, RejectImbalance, ApproachImbalance, VolumeBurst, TopDwell, RetraceFraction, MaxTradeSize, MaxAggressorRun, MaxPrintGap, PriorTouches, SpikeSize / RVol)`
where `PriorTouches` = number of earlier pivots within `MergeTolerance · VolUnit_created` of `PivotPrice` in the last 24 h of volume-equivalent.

Each feature is converted to a rolling rank `rank_j ∈ (0,1)` against the last `RankWindow = 500` confirmed pivots (WickLevels and SlowExtremes together) so the score is stationary across regimes.

### 4.2 Score
Stage A (prior, no fitting):
```
WickStrength_0 = Σ_j w_j · rank_j
w = { SpikeSize .15, log RejectSpeed .20, SpeedAsymmetry .10, RejectImbalance .20, VolumeBurst .10,
      (1 − TopDwell) .10, RetraceFraction .05, MaxTradeSize .05, MaxAggressorRun .05 }
```
`ApproachImbalance` and `PriorTouches` get weight 0 in the prior: their sign is an open question (§11).

Stage B (fitted): L2-penalised logistic regression `P(Reaction = 1 | x)` with the reaction label from §9.2. Fit only on the training window of each walk-forward fold; correct for the fact that the label is realised only for levels that get approached (inverse-probability weighting). Gradient boosting only if the logistic calibration curve is clearly non-monotone in ≥ 2 features.

### 4.3 Use
```
WickStrength ≥ MinStrength     → level is tradable (MinStrength set so ~40 % of gated Spikes pass; test 30–60 %)
size ∝ g(WickStrength)         → §8.3
conflicts                      → higher WickStrength wins (§6.9)
```
Report results by WickStrength decile; the score is useful only if net expectancy is monotone in it.

---

## 5. Distance, relevance, ageing, invalidation

`Age(t) = (Vol(t) − Vol(ExitTime)) / BucketVolume` in buckets.
```
Distance(t)  = Side · (WickLevel − p_t) / VolUnit_created          (positive = price below an upper WickLevel)
Relevance(t) = exp(−Age/AgeScale) · exp(−max(Distance,0)/DistanceScale)
AgeScale ∈ [100, 600] buckets (start 240 ≈ 4 median-liquidity hours);  DistanceScale ∈ [3, 10] VolUnits (start 5)
```
`Relevance` is a feature and tie-breaker, not a rule. Hard rules:

| Condition | Effect |
|---|---|
| `Age > MaxAge` (start `3 · AgeScale`) | EXPIRED |
| price beyond WickLevel by `> BreakoutDepth` (§6.1) before any Reclaim | INVALIDATED (breakout, not sweep) |
| price beyond WickLevel by `> BreakoutDepth` after a completed setup | RETIRED |
| `VolUnit_now / VolUnit_created ∉ [0.4, 2.5]` | INVALIDATED (regime shift) |
| level used `MaxUses` times (start 1; test to 3) | RETIRED |
| price never within `DistanceScale` VolUnits | dormant, no cost |

Design choice: relevance decays in volume-age (chosen) rather than wall-clock age, because stop clusters are consumed by trading, not by time. Test wall-clock as variant.

---

## 6. SweepDepth, SweepExtreme, Reclaim, entry, stop, target

### 6.1 Sweep bounds
```
MinSweepDepth = max( MinSweepMult · VolUnit_created , 3·Tick , 2·SpreadEst )   MinSweepMult ∈ [0.3, 1.0], start 0.5
BreakoutDepth = BreakoutMult · VolUnit_created                                  BreakoutMult ∈ [1.5, 4.0], start 2.5
```
An excursion beyond the WickLevel shallower than `MinSweepDepth` is noise (no stops taken); deeper than `BreakoutDepth` is a breakout (level no longer a reference). `MinSweepDepth` also carries the cost floor: `MinSweepDepth ≥ 2 · RoundTripCost` (§7.4).

### 6.2 SweepExtreme confirmation
State SWEEPING starts at the first print with `p_i ≥ WickLevel + MinSweepDepth`. Track `SweepRunningMax`. The SweepExtreme is **confirmed** when the zigzag emits a PivotHigh for this leg (price retreats `PivotReversal` from `SweepRunningMax`) **and** `SweepRunningMax ≤ WickLevel + BreakoutDepth`:
```
SweepExtreme = SweepRunningMax ;   SweepDepth = SweepExtreme − WickLevel ∈ [MinSweepDepth, BreakoutDepth]
```
If `SweepRunningMax` exceeds `WickLevel + BreakoutDepth` before confirmation → INVALIDATED. The sweep leg gets its own Spike features (§3.2); a SweepExtreme that itself qualifies as a Spike is scenario §6.5.

### 6.3 Reclaim confirmation and order placement
- **ArmMode = RestEarly:** place the sell-stop at the WickLevel immediately at SweepExtreme confirmation. Minimal latency; the order can be hit by slow drift.
- **ArmMode = ArmOnApproach:** place the stop only when price first prints `≤ WickLevel + ArmDistance · VolUnit_created` (`ArmDistance ∈ [0.3, 1.0]`, start 0.5) and the leg down from the SweepExtreme satisfies `ReturnSpeed ≥ MinReturnSpeed`.

Test **RestEarly first** (it is the literal chart rule), then ArmOnApproach as a filter. In both, the trigger is the first print with `p_i ≤ WickLevel` after arming. The backtest must apply the exchange's trigger semantics (last-traded vs mark price); use last-price triggers so the trade feed is the trigger source.

Variant: `TriggerOffset` of 1–2 ticks through the level to avoid fills on a mere touch.

### 6.4 Stop and Target
```
EntryFill   modelled, §7
StopLoss    = SweepExtreme + StopOffset · Tick        StopOffset = 1; stop-market
Target      = WickLevel − TargetMult · SweepDepth     TargetMult = 2 (v1); limit order, fill rule §7.3
RiskPerTrade ≈ SweepDepth + slippage
TimeStop    = MaxHold = 4 · (volume duration of the sweep leg), exit at market   (variant on/off)
```

### 6.5 Validating TargetMult = 2 instead of assuming it
For every filled trade record the path in units of SweepDepth: `m(t) = (EntryFill − p_t) / SweepDepth`; `MFE = max m`, `MAE = −min m` until the stop would hit. For a grid `TargetMult ∈ {0.5, 1, 1.5, 2, 2.5, 3, 4}`, `StopMult ∈ {0.75, 1, 1.25, 1.5}`:
```
HitRate(TargetMult, StopMult) = P(MFE ≥ TargetMult before MAE ≥ StopMult)
Expectancy = HitRate · (TargetMult·SweepDepth − RoundTripCost) − (1 − HitRate) · (StopMult·SweepDepth + RoundTripCost)
```
Choose the plateau, not the peak, on training data; verify the same pair OOS. Also test targets in **VolUnits** (`Target = WickLevel − TargetUnits · VolUnit_created`) because SweepDepth is noisy and small-SweepDepth cases put the Target inside the cost floor. Report `HitRate | SweepDepth/VolUnit_created ∈ bins`. Also test a two-stage exit (half at `1 · SweepDepth`, stop to entry, half at `TargetMult`).

Martingale baseline: `HitRate_0 = StopMult / (TargetMult + StopMult)`; for (2, 1) that is 1/3. Every HitRate is reported next to `HitRate_0`.

---

## 7. Execution model (identical in backtest and live)

### 7.1 Trigger and latency
```
TriggerTime = first print with p_i ≤ WickLevel (after arming)
SendTime    = TriggerTime + ObsLatency + DecisionLatency      (30–80 ms typical, cloud)
FillTime    = SendTime + ExchangeLatency                      (10–50 ms)
Latency     = ObsLatency + DecisionLatency + ExchangeLatency
```
For an exchange-native stop only `ExchangeLatency` remains; model both. Run at `Latency ∈ {0, 50, 150, 500}` ms and report the expectancy curve. A strategy that dies between 50 and 150 ms is not tradable from a normal cloud region.

### 7.2 Fill price of the market order (trade-only model)
```
FillPrice = worst print in [FillTime, FillTime + FillWindow] on our aggressor side
            − ½ · SpreadEst_t                                (sell side)
            − Slippage(Qty)                                  FillWindow = 100 ms
Slippage(Qty) = SlipTicks · Tick + SlipCoef · (Qty / Vol100ms) · VolUnit_now
                SlipTicks ∈ {1, 2};  SlipCoef start 0.05, recalibrated from live fills
```
`Vol100ms` = rolling median traded volume per 100 ms at that hour-of-day. In a Burst (§6.7): `Slippage × 3`, `FillWindow = 300 ms`. If no prints in the window: fill at the last print `− SpreadEst_t` (conservative).

**Touch-and-reverse.** If price touches the WickLevel and the next print after `FillTime` is above `WickLevel + PivotReversal`, the order still fills (it is a market order once triggered) at the adverse price. Never simulate "no fill on instant reversal" — that is the optimistic bias and the largest divergence between candle backtests and reality. Report its frequency.

### 7.3 Stop and Target fills
- StopLoss: model 7.2, triggered at `SweepExtreme + StopOffset · Tick`.
- Target as limit, **baseline rule (conservative):** filled only when a print lands strictly beyond it (`p_i < Target − Tick`). **Optimistic bound:** filled when volume printed *at* the Target after placement exceeds `QueueProxy = 5 · Vol100ms`. Report both; without book data the truth is between them.
- Variant: Target as market on touch (taker fee, model 7.2).
- TimeStop: market, model 7.2.

### 7.4 Costs and breakeven
```
RoundTripCost = TakerFee·Entry + (TakerFee or MakerFee)·Exit + E[Slippage_entry] + E[Slippage_exit] + funding accrued
BreakevenHitRate = (SweepDepth + RoundTripCost) / (3 · SweepDepth)        (TargetMult 2, StopMult 1)
```
ETHUSDT-class perps: taker ≈ 5.5 bps, maker ≈ 2 bps, half-spread ≈ 0.4 bps, slippage ≈ 1 bps → `RoundTripCost ≈ 9–13 bps`. With `SweepDepth = 0.5 · VolUnit` and `VolUnit ≈ 0.1 %` of price, `SweepDepth ≈ 5 bps` and `BreakevenHitRate ≈ 1.0` → **untradeable**. The floor `MinSweepDepth ≥ 2 · RoundTripCost` is therefore mandatory; on ETHUSDT it forces `MinSweepMult` up or restricts trading to high-VolUnit windows.

### 7.5 Order management
- Arm: place entry stop per ArmMode. On sweep re-set (§6.2): cancel–replace StopLoss; entry stop unchanged.
- Cancel on: invalidation, expiry, liquidity guard, conflicting fill.
- On fill: place StopLoss and Target as OCO immediately (exchange-side if supported). Partial fills: exits sized to the filled quantity; remainder cancelled after `FillWindow`.
- One open position per symbol; pending setups capped at `MaxPending = 4` (highest WickStrength).

---

## 8. Scenario rules

### 8.1 Regime: trending vs ranging
```
TrendEfficiency = |Vwap_k − Vwap_{k−RegimeWindow}| / Σ_{j=k−RegimeWindow}^{k} (High_j − Low_j),   RegimeWindow = 60
VolRatio        = RVol(short 5 buckets) / RVol(long 60 buckets)
```
- `TrendEfficiency ≥ 0.4` aligned with the setup (short in a downtrend): allow.
- `TrendEfficiency ≥ 0.4` against it (**counter-trend**): allow only if `WickStrength ≥ MinStrength + 0.15`; size halved. Variant: block.
- `TrendEfficiency < 0.2` (range): allow; most setups live here.
Regime is a conditioning variable in the report; hard-code nothing until the conditional tables justify it.

### 8.2 Clean sweep vs multiple sweeps
- Clean: one leg beyond the WickLevel → SweepExtreme → Reclaim. Standard rules.
- Multiple: after SweepExtreme confirmation and before the trigger, price exceeds the WickLevel again. New high `≤ SweepExtreme`: keep everything. New high in `(SweepExtreme, WickLevel + BreakoutDepth]`: re-set `SweepExtreme`, `SweepDepth`, cancel–replace StopLoss. Beyond `BreakoutDepth`: INVALIDATED. Track `SweepCount`; report by `SweepCount ∈ {1, 2, ≥3}`; INVALIDATE at `MaxSweeps = 3`.

### 8.3 Level touched many times before the sweep
`PriorTouches` counts approaches within `MergeTolerance` that did not exceed `MinSweepDepth`. Competing hypotheses: repeated respect = strong (H+) vs each touch consumes resting orders (H−). v1: no filter; report by `PriorTouches ∈ {0, 1, 2, ≥3}`; Stage B decides the sign.

### 8.4 Overlapping / nested WickLevels (same side)
Two active upper WickLevels `L_inner < L_outer` within `BreakoutDepth` of each other: a sweep of `L_outer` also sweeps `L_inner`. (a) If `L_outer` is itself a qualified Spike, it is the WickLevel; retire `L_inner`. (b) If only `L_inner` is a Spike, `L_outer`'s extreme *is* its SweepExtreme — normal setup. Never run two orders on nested levels on the same side; keep the higher WickStrength.

### 8.5 The sweep leg is itself a stronger Spike
If the sweep leg passes G1–G6 with `WickStrength(sweep) > WickStrength(WickLevel)`: trade the current short as specified, and register the SweepExtreme as a new WickLevel (`UseCount = 0`) for future setups. A violently rejected sweep should *help* the current trade; include `WickStrength(sweep)` as a feature.

### 8.6 Slow vs violent Reclaim
`ReturnSpeed` = speed of the leg from SweepExtreme back to WickLevel in VolUnits per bucket; `ReturnImbalance` = sell share on that leg.
- Violent (`ReturnSpeed ≥ RejectSpeed` of the sweep leg and `ReturnImbalance ≥ 0.2`): cascade story active; full size.
- Slow drift (`ReturnSpeed < 0.3`): under RestEarly the trade is still taken (baseline); under ArmOnApproach it is skipped. Report both.

### 8.7 Bursts (news) and print gaps
Perps do not gap by session but do gap in the print sequence. **Burst** = `VolRatio > 3` or a single print jump `> 3 · VolUnit_now`. Rules: no new WickLevels from pivots inside a burst window (features unrepresentative); armed orders remain but the burst slippage regime applies (§7.2); an order whose trigger print and next print are `> 2 · VolUnit_now` apart fills at that next print ("touch and fly"). Robustness variant: blacklist ±2 min around scheduled macro releases and funding timestamps.

### 8.8 Low-liquidity periods
VolUnit, clocks and dwell are volume-based, so thin hours automatically widen `PivotReversal` and stretch wall-clock windows. Extra **liquidity guard** (trade-only): arm no new orders if `SpreadEst_t > 2 ×` its 24 h median, or if the last 5 buckets took `> 5 ×` their median wall-clock duration. Open positions keep their exits.

### 8.9 Conflicting setups on opposite sides
An armed short (upper WickLevel) and armed long (lower WickLevel) may coexist with price between them. If `|WickLevel_short − WickLevel_long| < 2 · max(SweepDepth_short, SweepDepth_long)`, keep only the higher WickStrength. On a fill, cancel the other side's order if it lies inside the open trade's stop–target corridor. Never hold opposite positions.

### 8.10 Invalidation summary (any state)
```
excursion beyond WickLevel > BreakoutDepth           → INVALIDATED
Age > MaxAge                                          → EXPIRED
VolUnit_now / VolUnit_created ∉ [0.4, 2.5]            → INVALIDATED
liquidity guard while ORDER_ARMED                     → order pulled, back to SWEEP_CONFIRMED
SweepCount ≥ MaxSweeps                                → INVALIDATED
higher-WickStrength conflicting setup filled          → CANCELLED
after IN_TRADE: stop / target / time stop             → CLOSED, UseCount += 1
```

---

## 9. Algorithm, state machine, validation

### 9.1 Data structures and states
```
TradeRing      ring of merged events covering ≥ 2·UnitWindow buckets
BucketBuilder  accumulators; on BucketVolume reached → push bucket, refresh VolUnit_now, RVol, TrendEfficiency, BurstFlag, LiquidityGuard, SpreadEst
Zigzag         (LegDir, LegExtreme, LegExtremeTime) → emits Pivot(price, time, confirmed_at, side)
PivotStore     every confirmed pivot with features and class ∈ {WickLevel, SlowExtreme} (needed for PriorTouches and the control group)
LevelBook      two sorted maps (upper, lower): price → Level{WickLevel, VolUnit_created, WickStrength, State, SweepExtreme, SweepDepth, PriorTouches, SweepCount, UseCount, OrderIds}

States:  PIVOT_PENDING → WICK_ACTIVE → SWEEPING → SWEEP_CONFIRMED → ORDER_ARMED → IN_TRADE → CLOSED
         terminal: INVALIDATED, EXPIRED, CANCELLED
```
Per-print loop (upper side shown):
```
on print i:
  BucketBuilder.update(i); if bucket closed → refresh all bucket statistics
  pivot = Zigzag.update(i)
  if pivot → PIVOT_PENDING; once ExitTime observed compute features; after RetraceWindow apply G1–G6
            → WICK_ACTIVE (register in LevelBook, freeze VolUnit_created, compute WickStrength) or SlowExtreme
  for each Level in LevelBook.upper with p_i ≥ WickLevel − DistanceScale·VolUnit_created:
     WICK_ACTIVE:      p_i ≥ WickLevel + MinSweepDepth → SWEEPING (SweepRunningMax = p_i)
     SWEEPING:         SweepRunningMax = max(·, p_i); > WickLevel + BreakoutDepth → INVALIDATED
                       p_i ≤ SweepRunningMax − PivotReversal → SWEEP_CONFIRMED (SweepExtreme, SweepDepth fixed)
     SWEEP_CONFIRMED:  liquidity ok and ArmMode condition met → place sell-stop at WickLevel → ORDER_ARMED
                       p_i > SweepExtreme → re-sweep handling (§8.2)
     ORDER_ARMED:      p_i ≤ WickLevel → trigger; simulate fill (§7) → IN_TRADE; place StopLoss + Target
                       re-sweep / invalidation / conflict checks
     IN_TRADE:         exits in priority order → CLOSED; UseCount += 1
     all states:       ageing → EXPIRED; regime → INVALIDATED
```
Look-ahead checklist embedded in the loop: `VolUnit_now` from completed buckets only; `ExitTime` and `RetraceFraction` are waited for, never peeked; `SweepExtreme` fixed only at the reversal print; fills use prints strictly after `TriggerTime + Latency`.

### 9.2 Reaction test (is a Spike extreme a reference level at all?)
For every level `ℓ` in a level set, the **approach event** is the first print with `|p_i − ℓ| ≤ ApproachTol · VolUnit` (`ApproachTol = 0.2`) after the level has been ≥ 3 VolUnits away and older than `RetraceWindow`. Over the next `ReactionWindow = 10` buckets:
```
ReactionDisplacement = Side · (ℓ − p_{t + ReactionWindow}) / VolUnit           signed move away from the level
ReactionHit          = 1{ price moves ≥ 1 VolUnit away from ℓ before moving ≥ 1 VolUnit through it }
```
Level sets, all through the same code path:
1. **WickLevels** (gated), split by WickStrength decile.
2. **SlowExtremes** (pivots failing the gates).
3. **Placebo levels**: each WickLevel shifted `±1, ±2` VolUnits, same time.
4. **Random levels**: at each approach time, a level at the same distance from price on the same side, drawn uniformly.

Report `E[ReactionDisplacement]` and `P(ReactionHit)` per set with block-bootstrap CIs (block = one volume-day) and the contrasts (1)−(4), (1)−(2), (1)−(3). Proceed to a P&L backtest only if (1)−(4) is positive, significant and monotone in WickStrength. If (1) ≈ (2), "fast/decisive" is irrelevant and only "extremum" matters.

Second, trade-specific test: `HitRate(2,1)` for actual setups vs `1/3` and vs placebo levels that were "swept" by construction (any level crossed by `[MinSweepDepth, BreakoutDepth]` and re-crossed).

### 9.3 Backtest design
- Data: ≥ 12 months of trades from the venue you will trade (trigger semantics and prints differ across venues). Robustness: BTCUSDT and one low-cap perp, reported separately.
- **Walk-forward:** 8-week train / 2-week test, rolling; ≥ 12 folds; Stage B fitted per fold on train only.
- **Parameter search:** coarse grid over the six first-order parameters (`PivotMult, BandWidthMult, MinSpikeSize, MinSweepMult, BreakoutMult, MinStrength`), all else at defaults; pick the centre of the best plateau (median of the top 20 % of cells), not the argmax. One-at-a-time sensitivity for the rest. Optimised degrees of freedom ≤ 6.
- **Multiple testing:** deflated Sharpe / reality check across all cells and scenario variants; report the number of configurations tried.

### 9.4 Metrics (per fold and pooled, net of §7.4)
Trades, `HitRate` vs `HitRate_0`, expectancy in bps and in R, profit factor, trade-level and daily Sharpe, max drawdown in R, mean holding time in buckets, `HitRate − BreakevenHitRate`, latency curve, slippage curve (`SlipCoef × {1, 2, 4}`), and breakdowns by WickStrength decile, `SweepDepth/VolUnit` bin, regime, hour-of-day, `SweepCount`, `PriorTouches`, `ReturnSpeed` bin, touch-and-reverse frequency, Target-fill rule (conservative vs optimistic). Plus the mechanism check: aggressor imbalance in the 2 buckets after entry, winners vs losers.

### 9.5 Tick-data pitfalls
- Pivot look-ahead: using `LegExtreme` before `confirmed_at`, or `RetraceFraction` before `RetraceWindow` elapses.
- Bucket look-ahead: any bucket statistic refreshed mid-bucket.
- Filling on the trigger print itself instead of prints after `TriggerTime + Latency`.
- Optimistic no-fill on instant reversal (§7.2); limit Target filled on touch (§7.3).
- Level survivorship: INVALIDATED (broken-out) levels never become trades but **must** be counted in the reaction test, otherwise "levels hold" is circular. Keep the full PivotStore.
- Overlapping trades: one position per symbol in the backtest too.
- Data hygiene: duplicate trade IDs, outages, aggregated vs raw prints, mark-price triggers, funding settlement, tick-size changes.
- Venue mismatch.

---

## 10. Parameter list

| Parameter | Meaning | Range (start) | Set by |
|---|---|---|---|
| `BucketVolume` | volume per bucket | median 60 s volume, daily | construction |
| `UnitWindow` | buckets for VolUnit | 30–120 (60) | fixed |
| `PivotMult` | zigzag reversal, VolUnits | 0.8–2.0 (1.2) | grid |
| `BandWidthMult` | rejection band, VolUnits | 0.3–0.8 (0.5) | grid |
| `MinSpikeSize` | min excursion, VolUnits | 1.0–3.0 (1.5) | grid |
| `MaxSpikeDuration` | max excursion, buckets | 1–6 (3) | sensitivity |
| `MinRejectSpeed` | VolUnit/bucket | 0.3–1.0 (0.5) | sensitivity |
| `MinRejectImbalance` | sell share on rejection | 0.1–0.4 (0.2) | sensitivity |
| `MinRetrace, RetraceWindow` | retrace gate | 0.5–0.8 (0.6), 3–10 (5) | sensitivity |
| `MaxTopDwell` | buckets | 0.25–1 (0.5) | sensitivity |
| `MergeTolerance` | VolUnits | 0.15–0.4 (0.25) | fixed |
| `RankWindow` | pivots for rank normalisation | 300–1000 (500) | fixed |
| `MinStrength` | WickStrength threshold | 30–60 % pass rate (40 %) | grid |
| `AgeScale, MaxAge` | buckets | 100–600 (240), 3·AgeScale | sensitivity |
| `DistanceScale` | VolUnits | 3–10 (5) | fixed |
| `MinSweepMult` | MinSweepDepth, VolUnits | 0.3–1.0 (0.5), floored by 2·RoundTripCost | grid |
| `BreakoutMult` | BreakoutDepth, VolUnits | 1.5–4.0 (2.5) | grid |
| `ArmMode, ArmDistance` | RestEarly / ArmOnApproach | 0.3–1.0 (0.5) | variant |
| `TriggerOffset, StopOffset` | ticks | 0–2 (0), 1 | fixed |
| `TargetMult, StopMult` | multiples of SweepDepth | grid §6.5 (2, 1) | §6.5 |
| `MaxHold` | × sweep-leg duration | 2–8 (4) | variant |
| `MaxUses, MaxSweeps, MaxPending` | reuse / re-sweep / queue | 1–3 (1), 3, 4 | fixed |
| `Latency` | ms | 0–500 curve | measured |
| `SlipTicks, SlipCoef, FillWindow` | slippage model | 1–2, 0.05, 100 ms | live-calibrated |
| `RiskFraction` | equity risk per trade | 0.1–0.5 % | policy |

Only **grid** rows are optimised; the rest are fixed, measured, or sensitivity-checked. Expected ~5–20 trades/day on ETHUSDT (verify).

---

## 11. Entry, exit, sizing (summary)

- **Entry:** fill of the stop-market at the WickLevel (ORDER_ARMED → IN_TRADE). No discretionary confirmation.
- **Exits, priority:** StopLoss at `SweepExtreme + StopOffset`; Target at `WickLevel − TargetMult · SweepDepth`; TimeStop at `MaxHold`; daily kill switch at `DailyLossLimit = 3 ×` per-trade risk (flatten, no new arms until next volume-day).
- **Sizing:** `RiskPerTrade = SweepDepth + E[Slippage]`; `Qty = RiskFraction · Equity / RiskPerTrade × g(WickStrength)`, `g = clip((WickStrength − MinStrength)/(1 − MinStrength), 0.5, 1)`, halved counter-trend; liquidity cap `Qty ≤ 0.5 · Vol100ms` to keep the slippage model linear. Report how often each cap binds.

---

## 12. Weaknesses, failure modes, open questions

**Structural weaknesses**
1. **Cost floor.** `2 · SweepDepth` is often a few bps on a major perp; unless `MinSweepMult` is large or trading is confined to high-VolUnit regimes, `BreakevenHitRate → 1`. The most likely reason the strategy fails.
2. **Adverse selection at the trigger.** A stop-market at the level fills on prints already moving away from us; touch-and-reverse is pure loss. A limit-at-level entry inverts this but tests a *different* hypothesis (bounce, not continuation) — a separate strategy to test once §9.2 shows which effect exists.
3. **Symmetric geometry in a drift.** Counter-trend setups fill more and lose more; the regime rule is a patch.
4. **VolUnit regime dependence.** Levels created in one regime and traded in another are ill-defined; the `[0.4, 2.5]` guard is coarse.
5. **No book data.** Spread, queue position and depth are all estimated from prints; the Target-fill and slippage models are bounds, not measurements, until live fills recalibrate them.
6. **Predictable resting orders.** Under RestEarly the entry stop is exactly the liquidity the pattern exploits; the level is computable by anyone running the same logic.

**Failure modes to monitor live**
- Realised fill worse than `FillPrice` by > 1 tick on average.
- `HitRate` decaying toward 1/3 while §9.2 still passes → the level effect exists, the entry mechanism is wrong.
- Trade count collapsing in low-VolUnit months (cost floor binding).
- Losses clustering around funding times and scheduled news.

**Open questions, in the order the data must answer them**
1. Is `E[ReactionDisplacement]` for WickLevels significantly above random and placebo levels, and monotone in WickStrength? (If not, stop.)
2. Does "fast" matter: WickLevels vs SlowExtremes?
3. Sign of `PriorTouches`.
4. Is `HitRate(2,1)` above `BreakevenHitRate`, and is the optimal `(TargetMult, StopMult)` stable across folds?
5. Should the Target scale with SweepDepth or with VolUnit?
6. RestEarly vs ArmOnApproach: does requiring a violent Reclaim pay for the lost trades?
7. Does post-entry aggressor imbalance separate winners from losers (mechanism check)?
8. Latency curve: where does the edge vanish?
9. Transfer across venues and symbols?

---

## Appendix A — Zigzag and excursion features (pseudocode)

```python
class Zigzag:
    def __init__(self): self.leg_dir=None; self.leg_extreme=None; self.leg_extreme_time=None
    def update(self, t, p, pivot_reversal):
        if self.leg_dir is None:
            self.leg_dir='up'; self.leg_extreme=p; self.leg_extreme_time=t; return None
        if self.leg_dir=='up':
            if p > self.leg_extreme: self.leg_extreme, self.leg_extreme_time = p, t
            elif p <= self.leg_extreme - pivot_reversal:
                piv=('high', self.leg_extreme, self.leg_extreme_time, t)   # confirmed_at = t
                self.leg_dir='down'; self.leg_extreme, self.leg_extreme_time = p, t; return piv
        else:
            if p < self.leg_extreme: self.leg_extreme, self.leg_extreme_time = p, t
            elif p >= self.leg_extreme + pivot_reversal:
                piv=('low', self.leg_extreme, self.leg_extreme_time, t)
                self.leg_dir='up'; self.leg_extreme, self.leg_extreme_time = p, t; return piv
        return None

def excursion_features(ring, pivot_time, pivot_price, band_edge, side):
    # ring: merged events (t,p,q,s) with t <= now ; side=+1 for an upper Spike
    i_piv  = ring.index_at(pivot_time)
    i_in   = ring.last_before(i_piv,  lambda e: side*(e.p - band_edge) <= 0)
    i_out  = ring.first_after(i_piv,  lambda e: side*(e.p - band_edge) <= 0)   # None until observed → wait
    if i_out is None: return None
    approach, rejection = ring[i_in:i_piv+1], ring[i_piv:i_out+1]
    approach_vol = sum(e.q for e in approach);  reject_vol = sum(e.q for e in rejection)
    reject_imbalance   = -side * sum(e.s*e.q for e in rejection) / reject_vol
    approach_imbalance =  side * sum(e.s*e.q for e in approach)  / approach_vol
    reject_speed   = abs(pivot_price - band_edge) / max(reject_vol, 1e-9)     # scale by BucketVolume/VolUnit outside
    max_print_gap  = max(abs(b.p - a.p) for a, b in zip(rejection, rejection[1:]))
    ...
```
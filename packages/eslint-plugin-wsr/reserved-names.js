// Allow-list built from the full Spec §1.5 glossary "Code" column (strategy.md
// §0, §2-§9 identifiers). Every name here must be used verbatim in code;
// wsr/reserved-identifiers flags a declared identifier that matches one of
// these case-insensitively but not exactly.
export const RESERVED_NAMES = [
  // §0 naming map
  'Spike', 'WickLevel', 'SweepExtreme', 'SweepDepth', 'Target', 'WickStrength', 'VolUnit', 'Reclaim',
  // §2.1 trade stream
  't', 'p', 'q', 's', 'Tick',
  // §2.1 SpreadEst
  'SpreadEst', 'SpreadEst_t',
  // §2.2 buckets
  'Vol', 'BucketVolume', 'High_k', 'Low_k', 'Imbalance_k', 'Vwap_k', 'Count_k', 'WallDuration_k',
  // §2.3 VolUnit dynamics
  'VolUnit_t', 'UnitWindow', 'RVol', 'VolUnit_created', 'VolUnit_now',
  // §2.4 side
  'Side',
  // §3.1 zigzag
  'LegDir', 'LegExtreme', 'LegExtremeTime', 'PivotReversal', 'PivotMult', 'PivotHigh', 'PivotLow',
  'confirmed_at', 'MergeTolerance', 'PriorTouches',
  // §3.2 excursion features
  'BandEdge', 'BandWidthMult', 'EnterTime', 'ExitTime', 'Approach', 'Rejection', 'Anchor', 'AnchorWindow',
  'SpikeSize', 'ApproachVolume', 'RejectVolume', 'ApproachDuration', 'RejectDuration', 'ApproachSpeed',
  'RejectSpeed', 'SpeedAsymmetry', 'ApproachImbalance', 'RejectImbalance', 'VolumeBurst', 'TopDwell',
  'RetraceFraction', 'MaxTradeSize', 'MaxAggressorRun', 'MaxPrintGap',
  // §3.3 spike gates
  'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'MinSpikeSize', 'MaxSpikeDuration', 'MinRejectSpeed',
  'MinRejectImbalance', 'MinRetrace', 'RetraceWindow', 'MaxTopDwell', 'TopBandMult', 'SlowExtreme',
  // §4 WickStrength
  'RankWindow', 'WickStrength_0', 'MinStrength',
  // §5 distance / relevance / ageing
  'Age', 'Distance', 'Relevance', 'AgeScale', 'DistanceScale', 'MaxAge', 'MaxUses',
  // §6 sweep / entry / exit
  'MinSweepDepth', 'MinSweepMult', 'BreakoutDepth', 'BreakoutMult', 'SweepRunningMax', 'ArmMode',
  'ArmDistance', 'ReturnSpeed', 'MinReturnSpeed', 'TriggerOffset', 'StopLoss', 'StopOffset', 'TargetMult',
  'StopMult', 'TimeStop', 'MaxHold', 'MFE', 'MAE', 'HitRate', 'HitRate_0', 'Expectancy', 'TargetUnits',
  // §7 execution model
  'TriggerTime', 'SendTime', 'FillTime', 'ObsLatency', 'DecisionLatency', 'ExchangeLatency', 'Latency',
  'FillPrice', 'FillWindow', 'Slippage', 'SlipTicks', 'SlipCoef', 'Vol100ms', 'QueueProxy', 'RoundTripCost',
  'BreakevenHitRate', 'TakerFee', 'MakerFee', 'MaxPending',
  // §8 scenario / regime
  'TrendEfficiency', 'VolRatio', 'RegimeWindow', 'SweepCount', 'MaxSweeps', 'ReturnImbalance', 'Burst',
  'UseCount',
  // §9.1 data structures / states
  'TradeRing', 'BucketBuilder', 'Zigzag', 'PivotStore', 'LevelBook',
  'PIVOT_PENDING', 'WICK_ACTIVE', 'SWEEPING', 'SWEEP_CONFIRMED', 'ORDER_ARMED', 'IN_TRADE', 'CLOSED',
  'INVALIDATED', 'EXPIRED', 'CANCELLED',
  // §9.2 reaction test
  'ApproachTol', 'ReactionWindow', 'ReactionDisplacement', 'ReactionHit',
  // §11 sizing
  'RiskFraction', 'RiskPerTrade', 'Qty', 'g', 'DailyLossLimit',
];

export const RESERVED_NAMES_LOWERCASE = new Map(RESERVED_NAMES.map((name) => [name.toLowerCase(), name]));

// §3.0 primitive type aliases (Ms, Ticks, Lots, Side, Buckets) and the two
// union/kind types are reserved only as *type* names. A field or variable
// holding a value of one of these types legitimately uses the plain lowercase
// word (e.g. `readonly side: Side` in the §3.0 Pivot interface, ported
// verbatim) and must not be flagged as a mis-cased reference to the type.
export const TYPE_ONLY_RESERVED_NAMES = new Set(['Ms', 'Ticks', 'Lots', 'Side', 'Buckets', 'PivotKind']);

// Spec §8.2 introduces camelCase RunConfig variant-toggle keys (ageClock,
// stopMode, targetMode, strengthModel, timeStop, ...); these are engineering
// names of this document, not strategy.md identifiers, even where one of
// them (`timeStop`) happens to share letters with the reserved TimeStop exit
// mechanism (§6/§6.4) it switches on/off. Exempt only that documented case.
export const VALUE_EXEMPT_NAMES = new Set(['timeStop']);

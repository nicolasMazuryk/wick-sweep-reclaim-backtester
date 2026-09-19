// Spec §3.7.5: MinStrength is configured as a pass rate; the realised
// threshold is the (1 − passRate) quantile of WickStrength over gated Spikes
// (nearest rank ceil(p·n), A-52), so at least passRate of them pass
// `WickStrength ≥ MinStrength`. passRate = 1 ⇒ −∞ (every defined score
// passes, Spec §11.3). Non-finite scores (below MinRankPivots) are ignored;
// no finite score and passRate < 1 ⇒ NaN (nothing can arm).
export function minStrengthForPassRate(scores: Iterable<number>, passRate: number): number {
  if (!(passRate > 0 && passRate <= 1)) throw new Error(`minStrengthForPassRate: passRate ${passRate} outside (0, 1]`);
  if (passRate === 1) return -Infinity;
  const finite: number[] = [];
  for (const x of scores) if (Number.isFinite(x)) finite.push(x);
  if (finite.length === 0) return NaN;
  finite.sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((1 - passRate) * finite.length - 1e-9));
  return finite[rank - 1]!;
}

// Venue registry (Spec §2.1): adding a venue = one file in this directory
// plus one row here. Nothing outside this directory names a venue.
import { VENUE_IDS } from '@wsr/core';
import { createVenueAdapter, type AdapterDeps, type ArchiveVenueAdapter, type VenueDefinition } from '../adapter.js';
import type { VenueId } from '../venue.js';
import { binance } from './binance.js';
import { bitget } from './bitget.js';
import { bybit } from './bybit.js';
import { gate } from './gate.js';
import { kucoin } from './kucoin.js';
import { okx } from './okx.js';

export const VENUES: Readonly<Record<VenueId, VenueDefinition>> = { binance, bybit, okx, bitget, gate, kucoin };

// Spec §12.1 step-10 order (Binance first; then Bybit, OKX, Gate; then
// Bitget, KuCoin) — also the default `--venue` order.
export const VENUE_ORDER: readonly VenueId[] = ['binance', 'bybit', 'okx', 'gate', 'bitget', 'kucoin'];

export function isVenueId(value: string): value is VenueId {
  return (VENUE_IDS as readonly string[]).includes(value);
}

export function getVenueAdapter(id: VenueId, deps: AdapterDeps): ArchiveVenueAdapter {
  return createVenueAdapter(VENUES[id], deps);
}

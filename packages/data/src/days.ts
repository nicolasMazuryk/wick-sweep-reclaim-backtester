import type { Ms } from '@wsr/core';
import type { UtcDay } from './venue.js';

export const MS_PER_DAY = 86_400_000;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

// 'YYYY-MM-DD' (Spec §2.5 partition file name, §2.6.2 HygieneReport.day).
export function formatDay(day: UtcDay): string {
  return `${pad(day.y, 4)}-${pad(day.m, 2)}-${pad(day.d, 2)}`;
}

// 'YYYYMMDD' (venue archive folder/file names).
export function formatDayCompact(day: UtcDay): string {
  return `${pad(day.y, 4)}${pad(day.m, 2)}${pad(day.d, 2)}`;
}

// 'YYYYMM' (monthly archives).
export function formatMonthCompact(day: UtcDay): string {
  return `${pad(day.y, 4)}${pad(day.m, 2)}`;
}

export function parseDay(text: string): UtcDay {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) {
    throw new Error(`invalid day '${text}': expected YYYY-MM-DD`);
  }
  const day = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  if (formatDay(dayFromMs(dayStartMs(day))) !== text) {
    throw new Error(`invalid day '${text}': not a calendar date`);
  }
  return day;
}

export function dayStartMs(day: UtcDay): Ms {
  return Date.UTC(day.y, day.m - 1, day.d);
}

// Exclusive end of the UTC day.
export function dayEndMs(day: UtcDay): Ms {
  return dayStartMs(day) + MS_PER_DAY;
}

export function dayFromMs(t: Ms): UtcDay {
  const date = new Date(t);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

export function addDays(day: UtcDay, n: number): UtcDay {
  return dayFromMs(dayStartMs(day) + n * MS_PER_DAY);
}

export function compareDays(a: UtcDay, b: UtcDay): number {
  return dayStartMs(a) - dayStartMs(b);
}

// Every UTC day in [from, to], ascending; empty when from > to.
export function eachDay(from: UtcDay, to: UtcDay): UtcDay[] {
  const days: UtcDay[] = [];
  for (let t = dayStartMs(from); t <= dayStartMs(to); t += MS_PER_DAY) {
    days.push(dayFromMs(t));
  }
  return days;
}

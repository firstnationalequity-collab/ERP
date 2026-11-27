// How a spec test's limit is printed (screens, CoA, OOS). No business rules here.
import { Decimal } from 'decimal.js';
import type { SpecTestRow } from './specs.repo';

export function limitText(t: SpecTestRow): string {
  if (t.resultType === 'TEXT') return t.textLimit ?? '';
  const unit = t.unit ? ` ${t.unit}` : '';
  const n = (v: string) => new Decimal(v).toString();
  if (t.minValue !== null && t.maxValue !== null) return `${n(t.minValue)} – ${n(t.maxValue)}${unit}`;
  if (t.minValue !== null) return `≥ ${n(t.minValue)}${unit}`;
  if (t.maxValue !== null) return `≤ ${n(t.maxValue)}${unit}`;
  return 'Report';
}

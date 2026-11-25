// Procurement seed (M3 task 4, 0029): the landed-cost charge types the owner listed (Q21, 2026-11-19).
// Capitalised (into the lot cost): customs duty, additional customs duty, regulatory duty, freight, insurance,
// clearing/handling. Not capitalised: import-stage sales tax (input tax) and income tax collected at import (advance
// tax). Codes and the default basis (VALUE) are agent defaults. Idempotent: a type is added only when its code is
// missing, so Finance's changes are never overwritten.
import type { LandedCostBasis, LandedCostTaxRole } from '@albert/shared';
import type { Tx } from '../client';
import { landedCostTypes } from '../schema/purch';

export const DEFAULT_LANDED_COST_TYPES: readonly {
  code: string;
  name: string;
  capitalise: boolean;
  taxRole: LandedCostTaxRole | null;
  isDuty: boolean;
  defaultBasis: LandedCostBasis | null;
}[] = [
  { code: 'CD', name: 'Customs duty', capitalise: true, taxRole: null, isDuty: true, defaultBasis: 'VALUE' },
  { code: 'ACD', name: 'Additional customs duty', capitalise: true, taxRole: null, isDuty: true, defaultBasis: 'VALUE' },
  { code: 'RD', name: 'Regulatory duty', capitalise: true, taxRole: null, isDuty: true, defaultBasis: 'VALUE' },
  { code: 'FREIGHT', name: 'Freight', capitalise: true, taxRole: null, isDuty: false, defaultBasis: 'VALUE' },
  { code: 'INSURANCE', name: 'Insurance', capitalise: true, taxRole: null, isDuty: false, defaultBasis: 'VALUE' },
  { code: 'CLEARING', name: 'Clearing and handling', capitalise: true, taxRole: null, isDuty: false, defaultBasis: 'VALUE' },
  { code: 'IMPORT_ST', name: 'Sales tax at import', capitalise: false, taxRole: 'INPUT_TAX', isDuty: false, defaultBasis: null },
  { code: 'IMPORT_IT', name: 'Income tax collected at import', capitalise: false, taxRole: 'ADVANCE_TAX', isDuty: false, defaultBasis: null },
];

export async function seedLandedCostTypes(tx: Tx): Promise<string[]> {
  const existing = new Set((await tx.select({ code: landedCostTypes.code }).from(landedCostTypes)).map((t) => t.code));
  const created: string[] = [];
  for (const t of DEFAULT_LANDED_COST_TYPES) {
    if (existing.has(t.code)) continue;
    await tx.insert(landedCostTypes).values(t);
    created.push(t.code);
  }
  return created;
}

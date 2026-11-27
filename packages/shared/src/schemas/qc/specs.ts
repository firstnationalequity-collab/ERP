// QC specifications API (/api/v1/qc/specs): requests (Zod) and responses (DTOs). M4 task 1.
// Rules mirror apps/api/src/db/migrations/0034_qc_specs.sql. Limits travel as decimal strings (rule 10).
import { z } from 'zod';
import { QcResultType, QcSpecStatus } from '../../enums';
import { ESignRequest } from '../core/esign';

const id = z.string().regex(/^\d+$/, 'Invalid id');
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500);

/** A spec limit NUMERIC(18,6): may be negative (e.g. optical rotation), up to 12 digits and 6 decimals. */
export const specLimit = z
  .string()
  .trim()
  .regex(/^-?\d{1,12}(\.\d{1,6})?$/, 'Limit: a number with up to 12 digits and 6 decimals');

/** Compare two decimal strings without JS floats: -1, 0 or 1. */
export function compareDecimal(a: string, b: string): number {
  const neg = (s: string) => s.startsWith('-');
  const norm = (s: string) => {
    const [i = '0', f = ''] = s.replace(/^-/, '').split('.');
    return { i: i.replace(/^0+(?=\d)/, ''), f: f.replace(/0+$/, '') };
  };
  const zero = (s: string) => /^-?0*(\.0*)?$/.test(s);
  const sa = zero(a) ? 0 : neg(a) ? -1 : 1;
  const sb = zero(b) ? 0 : neg(b) ? -1 : 1;
  if (sa !== sb) return sa < sb ? -1 : 1;
  if (sa === 0) return 0;
  const x = norm(a);
  const y = norm(b);
  let mag = 0;
  if (x.i.length !== y.i.length) mag = x.i.length < y.i.length ? -1 : 1;
  else if (x.i !== y.i) mag = x.i < y.i ? -1 : 1;
  else {
    const len = Math.max(x.f.length, y.f.length);
    const fx = x.f.padEnd(len, '0');
    const fy = y.f.padEnd(len, '0');
    mag = fx === fy ? 0 : fx < fy ? -1 : 1;
  }
  return sa * mag;
}

export const SpecTestInput = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(200),
    method: optText(200),
    resultType: z.enum(QcResultType),
    minValue: specLimit.nullable().optional(),
    maxValue: specLimit.nullable().optional(),
    textLimit: optText(500),
    unit: optText(30),
    isAssay: z.boolean().default(false),
    isWater: z.boolean().default(false),
  })
  .strict()
  .superRefine((t, ctx) => {
    const issue = (message: string, path: string) => ctx.addIssue({ code: 'custom', message, path: [path] });
    if (t.resultType === 'NUMERIC') {
      if (!t.minValue && !t.maxValue) issue('A numeric test needs a minimum or a maximum', 'minValue');
      if (t.textLimit) issue('A numeric test has no text limit', 'textLimit');
      if (t.minValue && t.maxValue && compareDecimal(t.minValue, t.maxValue) > 0) issue('The minimum is above the maximum', 'maxValue');
    } else {
      if (!t.textLimit) issue('A text test needs its limit (e.g. "Complies")', 'textLimit');
      if (t.minValue || t.maxValue) issue('A text test has no numeric limits', 'minValue');
      if (t.isAssay || t.isWater) issue('Assay and water tests are numeric', 'resultType');
    }
    if (t.isAssay && t.isWater) issue('A test is the assay or the water test, not both', 'isWater');
  });
export type SpecTestInput = z.infer<typeof SpecTestInput>;

export const CreateSpecRequest = z.object({ itemId: id, reference: optText(200), notes: optText(2000) }).strict();
export type CreateSpecRequest = z.infer<typeof CreateSpecRequest>;
export const UpdateSpecRequest = z.object({ reference: optText(200), notes: optText(2000) }).strict();
export type UpdateSpecRequest = z.infer<typeof UpdateSpecRequest>;
export const SetSpecTestsRequest = z
  .object({ tests: z.array(SpecTestInput).max(100) })
  .strict()
  .superRefine((b, ctx) => {
    if (b.tests.filter((t) => t.isAssay).length > 1) ctx.addIssue({ code: 'custom', message: 'One assay test at most', path: ['tests'] });
    if (b.tests.filter((t) => t.isWater).length > 1) ctx.addIssue({ code: 'custom', message: 'One water test at most', path: ['tests'] });
  });
export type SetSpecTestsRequest = z.infer<typeof SetSpecTestsRequest>;
export const ApproveSpecRequest = z.object({ signature: ESignRequest }).strict();
export type ApproveSpecRequest = z.infer<typeof ApproveSpecRequest>;
export const RejectSpecRequest = z.object({ reason }).strict();
export type RejectSpecRequest = z.infer<typeof RejectSpecRequest>;

export const SpecListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
  status: z.enum(QcSpecStatus).optional(),
  itemId: id.optional(),
});
export type SpecListQuery = z.infer<typeof SpecListQuery>;

export interface SpecTestDto {
  id: string;
  seq: number;
  name: string;
  method: string | null;
  resultType: QcResultType;
  minValue: string | null;
  maxValue: string | null;
  textLimit: string | null;
  unit: string | null;
  isAssay: boolean;
  isWater: boolean;
}

export interface SpecDto {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  itemType: string;
  version: number;
  reference: string | null;
  notes: string | null;
  status: QcSpecStatus;
  submittedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  /** Display names of createdBy / submittedBy / approvedBy. */
  userNames: Record<string, string>;
  tests?: SpecTestDto[];
}

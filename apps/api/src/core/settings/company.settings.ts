// Company details printed on generated documents (CoA header now; invoices etc. later). Owner 2026-11-27: read from
// settings; PLACEHOLDER defaults until Management gives the real details (docs/verification-list.md, Management).
//   company.name             legal name
//   company.address          registered / plant address (may hold line breaks)
//   company.drap_licence_no  DRAP drug manufacturing licence number
//   company.logo             id of a PNG / JPEG uploaded as an attachment of the company (core.companies/<company id>,
//                            key core.settings.manage), or '' for none
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Queryable } from '../../db/client';
import { companies } from '../../db/schema/core';
import { AppError } from '../errors';
import { readStoredFile, registerAttachmentTarget } from '../attachments/attachments.service';
import { getSetting, registerSetting } from './app-settings.service';

export const COMPANY_TABLE = 'core.companies';
export const COMPANY_NAME = 'company.name';
export const COMPANY_ADDRESS = 'company.address';
export const COMPANY_DRAP_LICENCE = 'company.drap_licence_no';
export const COMPANY_LOGO = 'company.logo';

registerSetting({
  key: COMPANY_NAME,
  description: 'Company legal name printed on documents (CoA header)',
  schema: z.string().trim().min(1).max(200),
  defaultValue: 'Albert Pharmaceuticals',
});
registerSetting({
  key: COMPANY_ADDRESS,
  description: 'Company address printed on documents (CoA header)',
  schema: z.string().trim().min(1).max(500),
  defaultValue: '[Company address — set in Settings: company.address]',
});
registerSetting({
  key: COMPANY_DRAP_LICENCE,
  description: 'DRAP drug manufacturing licence number printed on documents (CoA header)',
  schema: z.string().trim().min(1).max(100),
  defaultValue: '[DRAP licence no. — set in Settings: company.drap_licence_no]',
});
registerSetting({
  key: COMPANY_LOGO,
  description: 'Company logo on documents: id of a PNG / JPEG attached to the company (core.companies), or empty for none',
  // A digit-only JSON string reads back from jsonb as a number, so both are accepted and normalised to the id string.
  // Empty = no logo (a setting is never null: core.settings.value is NOT NULL).
  schema: z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().regex(/^(\d+)?$/, 'An attachment id, or empty for no logo')) as z.ZodType<string>,
  defaultValue: '',
});

registerAttachmentTarget(COMPANY_TABLE, {
  readPermission: 'core.settings.manage',
  writePermission: 'core.settings.manage',
  gmp: false, // the logo is branding, not GMP evidence
  exists: async (q, recordId) => (await q.select({ id: companies.id }).from(companies).where(eq(companies.id, recordId))).length > 0,
});

export interface CompanyHeader {
  name: string;
  address: string;
  drapLicenceNo: string;
  /** The logo as a data URL (PNG / JPEG), checked against its SHA-256; null when none is set. */
  logo: string | null;
}

export async function companyHeader(q: Queryable, companyId: string): Promise<CompanyHeader> {
  const logoId = await getSetting<string>(q, companyId, COMPANY_LOGO);
  let logo: string | null = null;
  if (logoId !== '') {
    const file = await readStoredFile(q, companyId, logoId);
    if (file.recordTable !== COMPANY_TABLE || file.recordId !== companyId || file.voided || !['image/png', 'image/jpeg'].includes(file.contentType)) {
      throw new AppError('VALIDATION_FAILED', `Setting ${COMPANY_LOGO} must name a PNG or JPEG attached to this company and not voided`, { setting: COMPANY_LOGO });
    }
    logo = `data:${file.contentType};base64,${file.bytes.toString('base64')}`;
  }
  return {
    name: await getSetting<string>(q, companyId, COMPANY_NAME),
    address: await getSetting<string>(q, companyId, COMPANY_ADDRESS),
    drapLicenceNo: await getSetting<string>(q, companyId, COMPANY_DRAP_LICENCE),
    logo,
  };
}

// Customers (+ addresses) and vendors (decisions M2 Q5 and 18-11-2026 "editing active parties").
//  - Created DRAFT through core/transition; DRAFT → ACTIVE by the approve key; the activator is neither the
//    creator nor the last editor of the draft (SEGREGATION_OF_DUTIES; DB guard 0009 too).
//  - ACTIVE ⇄ INACTIVE by the approve key; deactivation needs a reason.
//  - Edits: free while DRAFT. After that, changing a sensitive field (tax ids, credit limit, toll flag; vendor
//    bank, currency, foreign/country) needs a countersign in the same request by a holder of the approve key
//    who is not the editor; the signature is stored on the record (DB guard 0009 checks it at commit).
import { Decimal } from 'decimal.js';
import { eq } from 'drizzle-orm';
import {
  CustomerSensitiveFields,
  PartyStatus,
  VendorSensitiveFields,
  type AddressDto,
  type CreateAddressRequest,
  type CreateCustomerRequest,
  type CreateVendorRequest,
  type CustomerDto,
  type MasterListQuery,
  type Page,
  type PermissionKey,
  type UpdateAddressRequest,
  type UpdateCustomerRequest,
  type UpdateVendorRequest,
  type VendorDto,
  type WitnessSignRequest,
} from '@albert/shared';
import { db, withTransaction, type Tx } from '../../db/client';
import { customers, vendors } from '../../db/schema/masters';
import { AppError } from '../../core/errors';
import { txContext, type AuthContext, type RequestMeta } from '../../core/auth/auth.service';
import { permissionKeysForUser } from '../../core/auth/auth.repo';
import { recordSignature, verifyWitness, type SignatureProof } from '../../core/esign/esign.service';
import { defineTransitions, recordInitialStatus, transition } from '../../core/transition/transition';
import * as repo from './masters.repo';
import { found, page, paging, sent, stamped } from './common';

// ---------------------------------------------------------------- status maps (rule 7)

function partyMoves(entityTable: 'master.customers' | 'master.vendors', manage: PermissionKey, approve: PermissionKey) {
  return defineTransitions<PartyStatus>({
    entityTable,
    statuses: PartyStatus,
    moves: [
      { from: null, to: 'DRAFT', permission: manage },
      { from: 'DRAFT', to: 'ACTIVE', permission: approve },
      { from: 'ACTIVE', to: 'INACTIVE', permission: approve, reasonRequired: true },
      { from: 'INACTIVE', to: 'ACTIVE', permission: approve, reasonRequired: true },
    ],
  });
}
export const CustomerMoves = partyMoves('master.customers', 'master.customer.manage', 'master.customer.approve');
export const VendorMoves = partyMoves('master.vendors', 'master.vendor.manage', 'master.vendor.approve');

type Kind = 'customer' | 'vendor';
const KIND = {
  customer: { table: 'master.customers', label: 'Customer', approveKey: 'master.customer.approve', moves: CustomerMoves },
  vendor: { table: 'master.vendors', label: 'Vendor', approveKey: 'master.vendor.approve', moves: VendorMoves },
} as const;

// ---------------------------------------------------------------- countersign

/** Verify the countersigner's password before the business transaction, so failures are counted. */
async function verifyCountersign(
  auth: AuthContext,
  countersign: WitnessSignRequest | undefined,
  meta: RequestMeta,
): Promise<SignatureProof | undefined> {
  if (!countersign) return undefined;
  if (countersign.meaning !== 'APPROVED') throw new AppError('ESIGN_FAILED', 'A countersign must have the meaning APPROVED');
  return verifyWitness(auth, countersign, meta);
}

async function applyCountersign(
  tx: Tx,
  kind: Kind,
  id: string,
  proof: SignatureProof | undefined,
  changedSensitive: string[],
): Promise<void> {
  const k = KIND[kind];
  if (!proof) {
    throw new AppError(
      'COUNTERSIGN_REQUIRED',
      `Changing ${changedSensitive.join(', ')} of an active ${kind} needs a countersign by a holder of ${k.approveKey}`,
      { fields: changedSensitive, permission: k.approveKey },
    );
  }
  const keys = await permissionKeysForUser(tx, proof.userId);
  if (!keys.includes(k.approveKey)) {
    throw new AppError('FORBIDDEN', `The countersigner does not hold ${k.approveKey}`, { permission: k.approveKey });
  }
  await recordSignature(tx, proof, { table: k.table, id }, ['APPROVED']);
}

/** Which of the sensitive fields really change (money compared as decimals, not text). */
function changedSensitive(current: Record<string, unknown>, changes: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.filter((f) => {
    if (!(f in changes)) return false;
    const next = changes[f];
    const prev = current[f];
    if (f === 'creditLimit' && typeof next === 'string' && typeof prev === 'string') return !new Decimal(next).equals(prev);
    return (next ?? null) !== (prev ?? null);
  });
}

// ---------------------------------------------------------------- status actions (shared)

/** DRAFT → ACTIVE, ACTIVE → INACTIVE, INACTIVE → ACTIVE. */
export async function changePartyStatus(
  auth: AuthContext,
  kind: Kind,
  id: string,
  to: 'ACTIVE' | 'INACTIVE',
  reason: string | undefined,
): Promise<void> {
  const k = KIND[kind];
  await withTransaction(txContext(auth, reason ? `${k.label}: ${reason}` : undefined), async (tx) => {
    const row = found(kind === 'customer' ? await repo.findCustomer(tx, auth.companyId, id, true) : await repo.findVendor(tx, auth.companyId, id, true), k.label);
    if (row.status === 'DRAFT' && to === 'ACTIVE' && (row.createdBy === auth.userId || row.updatedBy === auth.userId)) {
      throw new AppError('SEGREGATION_OF_DUTIES', `You created or last edited this ${kind}; another person must activate it`);
    }
    await transition(tx, k.moves, { entityId: id, to, actor: auth, reason });
  });
}

// ---------------------------------------------------------------- customers

export async function listCustomers(auth: AuthContext, query: MasterListQuery): Promise<Page<CustomerDto>> {
  const status = query.status && (PartyStatus as readonly string[]).includes(query.status) ? (query.status as PartyStatus) : undefined;
  const where = repo.listWhere(
    customers.companyId,
    { search: query.search, searchCols: [customers.code, customers.name, customers.ntn, customers.cnic], extra: [status ? eq(customers.status, status) : undefined] },
    auth.companyId,
  );
  const rows = await repo.listCustomers(db, where, paging(query));
  return page(rows.map(stamped), await repo.countWhere(db, customers, where), query);
}

export async function getCustomer(auth: AuthContext, id: string): Promise<CustomerDto> {
  return stamped(found(await repo.findCustomer(db, auth.companyId, id), 'Customer'));
}

export async function createCustomer(auth: AuthContext, input: CreateCustomerRequest): Promise<CustomerDto> {
  const row = await withTransaction(txContext(auth), async (tx) => {
    const created = await repo.insertCustomer(tx, { ...input, status: 'DRAFT' });
    await recordInitialStatus(tx, CustomerMoves, { entityId: created.id, to: 'DRAFT', actor: auth });
    return created;
  });
  return stamped(row);
}

export async function updateCustomer(auth: AuthContext, id: string, input: UpdateCustomerRequest, meta: RequestMeta): Promise<CustomerDto> {
  const { countersign, ...fields } = input;
  const proof = await verifyCountersign(auth, countersign, meta);
  await withTransaction(txContext(auth, countersign ? `countersigned: ${countersign.reason}` : undefined), async (tx) => {
    const current = found(await repo.findCustomer(tx, auth.companyId, id, true), 'Customer');
    const changes = sent(fields);
    const next = { ...current, ...changes };
    if (!next.ntn && !next.cnic) throw new AppError('VALIDATION_FAILED', 'NTN or CNIC is required', { field: 'ntn' });
    const sensitive = changedSensitive(current, changes, CustomerSensitiveFields);
    await repo.updateCustomer(tx, id, changes);
    if (current.status !== 'DRAFT' && sensitive.length > 0) await applyCountersign(tx, 'customer', id, proof, sensitive);
  });
  return getCustomer(auth, id);
}

// ---------------------------------------------------------------- customer addresses (master.customer.manage)

export async function listAddresses(auth: AuthContext, customerId: string): Promise<AddressDto[]> {
  found(await repo.findCustomer(db, auth.companyId, customerId), 'Customer');
  return (await repo.listAddresses(db, auth.companyId, customerId)).map(stamped);
}

export async function createAddress(auth: AuthContext, customerId: string, input: CreateAddressRequest): Promise<AddressDto> {
  const row = await withTransaction(txContext(auth), async (tx) => {
    found(await repo.findCustomer(tx, auth.companyId, customerId, true), 'Customer');
    if (input.isDefault) await repo.clearDefaultAddress(tx, customerId, input.type);
    return repo.insertAddress(tx, { customerId, ...input });
  });
  return stamped(row);
}

export async function updateAddress(auth: AuthContext, id: string, input: UpdateAddressRequest): Promise<AddressDto> {
  await withTransaction(txContext(auth), async (tx) => {
    const current = found(await repo.findAddress(tx, auth.companyId, id, true), 'Customer address');
    if (!current.isActive) throw new AppError('VALIDATION_FAILED', 'The address is not active');
    const changes = sent(input);
    const type = changes.type ?? current.type;
    if (changes.isDefault ?? (current.isDefault && changes.type !== undefined)) {
      await repo.clearDefaultAddress(tx, current.customerId, type, id);
    }
    await repo.updateAddress(tx, id, changes);
  });
  return stamped(found(await repo.findAddress(db, auth.companyId, id), 'Customer address'));
}

// ---------------------------------------------------------------- vendors

function assertVendorIdentity(v: { isForeign: boolean; ntn: string | null; cnic: string | null; country: string }): void {
  if (!v.isForeign && !v.ntn && !v.cnic) throw new AppError('VALIDATION_FAILED', 'NTN or CNIC is required for a local vendor', { field: 'ntn' });
  if (v.isForeign && v.country === 'PK') throw new AppError('VALIDATION_FAILED', 'A foreign vendor needs its country (not PK)', { field: 'country' });
}

export async function listVendors(auth: AuthContext, query: MasterListQuery): Promise<Page<VendorDto>> {
  const status = query.status && (PartyStatus as readonly string[]).includes(query.status) ? (query.status as PartyStatus) : undefined;
  const where = repo.listWhere(
    vendors.companyId,
    { search: query.search, searchCols: [vendors.code, vendors.name, vendors.ntn, vendors.cnic], extra: [status ? eq(vendors.status, status) : undefined] },
    auth.companyId,
  );
  const rows = await repo.listVendors(db, where, paging(query));
  return page(rows.map(stamped), await repo.countWhere(db, vendors, where), query);
}

export async function getVendor(auth: AuthContext, id: string): Promise<VendorDto> {
  return stamped(found(await repo.findVendor(db, auth.companyId, id), 'Vendor'));
}

export async function createVendor(auth: AuthContext, input: CreateVendorRequest): Promise<VendorDto> {
  const row = await withTransaction(txContext(auth), async (tx) => {
    const created = await repo.insertVendor(tx, { ...input, status: 'DRAFT' });
    await recordInitialStatus(tx, VendorMoves, { entityId: created.id, to: 'DRAFT', actor: auth });
    return created;
  });
  return stamped(row);
}

export async function updateVendor(auth: AuthContext, id: string, input: UpdateVendorRequest, meta: RequestMeta): Promise<VendorDto> {
  const { countersign, ...fields } = input;
  const proof = await verifyCountersign(auth, countersign, meta);
  await withTransaction(txContext(auth, countersign ? `countersigned: ${countersign.reason}` : undefined), async (tx) => {
    const current = found(await repo.findVendor(tx, auth.companyId, id, true), 'Vendor');
    const changes = sent(fields);
    assertVendorIdentity({ ...current, ...changes });
    const sensitive = changedSensitive(current, changes, VendorSensitiveFields);
    await repo.updateVendor(tx, id, changes);
    if (current.status !== 'DRAFT' && sensitive.length > 0) await applyCountersign(tx, 'vendor', id, proof, sensitive);
  });
  return getVendor(auth, id);
}

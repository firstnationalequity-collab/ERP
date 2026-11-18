// Products (decision M2 Q1): an FG item with its regulatory data, managed with master.product.manage.
// Setting or changing registration no., artwork version or quality-agreement date needs, in the same request,
// a countersign by a holder of qa.product.countersign who is not the editor. The signature is stored on the
// product in the same transaction (DB guard master.require_product_countersign checks it at commit).
import { eq } from 'drizzle-orm';
import {
  ProductRegulatedFields,
  type CreateProductRequest,
  type MasterListQuery,
  type Page,
  type PermissionKey,
  type ProductDto,
  type UpdateProductRequest,
  type WitnessSignRequest,
} from '@albert/shared';
import { db, withTransaction, type Tx } from '../../db/client';
import { products } from '../../db/schema/masters';
import { AppError } from '../../core/errors';
import { txContext, type AuthContext, type RequestMeta } from '../../core/auth/auth.service';
import { permissionKeysForUser } from '../../core/auth/auth.repo';
import { recordSignature, verifyWitness, type SignatureProof } from '../../core/esign/esign.service';
import * as repo from './masters.repo';
import { assertReference, found, page, paging, sent, stamped } from './common';

const COUNTERSIGN_KEY: PermissionKey = 'qa.product.countersign';

function toDto(row: repo.ProductListRow): ProductDto {
  return { ...stamped(row.p), itemCode: row.itemCode, itemName: row.itemName };
}

async function verifyCountersign(auth: AuthContext, cs: WitnessSignRequest | undefined, meta: RequestMeta): Promise<SignatureProof | undefined> {
  if (!cs) return undefined;
  if (cs.meaning !== 'APPROVED') throw new AppError('ESIGN_FAILED', 'A countersign must have the meaning APPROVED');
  return verifyWitness(auth, cs, meta);
}

async function applyCountersign(tx: Tx, productId: string, proof: SignatureProof | undefined, fields: string[]): Promise<void> {
  if (!proof) {
    throw new AppError('COUNTERSIGN_REQUIRED', `Changing ${fields.join(', ')} needs a QA countersign (${COUNTERSIGN_KEY})`, {
      fields,
      permission: COUNTERSIGN_KEY,
    });
  }
  if (!(await permissionKeysForUser(tx, proof.userId)).includes(COUNTERSIGN_KEY)) {
    throw new AppError('FORBIDDEN', `The countersigner does not hold ${COUNTERSIGN_KEY}`, { permission: COUNTERSIGN_KEY });
  }
  await recordSignature(tx, proof, { table: 'master.products', id: productId }, ['APPROVED']);
}

export async function listProducts(auth: AuthContext, query: MasterListQuery): Promise<Page<ProductDto>> {
  const where = repo.listWhere(
    products.companyId,
    {
      ...query,
      searchCols: [products.registrationNo],
      activeCol: products.isActive,
      extra: [query.customerId ? eq(products.customerId, query.customerId) : undefined],
    },
    auth.companyId,
  );
  const rows = await repo.listProducts(db, where, paging(query));
  return page(rows.map(toDto), await repo.countWhere(db, products, where), query);
}

export async function getProduct(auth: AuthContext, id: string): Promise<ProductDto> {
  return toDto(found(await repo.findProduct(db, auth.companyId, id), 'Product'));
}

export async function createProduct(auth: AuthContext, input: CreateProductRequest, meta: RequestMeta): Promise<ProductDto> {
  const { countersign, ...fields } = input;
  const proof = await verifyCountersign(auth, countersign, meta);
  const id = await withTransaction(txContext(auth, countersign ? `countersigned: ${countersign.reason}` : undefined), async (tx) => {
    const item = found(await repo.findItem(tx, auth.companyId, fields.itemId), 'Item');
    if (!item.isActive) throw new AppError('VALIDATION_FAILED', 'The item is not active', { field: 'itemId' });
    if (item.type !== 'FG') throw new AppError('VALIDATION_FAILED', 'A product must be a finished-goods (FG) item', { field: 'itemId' });
    if (fields.customerId) await assertReference(tx, 'master.customers', auth.companyId, fields.customerId, 'Customer');
    const row = await repo.insertProduct(tx, {
      itemId: fields.itemId,
      customerId: fields.customerId ?? null,
      registrationNo: fields.registrationNo ?? null,
      artworkVersion: fields.artworkVersion ?? null,
      qualityAgreementSignedOn: fields.qualityAgreementSignedOn ?? null,
    });
    const regulated = ProductRegulatedFields.filter((f) => (fields[f] ?? null) !== null);
    if (regulated.length > 0) await applyCountersign(tx, row.id, proof, regulated);
    return row.id;
  });
  return getProduct(auth, id);
}

export async function updateProduct(auth: AuthContext, id: string, input: UpdateProductRequest, meta: RequestMeta): Promise<ProductDto> {
  const { countersign, ...fields } = input;
  const proof = await verifyCountersign(auth, countersign, meta);
  await withTransaction(txContext(auth, countersign ? `countersigned: ${countersign.reason}` : undefined), async (tx) => {
    const current = found(await repo.findProduct(tx, auth.companyId, id, true), 'Product').p;
    const changes = sent(fields);
    if (changes.customerId && changes.customerId !== current.customerId) {
      await assertReference(tx, 'master.customers', auth.companyId, changes.customerId, 'Customer');
    }
    const regulated = ProductRegulatedFields.filter((f) => f in changes && (changes[f] ?? null) !== (current[f] ?? null));
    await repo.updateProduct(tx, id, changes);
    if (regulated.length > 0) await applyCountersign(tx, id, proof, regulated);
  });
  return getProduct(auth, id);
}

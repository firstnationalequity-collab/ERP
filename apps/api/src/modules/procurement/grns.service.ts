// Goods received notes (architecture §4 "Lot status", "Purchase order", §6 "GRN posted", §7.5; build-plan M3 task 3; 0027).
//   DRAFT (Storekeeper, purch.grn.post) → POSTED. Posting, in ONE transaction:
//     - per line: a lot in QUARANTINE (engines/inventory createLot, number series MATERIAL_LOT), a RECEIPT movement at
//       unit cost = PO unit price × Finance's rate for the GRN date (latest on/before, within fin.rate.max_age_days;
//       owner 2026-11-25), and an OPEN QC sample request (modules/qc; owner Q1);
//     - the GRN_RECEIPT journal (Dr Inventory / Cr GRNI, vendor on the GRNI line) through engines/posting (rule 5);
//     - the PO's received quantities and PARTIALLY_RECEIVED / RECEIVED status.
//   Landed charges entered on the DRAFT GRN post with it (landed-costs.service, owner Q2/Q21; task 4, 0029): after
//   the GRN is POSTED, each capitalised charge raises its lots by a LANDED_COST value adjustment on the GRN date, so
//   the lots are received at full cost; tax charges post their IMPORT_TAX journal.
//   Refusals: OVER_RECEIPT (ordered + tolerance), AVL_NOT_APPROVED (GMP material needs an APPROVED source for
//   item + vendor + manufacturer at posting), RATE_MISSING, SEGREGATION_OF_DUTIES (receiver ≠ PO creator / approver),
//   SHELF_LIFE_TOO_SHORT (setting purch.grn.min_shelf_life_pct), expired / retest passed / mfg after the GRN date.
// Owner answers 2026-11-25 (0028):
//   - an item with qc_required = false: its lot starts APPROVED and gets no sample request (answer 4);
//   - DRAFT → CANCELLED with a reason (purch.grn.post);
//   - POSTED → REVERSED (purch.grn.reverse, Warehouse Manager, e-signature + reason) only while every lot is
//     untouched, else GRN_LOTS_IN_USE (the route then is QC rejection and return to vendor). In one transaction:
//     receipt movements mirrored, GRN_RECEIPT journal reversed, sample requests CANCELLED, PO quantities given back
//     and PO status restored. The lot record stays at zero stock (answer 5).
import { Decimal } from 'decimal.js';
import {
  AvlItemTypes,
  GrnStatus,
  type CreateGrnRequest,
  type GrnReverseRequest,
  type GrnDto,
  type GrnLineDto,
  type GrnLineInput,
  type Page,
  type PoReceiptDto,
  type PurchListQuery,
  type UpdateGrnRequest,
} from '@albert/shared';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import { companyToday } from '../../core/dates';
import { txContext, type AuthContext, type RequestMeta } from '../../core/auth/auth.service';
import { recordSignature, verifySignature } from '../../core/esign/esign.service';
import { defineTransitions, recordInitialStatus, transition } from '../../core/transition/transition';
import { approversOf } from '../../core/approvals/approvals.service';
import { nextDocNo } from '../../core/settings/numbering.service';
import {
  createLot,
  lotsByIds,
  lotsTouchedSinceReceipt,
  movementsOfDocument,
  postMovement,
  reverseMovements,
  type PostedMovement,
} from '../../engines/inventory';
import { journalsOfSource, postStockJournal, reverseStockJournal } from '../../engines/posting';
import {
  approvedSourcesFor,
  assertPurchVendor,
  assertReceiptSource,
  purchItems,
  purchLocations,
  purchVendors,
  type PurchItemRef,
} from '../masters/purch-refs.service';
import { assertStockLocation } from '../masters/stock-refs.service';
import { rateOn } from '../finance/rates.service';
import { cancelGrnSampleRequests, requestSample, sampleRequestsOfLots } from '../qc/sample-requests.service';
import * as repo from './grns.repo';
import { invoicesNaming } from './invoices.repo';
import { findPo, listPos, poLinesOf, type PoLineRow, type PoRow } from './procurement.repo';
import { userNames } from '../../core/access/access.service';
import { minShelfLifePct, overReceiptPct } from './procurement.settings';
import { cancelChargesOfGrn, chargeIdsOfGrn, landedCostsOfGrns, postChargesWithGrn, reverseChargesOfGrn } from './landed-costs.service';
import { PO_TABLE, PurchaseOrderMoves } from './orders.service';

export const GRN_TABLE = 'purch.grns';
export const GRN_DOC_TYPE = 'GRN'; // number series, ledger ref_doc_type, journal source_type

export const GrnMoves = defineTransitions<GrnStatus>({
  entityTable: GRN_TABLE,
  statuses: GrnStatus,
  moves: [
    { from: null, to: 'DRAFT', permission: 'purch.grn.post' },
    { from: 'DRAFT', to: 'POSTED', permission: 'purch.grn.post' },
    { from: 'DRAFT', to: 'CANCELLED', permission: 'purch.grn.post', reasonRequired: true },
    { from: 'POSTED', to: 'REVERSED', permission: 'purch.grn.reverse', esign: ['REVERSED'], reasonRequired: true },
  ],
});

const RECEIVING: readonly string[] = ['APPROVED', 'PARTIALLY_RECEIVED'];
const q4 = (d: Decimal) => d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

/** Unit price (PO currency) × rate → PKR unit cost, a 6-decimal rate, half-up (the DB check uses round(…, 6)). */
export function grnUnitCost(unitPrice: string, rate: string): string {
  return new Decimal(unitPrice).times(rate).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
}

/** The most a PO line may receive in total: ordered × (1 + tolerance %), 4 decimals. */
function maxReceivable(line: PoLineRow, pct: number): Decimal {
  return q4(new Decimal(line.qty).times(new Decimal(pct).div(100).plus(1)));
}

async function lockPoOrFail(tx: Queryable, companyId: string, poId: string, lock: boolean): Promise<PoRow> {
  const po = await findPo(tx, companyId, poId, lock);
  if (!po) throw new AppError('NOT_FOUND', 'Purchase order not found');
  return po;
}

function assertReceiving(po: PoRow): void {
  if (!RECEIVING.includes(po.status)) {
    throw new AppError('INVALID_TRANSITION', `Purchase order ${po.docNo} is ${po.status}; only an APPROVED or partly received PO receives goods`, {
      status: po.status,
    });
  }
}

// ---------------------------------------------------------------- reading

/** For the GRN screen ("scan the PO"): what each line may still receive and the APPROVED sources to pick from. */
export async function poReceipt(auth: AuthContext, poRef: { poId?: string; docNo?: string }): Promise<PoReceiptDto> {
  let po: PoRow | undefined;
  if (poRef.poId) po = await findPo(db, auth.companyId, poRef.poId);
  else if (poRef.docNo) {
    const { rows } = await listPos(db, auth.companyId, { search: poRef.docNo.trim() }, { limit: 5, offset: 0 });
    po = rows.find((r) => r.docNo.toLowerCase() === poRef.docNo!.trim().toLowerCase());
  }
  if (!po) throw new AppError('NOT_FOUND', 'Purchase order not found');
  const lines = await poLinesOf(db, [po.id]);
  const [vendors, items, pct] = await Promise.all([
    purchVendors(db, auth.companyId, [po.vendorId]),
    purchItems(db, auth.companyId, lines.map((l) => l.itemId)),
    overReceiptPct(db, auth.companyId),
  ]);
  const sources = await approvedSourcesFor(db, auth.companyId, po.vendorId, lines.map((l) => l.itemId));
  const v = vendors.get(po.vendorId);
  return {
    poId: po.id,
    poDocNo: po.docNo,
    poStatus: po.status,
    vendorId: po.vendorId,
    vendorCode: v?.code ?? '',
    vendorName: v?.name ?? '',
    currency: po.currency,
    overReceiptPct: pct,
    lines: lines.map((l) => {
      const it = items.get(l.itemId);
      const received = new Decimal(l.receivedQty);
      return {
        poLineId: l.id,
        lineNo: l.lineNo,
        itemId: l.itemId,
        itemCode: it?.code ?? '',
        itemName: it?.name ?? '',
        itemType: it?.type ?? '',
        uomCode: it?.uomCode ?? '',
        orderedQty: l.qty,
        receivedQty: l.receivedQty,
        openQty: Decimal.max(new Decimal(l.qty).minus(received), 0).toFixed(4),
        maxQty: Decimal.max(maxReceivable(l, pct).minus(received), 0).toFixed(4),
        unitPrice: l.unitPrice,
        needsSource: it ? AvlItemTypes.includes(it.type) : false,
        needsDates: it?.type === 'API',
        sources: sources
          .filter((s) => s.itemId === l.itemId)
          .map((s) => ({ id: s.id, manufacturer: s.manufacturer, manufacturingSite: s.manufacturingSite })),
      };
    }),
  };
}

async function toDtos(q: Queryable, companyId: string, rows: repo.GrnRow[]): Promise<GrnDto[]> {
  const lines = await repo.grnLinesOf(q, rows.map((r) => r.id));
  const lotIds = lines.flatMap((l) => (l.lotId ? [l.lotId] : []));
  const [vendors, items, locations, names, lots, samples, pos, charges] = await Promise.all([
    purchVendors(q, companyId, rows.map((r) => r.vendorId)),
    purchItems(q, companyId, lines.map((l) => l.itemId)),
    purchLocations(q, companyId, rows.map((r) => r.locationId)),
    userNames(q, rows.flatMap((r) => (r.postedBy ? [r.createdBy, r.postedBy] : [r.createdBy]))),
    lotsByIds(q, companyId, lotIds),
    sampleRequestsOfLots(q, companyId, lotIds),
    Promise.all([...new Set(rows.map((r) => r.poId))].map((id) => findPo(q, companyId, id))),
    landedCostsOfGrns(q, companyId, rows.map((r) => r.id)),
  ]);
  const poDoc = new Map(pos.flatMap((p) => (p ? [[p.id, p.docNo] as const] : [])));
  // The GRN_RECEIPT journal is the first one of the GRN; a reversal adds its mirror after it.
  const journals = new Map(
    await Promise.all(
      rows
        .filter((r) => r.status === 'POSTED' || r.status === 'REVERSED')
        .map(async (r) => [r.id, await journalsOfSource(q, companyId, GRN_DOC_TYPE, r.id)] as const),
    ),
  );
  return rows.map((r) => {
    const v = vendors.get(r.vendorId);
    const loc = locations.get(r.locationId);
    const myLines: GrnLineDto[] = lines
      .filter((l) => l.grnId === r.id)
      .map((l) => {
        const it = items.get(l.itemId);
        const lot = l.lotId ? lots.get(l.lotId) : undefined;
        const sr = l.lotId ? samples.find((s) => s.lotId === l.lotId) : undefined;
        return {
          id: l.id,
          lineNo: l.lineNo,
          poLineId: l.poLineId,
          itemId: l.itemId,
          itemCode: it?.code ?? '',
          itemName: it?.name ?? '',
          itemType: it?.type ?? '',
          uomCode: it?.uomCode ?? '',
          qty: l.qty,
          containers: l.containers,
          unitPrice: l.unitPrice,
          unitCost: l.unitCost,
          valuePkr: l.unitCost ? new Decimal(l.qty).times(l.unitCost).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
          approvedSourceId: l.approvedSourceId,
          manufacturer: l.manufacturer,
          manufacturingSite: l.manufacturingSite,
          mfrBatchNo: l.mfrBatchNo,
          mfgDate: l.mfgDate,
          expiryDate: l.expiryDate,
          retestDate: l.retestDate,
          lotId: l.lotId,
          lotNo: lot?.lotNo ?? null,
          lotStatus: lot?.status ?? null,
          sampleRequest: sr ? { id: sr.id, status: sr.status, requestedAt: sr.requestedAt } : null,
          notes: l.notes,
        };
      });
    const total = r.postedAt ? myLines.reduce((s, l) => s.plus(l.valuePkr ?? 0), new Decimal(0)).toFixed(2) : null;
    const [journal, reversalJournal] = journals.get(r.id) ?? [];
    return {
      id: r.id,
      docNo: r.docNo,
      grnDate: r.grnDate,
      poId: r.poId,
      poDocNo: poDoc.get(r.poId) ?? '',
      vendorId: r.vendorId,
      vendorCode: v?.code ?? '',
      vendorName: v?.name ?? '',
      currency: r.currency,
      locationId: r.locationId,
      locationCode: loc ? `${loc.warehouseCode}/${loc.code}` : '',
      locationName: loc?.name ?? '',
      deliveryNoteNo: r.deliveryNoteNo,
      notes: r.notes,
      exchangeRate: r.exchangeRate,
      exchangeRateDate: r.exchangeRateDate,
      totalPkr: total,
      status: r.status,
      createdBy: r.createdBy,
      createdByName: names.get(r.createdBy) ?? '',
      createdAt: r.createdAt.toISOString(),
      postedBy: r.postedBy,
      postedByName: r.postedBy ? (names.get(r.postedBy) ?? '') : null,
      postedAt: r.postedAt ? r.postedAt.toISOString() : null,
      journalId: journal?.id ?? null,
      journalDocNo: journal?.docNo ?? null,
      reversalJournalDocNo: reversalJournal?.docNo ?? null,
      landedCosts: charges
        .filter((c) => c.grnId === r.id)
        .map((c) => ({
          id: c.id,
          docNo: c.docNo,
          chargeTypeCode: c.chargeTypeCode,
          chargeTypeName: c.chargeTypeName,
          capitalise: c.capitalise,
          amount: c.amount,
          status: c.status,
          withGrn: c.withGrn,
        })),
      lines: myLines,
    };
  });
}

export async function listGrns(auth: AuthContext, query: PurchListQuery & { poId?: string }): Promise<Page<GrnDto>> {
  const { rows, total } = await repo.listGrns(
    db,
    auth.companyId,
    { status: query.status, search: query.search, vendorId: query.vendorId, poId: query.poId },
    { limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
  );
  return { items: await toDtos(db, auth.companyId, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function getGrn(auth: AuthContext, id: string): Promise<GrnDto> {
  const row = await repo.findGrn(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'GRN not found');
  const [dto] = await toDtos(db, auth.companyId, [row]);
  if (!dto) throw new AppError('NOT_FOUND', 'GRN not found');
  return dto;
}

// ---------------------------------------------------------------- writing

type GrnHeader = Omit<UpdateGrnRequest, 'lines'>;
type LineIn = Omit<GrnLineInput, 'containers'> & { containers?: number };

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Owner 2026-11-25 (answer 3): with purch.grn.min_shelf_life_pct > 0, the shelf life left on the GRN date must be at
 * least that percent of the total (expiry − mfg, or the item's shelf life without a mfg date). Mirrored in 0028.
 */
function lineShelfLife(it: PurchItemRef, l: LineIn, grnDate: string, minPct: number): void {
  if (minPct <= 0 || !l.expiryDate) return;
  const total = l.mfgDate ? daysBetween(l.mfgDate, l.expiryDate) : it.shelfLifeDays;
  if (!total || total <= 0) {
    throw new AppError('VALIDATION_FAILED', `${it.code}: give the mfg date so the remaining shelf life can be checked`, { field: 'mfgDate', itemId: it.id });
  }
  const left = daysBetween(grnDate, l.expiryDate);
  if (new Decimal(left).times(100).lessThan(new Decimal(minPct).times(total))) {
    const pct = new Decimal(left).times(100).div(total).toDecimalPlaces(1, Decimal.ROUND_DOWN).toFixed(1);
    throw new AppError('SHELF_LIFE_TOO_SHORT', `${it.code}: only ${left} of ${total} days of shelf life left (${pct}%); the minimum is ${minPct}%`, {
      field: 'expiryDate',
      itemId: it.id,
      daysLeft: left,
      totalDays: total,
      minPct,
    });
  }
}

function lineDates(it: PurchItemRef, l: LineIn, grnDate: string): void {
  const field = (f: string, msg: string) => new AppError('VALIDATION_FAILED', `${it.code}: ${msg}`, { field: f, itemId: it.id });
  if (it.type === 'API' && (!l.mfrBatchNo || !l.mfgDate || !l.expiryDate || !l.retestDate)) {
    throw field('mfrBatchNo', 'an API needs the manufacturer batch, mfg, expiry and retest dates');
  }
  if (l.mfgDate && l.mfgDate > grnDate) throw field('mfgDate', 'the mfg date is after the GRN date');
  if (l.expiryDate && l.expiryDate <= grnDate) throw field('expiryDate', 'the material has expired (expiry on or before the GRN date)');
  if (l.retestDate && l.retestDate <= grnDate) throw field('retestDate', 'the retest date is on or before the GRN date');
  if (l.expiryDate && l.mfgDate && l.expiryDate <= l.mfgDate) throw field('expiryDate', 'expiry must be after mfg');
  if (l.retestDate && l.expiryDate && l.retestDate > l.expiryDate) throw field('retestDate', 'retest cannot be after expiry');
}

/**
 * Header and lines checked against the PO as it is now; rows ready to write. Used on save AND again at posting
 * (a source blocked, a vendor deactivated or another GRN posted in between stops it).
 */
async function prepare(q: Queryable, auth: AuthContext, po: PoRow, header: GrnHeader, lines: LineIn[]): Promise<repo.GrnLineValues[]> {
  assertReceiving(po);
  if (header.grnDate > companyToday()) throw new AppError('VALIDATION_FAILED', 'The GRN date cannot be in the future', { field: 'grnDate' });
  if (header.grnDate < po.poDate) throw new AppError('VALIDATION_FAILED', `The GRN date is before the date of ${po.docNo}`, { field: 'grnDate' });
  await assertStockLocation(q, auth.companyId, header.locationId, true);
  const vendor = await assertPurchVendor(q, auth.companyId, po.vendorId);
  const poLines = new Map((await poLinesOf(q, [po.id])).map((l) => [l.id, l]));
  const items = await purchItems(q, auth.companyId, [...poLines.values()].map((l) => l.itemId));
  const pct = await overReceiptPct(q, auth.companyId);
  const minShelfPct = await minShelfLifePct(q, auth.companyId);

  const wanted = new Map<string, Decimal>();
  const rows: repo.GrnLineValues[] = [];
  for (const [i, l] of lines.entries()) {
    const pl = poLines.get(l.poLineId);
    if (!pl) throw new AppError('VALIDATION_FAILED', `Line ${i + 1} is not a line of ${po.docNo}`, { poLineId: l.poLineId });
    const it = items.get(pl.itemId);
    if (!it) throw new AppError('VALIDATION_FAILED', 'Item does not exist', { itemId: pl.itemId });
    lineDates(it, l, header.grnDate);
    lineShelfLife(it, l, header.grnDate, minShelfPct);
    const gmp = AvlItemTypes.includes(it.type);
    if (!gmp && l.approvedSourceId) {
      throw new AppError('VALIDATION_FAILED', `${it.code} (${it.type}) is not on the AVL; type the manufacturer instead`, { field: 'approvedSourceId' });
    }
    const source = await assertReceiptSource(q, auth.companyId, { vendor, item: it, approvedSourceId: l.approvedSourceId ?? null });
    wanted.set(pl.id, (wanted.get(pl.id) ?? new Decimal(0)).plus(l.qty));
    rows.push({
      lineNo: i + 1,
      poLineId: pl.id,
      itemId: pl.itemId,
      qty: new Decimal(l.qty).toFixed(4),
      containers: l.containers ?? 1,
      unitPrice: pl.unitPrice,
      approvedSourceId: source?.id ?? null,
      manufacturer: source?.manufacturer ?? (l.manufacturer?.trim() || null),
      manufacturingSite: source?.manufacturingSite ?? (l.manufacturingSite?.trim() || null),
      mfrBatchNo: l.mfrBatchNo?.trim() || null,
      mfgDate: l.mfgDate ?? null,
      expiryDate: l.expiryDate ?? null,
      retestDate: l.retestDate ?? null,
      notes: l.notes?.trim() || null,
    });
  }
  for (const [poLineId, qty] of wanted) {
    const pl = poLines.get(poLineId)!;
    const room = maxReceivable(pl, pct).minus(pl.receivedQty);
    if (qty.greaterThan(room)) {
      const it = items.get(pl.itemId);
      throw new AppError(
        'OVER_RECEIPT',
        `${it?.code ?? 'Line'}: receiving ${qty.toFixed(4)} would exceed ${po.docNo} line ${pl.lineNo} (ordered ${pl.qty}, received ${pl.receivedQty}, tolerance ${pct}%)`,
        { poLineId, qty: qty.toFixed(4), maxQty: Decimal.max(room, 0).toFixed(4), tolerancePct: pct },
      );
    }
  }
  return rows;
}

function headerValues(h: GrnHeader): repo.GrnHeaderValues {
  return { grnDate: h.grnDate, locationId: h.locationId, deliveryNoteNo: h.deliveryNoteNo?.trim() || null, notes: h.notes?.trim() || null };
}

export async function createGrn(auth: AuthContext, input: CreateGrnRequest): Promise<GrnDto> {
  const { lines, poId, ...header } = input;
  const id = await withTransaction(txContext(auth, 'create GRN'), async (tx) => {
    const po = await lockPoOrFail(tx, auth.companyId, poId, false);
    const rows = await prepare(tx, auth, po, header, lines);
    const docNo = await nextDocNo(tx, GRN_DOC_TYPE, header.grnDate);
    const grnId = await repo.insertGrn(tx, { ...headerValues(header), docNo, poId: po.id, vendorId: po.vendorId, currency: po.currency });
    await recordInitialStatus(tx, GrnMoves, { entityId: grnId, to: 'DRAFT', actor: auth });
    await repo.replaceGrnLines(tx, grnId, rows);
    return grnId;
  });
  return getGrn(auth, id);
}

async function lockDraft(tx: Tx, auth: AuthContext, id: string): Promise<repo.GrnRow> {
  const grn = await repo.findGrn(tx, auth.companyId, id, true);
  if (!grn) throw new AppError('NOT_FOUND', 'GRN not found');
  if (grn.status !== 'DRAFT') {
    throw new AppError('RECORD_LOCKED', `GRN ${grn.docNo} is ${grn.status} and can no longer change`, { status: grn.status });
  }
  return grn;
}

export async function updateGrn(auth: AuthContext, id: string, input: UpdateGrnRequest): Promise<GrnDto> {
  const { lines, ...header } = input;
  await withTransaction(txContext(auth, 'edit GRN'), async (tx) => {
    const grn = await lockDraft(tx, auth, id);
    const po = await lockPoOrFail(tx, auth.companyId, grn.poId, false);
    const rows = await prepare(tx, auth, po, header, lines);
    await repo.updateGrnHeader(tx, id, headerValues(header));
    await repo.replaceGrnLines(tx, id, rows);
  });
  return getGrn(auth, id);
}

/** Rule 9 (build-plan M3: PO creator ≠ approver ≠ GRN receiver): the receiver neither created nor approved the PO. */
async function assertReceiver(q: Queryable, auth: AuthContext, po: PoRow): Promise<void> {
  if (auth.userId === po.createdBy) {
    throw new AppError('SEGREGATION_OF_DUTIES', `You created ${po.docNo}; another person receives the goods`, { rule: 'PO creator ≠ GRN receiver' });
  }
  if ((await approversOf(q, auth.companyId, PO_TABLE, po.id)).includes(auth.userId)) {
    throw new AppError('SEGREGATION_OF_DUTIES', `You approved ${po.docNo}; another person receives the goods`, { rule: 'PO approver ≠ GRN receiver' });
  }
}

/** Post: lots in QUARANTINE, receipt movements + GRN_RECEIPT journal, QC sample requests, PO received — one transaction. */
export async function postGrn(auth: AuthContext, id: string): Promise<GrnDto> {
  await withTransaction(txContext(auth, 'post GRN'), async (tx) => {
    const grn = await lockDraft(tx, auth, id);
    const po = await lockPoOrFail(tx, auth.companyId, grn.poId, true);
    await assertReceiver(tx, auth, po);
    await repo.lockPoLines(tx, po.id);
    const lines = await repo.grnLinesOf(tx, [id]);
    if (lines.length === 0) throw new AppError('VALIDATION_FAILED', `GRN ${grn.docNo} has no lines`);
    // Everything checked again as it is now (AVL at receipt, tolerance, vendor, dates).
    await prepare(
      tx,
      auth,
      po,
      { grnDate: grn.grnDate, locationId: grn.locationId, deliveryNoteNo: grn.deliveryNoteNo, notes: grn.notes },
      lines.map((l) => ({
        poLineId: l.poLineId,
        qty: l.qty,
        containers: l.containers,
        approvedSourceId: l.approvedSourceId,
        manufacturer: l.manufacturer,
        manufacturingSite: l.manufacturingSite,
        mfrBatchNo: l.mfrBatchNo,
        mfgDate: l.mfgDate,
        expiryDate: l.expiryDate,
        retestDate: l.retestDate,
      })),
    );
    const { rate, rateDate } = await rateOn(tx, auth.companyId, grn.currency, grn.grnDate);
    const items = await purchItems(tx, auth.companyId, lines.map((l) => l.itemId));

    const movements: PostedMovement[] = [];
    for (const l of lines) {
      const unitCost = grnUnitCost(l.unitPrice, rate);
      const lot = await createLot(tx, auth, {
        source: 'GRN',
        itemId: l.itemId,
        lotNo: await nextDocNo(tx, 'MATERIAL_LOT', grn.grnDate),
        mfrBatchNo: l.mfrBatchNo ?? undefined,
        manufacturer: l.manufacturer ?? undefined,
        mfgDate: l.mfgDate ?? undefined,
        expiryDate: l.expiryDate ?? undefined,
        retestDate: l.retestDate ?? undefined,
        unitCost,
      });
      movements.push(
        await postMovement(tx, auth, {
          type: 'RECEIPT',
          lotId: lot.id,
          locationId: grn.locationId,
          qty: l.qty,
          date: grn.grnDate,
          refDocType: GRN_DOC_TYPE,
          refDocId: id,
        }),
      );
      await repo.setLineLot(tx, l.id, { lotId: lot.id, unitCost });
      // Owner 2026-11-25 (answer 4): only an item that needs QC gets a sample request (its lot is in QUARANTINE).
      if (items.get(l.itemId)?.qcRequired ?? true) await requestSample(tx, auth, { lotId: lot.id, source: 'GRN', refDocId: id });
    }
    await postStockJournal(tx, auth, { movements, narration: `GRN ${grn.docNo} against ${po.docNo}`, dimensions: { vendorId: po.vendorId } });
    await transition(tx, GrnMoves, {
      entityId: id,
      to: 'POSTED',
      actor: auth,
      alsoSet: { exchange_rate: new Decimal(rate).toFixed(6), exchange_rate_date: rateDate, posted_by: auth.userId, posted_at: new Date().toISOString() },
    });
    // Owner Q2: the charges entered with the GRN roll into the lot cost now (after the receipt, same transaction).
    await postChargesWithGrn(tx, auth, id);

    const received = new Map<string, Decimal>();
    for (const l of lines) received.set(l.poLineId, (received.get(l.poLineId) ?? new Decimal(0)).plus(l.qty));
    for (const [poLineId, qty] of received) await repo.addReceived(tx, poLineId, qty.toFixed(4));
    const after = await poLinesOf(tx, [po.id]);
    const to = after.every((l) => new Decimal(l.receivedQty).greaterThanOrEqualTo(l.qty)) ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
    if (to !== po.status) await transition(tx, PurchaseOrderMoves, { entityId: po.id, to, actor: auth, reason: `GRN ${grn.docNo}` });
  });
  return getGrn(auth, id);
}

// ---------------------------------------------------------------- cancel and reverse (owner 2026-11-25, answer 5)

/** DRAFT → CANCELLED with a reason; nothing was posted, the keyed lines stay on record. */
export async function cancelGrn(auth: AuthContext, id: string, reason: string): Promise<GrnDto> {
  await withTransaction(txContext(auth, `cancel GRN: ${reason}`), async (tx) => {
    const grn = await repo.findGrn(tx, auth.companyId, id, true);
    if (!grn) throw new AppError('NOT_FOUND', 'GRN not found');
    if (grn.status !== 'DRAFT') {
      throw new AppError('INVALID_TRANSITION', `GRN ${grn.docNo} is ${grn.status}; only a DRAFT is cancelled (a posted GRN is reversed)`, {
        status: grn.status,
      });
    }
    await transition(tx, GrnMoves, { entityId: id, to: 'CANCELLED', actor: auth, reason });
    await cancelChargesOfGrn(tx, auth, id, 'purch.grn.post', `GRN ${grn.docNo} cancelled: ${reason}`);
  });
  return getGrn(auth, id);
}

const GIVES_BACK: readonly string[] = ['PARTIALLY_RECEIVED', 'RECEIVED'];

/**
 * POSTED → REVERSED (purch.grn.reverse, own e-signature REVERSED, owner 2026-11-25; its reason is the reversal
 * reason). Only while every lot is untouched (the GRN's own landed-cost adjustments are not use); then, in one
 * transaction: posted landed costs undone (4b), receipt movements mirrored (dated today), the GRN_RECEIPT journal
 * reversed, sample requests CANCELLED, the PO's received quantities given back and its status restored. The PO goes
 * back without re-running its submit checks (owner 2026-11-25); the next GRN posting re-checks vendor, AVL and rate.
 */
export async function reverseGrn(auth: AuthContext, id: string, input: GrnReverseRequest, meta: RequestMeta): Promise<GrnDto> {
  if (input.signature.meaning !== 'REVERSED') throw new AppError('VALIDATION_FAILED', 'Reversing a GRN needs the meaning REVERSED');
  const proof = await verifySignature(auth, input.signature, meta);
  const reason = input.signature.reason;
  await withTransaction(txContext(auth, `reverse GRN: ${reason}`), async (tx) => {
    const grn = await repo.findGrn(tx, auth.companyId, id, true);
    if (!grn) throw new AppError('NOT_FOUND', 'GRN not found');
    if (grn.status !== 'POSTED') {
      throw new AppError('INVALID_TRANSITION', `GRN ${grn.docNo} is ${grn.status}; only a POSTED GRN is reversed`, { status: grn.status });
    }
    const po = await lockPoOrFail(tx, auth.companyId, grn.poId, true);
    if (!GIVES_BACK.includes(po.status)) {
      throw new AppError('INVALID_TRANSITION', `Purchase order ${po.docNo} is ${po.status}; its receipts can no longer be reversed`, { status: po.status });
    }
    await repo.lockPoLines(tx, po.id);
    const lines = await repo.grnLinesOf(tx, [id]);
    const lotIds = lines.flatMap((l) => (l.lotId ? [l.lotId] : []));
    const doc = { refDocType: GRN_DOC_TYPE, refDocId: id };

    // Task 5 (0031): a GRN whose lines or charges are on a vendor invoice (not cancelled) stays; the DB re-checks.
    const chargeIds = await chargeIdsOfGrn(tx, id);
    const invoices = await invoicesNaming(tx, { grnLineIds: lines.map((l) => l.id), landedCostIds: chargeIds });
    if (invoices.length > 0) {
      throw new AppError('IN_USE', `GRN ${grn.docNo} is on vendor invoice ${invoices.join(', ')}; it is no longer reversed (cancel a draft invoice first)`, {
        invoices,
      });
    }

    // Untouched: no movement but the receipt, no status change, no reservation, no sampling started.
    const own = { refDocType: 'LANDED_COST', refDocIds: chargeIds };
    const touched = (await lotsTouchedSinceReceipt(tx, doc, lotIds, own)).filter((t) => t.touches.length > 0);
    if (touched.length > 0) {
      throw new AppError(
        'GRN_LOTS_IN_USE',
        `GRN ${grn.docNo} cannot be reversed: ${touched.map((t) => `lot ${t.lotNo} has ${t.touches.join(', ')}`).join('; ')}. Reject the lot through QC and return it to the vendor instead`,
        { lots: touched.map((t) => ({ lotId: t.lotId, lotNo: t.lotNo, touches: t.touches })) },
      );
    }
    await cancelGrnSampleRequests(tx, auth, { grnId: id, lotIds, reason });

    // Owner 2026-11-25 (4b): the posted landed costs go with the GRN, before the receipts leave the lots.
    const today = companyToday();
    await reverseChargesOfGrn(tx, auth, id, today, `GRN ${grn.docNo} reversed: ${reason}`);
    const receipts = (await movementsOfDocument(tx, auth.companyId, doc)).filter((m) => m.movementType === 'RECEIPT');
    const reversed = await reverseMovements(tx, auth, { ...doc, movementIds: receipts.map((m) => m.id), date: today });
    const journal = (await journalsOfSource(tx, auth.companyId, GRN_DOC_TYPE, id)).find((j) => j.event === 'GRN_RECEIPT' && j.status === 'POSTED');
    await reverseStockJournal(tx, auth, { entryId: journal?.id ?? null, movements: reversed, reason: `GRN ${grn.docNo} reversed: ${reason}` });

    const signature = await recordSignature(tx, proof, { table: GRN_TABLE, id }, ['REVERSED']);
    await transition(tx, GrnMoves, { entityId: id, to: 'REVERSED', actor: auth, signature, reason });
    await cancelChargesOfGrn(tx, auth, id, 'purch.grn.reverse', `GRN ${grn.docNo} reversed: ${reason}`);

    const given = new Map<string, Decimal>();
    for (const l of lines) given.set(l.poLineId, (given.get(l.poLineId) ?? new Decimal(0)).plus(l.qty));
    for (const [poLineId, qty] of given) await repo.addReceived(tx, poLineId, qty.neg().toFixed(4));
    const after = await poLinesOf(tx, [po.id]);
    const to = after.every((l) => new Decimal(l.receivedQty).isZero())
      ? 'APPROVED'
      : after.every((l) => new Decimal(l.receivedQty).greaterThanOrEqualTo(l.qty))
        ? 'RECEIVED'
        : 'PARTIALLY_RECEIVED';
    if (to !== po.status) {
      await transition(tx, PurchaseOrderMoves, { entityId: po.id, to, actor: auth, reason: `GRN ${grn.docNo} reversed: ${reason}` });
    }
  });
  return getGrn(auth, id);
}

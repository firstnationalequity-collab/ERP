// Goods received notes (architecture §4 "Lot status", "Purchase order", §6 "GRN posted", §7.5; build-plan M3 task 3; 0027).
//   DRAFT (Storekeeper, purch.grn.post) → POSTED. Posting, in ONE transaction:
//     - per line: a lot in QUARANTINE (engines/inventory createLot, number series MATERIAL_LOT), a RECEIPT movement at
//       unit cost = PO unit price × Finance's rate for the GRN date (latest on/before, within fin.rate.max_age_days;
//       owner 2026-11-25), and an OPEN QC sample request (modules/qc; owner Q1);
//     - the GRN_RECEIPT journal (Dr Inventory / Cr GRNI, vendor on the GRNI line) through engines/posting (rule 5);
//     - the PO's received quantities and PARTIALLY_RECEIVED / RECEIVED status.
//   No landed charges here (owner 2026-11-25: task 4 adds them).
//   Refusals: OVER_RECEIPT (ordered + tolerance), AVL_NOT_APPROVED (GMP material needs an APPROVED source for
//   item + vendor + manufacturer at posting), RATE_MISSING, SEGREGATION_OF_DUTIES (receiver ≠ PO creator / approver).
import { Decimal } from 'decimal.js';
import {
  AvlItemTypes,
  PostingStatus,
  type CreateGrnRequest,
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
import { txContext, type AuthContext } from '../../core/auth/auth.service';
import { defineTransitions, recordInitialStatus, transition } from '../../core/transition/transition';
import { approversOf } from '../../core/approvals/approvals.service';
import { nextDocNo } from '../../core/settings/numbering.service';
import { createLot, lotsByIds, postMovement, type PostedMovement } from '../../engines/inventory';
import { journalsOfSource, postStockJournal } from '../../engines/posting';
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
import { requestSample, sampleRequestsOfLots } from '../qc/sample-requests.service';
import * as repo from './grns.repo';
import { findPo, listPos, poLinesOf, userNames, type PoLineRow, type PoRow } from './procurement.repo';
import { overReceiptPct } from './procurement.settings';
import { PO_TABLE, PurchaseOrderMoves } from './orders.service';

export const GRN_TABLE = 'purch.grns';
export const GRN_DOC_TYPE = 'GRN'; // number series, ledger ref_doc_type, journal source_type

export const GrnMoves = defineTransitions<PostingStatus>({
  entityTable: GRN_TABLE,
  statuses: PostingStatus,
  moves: [
    { from: null, to: 'DRAFT', permission: 'purch.grn.post' },
    { from: 'DRAFT', to: 'POSTED', permission: 'purch.grn.post' },
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
  const [vendors, items, locations, names, lots, samples, pos] = await Promise.all([
    purchVendors(q, companyId, rows.map((r) => r.vendorId)),
    purchItems(q, companyId, lines.map((l) => l.itemId)),
    purchLocations(q, companyId, rows.map((r) => r.locationId)),
    userNames(q, rows.flatMap((r) => (r.postedBy ? [r.createdBy, r.postedBy] : [r.createdBy]))),
    lotsByIds(q, companyId, lotIds),
    sampleRequestsOfLots(q, companyId, lotIds),
    Promise.all([...new Set(rows.map((r) => r.poId))].map((id) => findPo(q, companyId, id))),
  ]);
  const poDoc = new Map(pos.flatMap((p) => (p ? [[p.id, p.docNo] as const] : [])));
  const journals = new Map(
    await Promise.all(
      rows.filter((r) => r.status !== 'DRAFT').map(async (r) => [r.id, (await journalsOfSource(q, companyId, GRN_DOC_TYPE, r.id))[0]] as const),
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
    const total = r.status === 'DRAFT' ? null : myLines.reduce((s, l) => s.plus(l.valuePkr ?? 0), new Decimal(0)).toFixed(2);
    const journal = journals.get(r.id);
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

  const wanted = new Map<string, Decimal>();
  const rows: repo.GrnLineValues[] = [];
  for (const [i, l] of lines.entries()) {
    const pl = poLines.get(l.poLineId);
    if (!pl) throw new AppError('VALIDATION_FAILED', `Line ${i + 1} is not a line of ${po.docNo}`, { poLineId: l.poLineId });
    const it = items.get(pl.itemId);
    if (!it) throw new AppError('VALIDATION_FAILED', 'Item does not exist', { itemId: pl.itemId });
    lineDates(it, l, header.grnDate);
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
      await requestSample(tx, auth, { lotId: lot.id, source: 'GRN', refDocId: id });
    }
    await postStockJournal(tx, auth, { movements, narration: `GRN ${grn.docNo} against ${po.docNo}`, dimensions: { vendorId: po.vendorId } });
    await transition(tx, GrnMoves, {
      entityId: id,
      to: 'POSTED',
      actor: auth,
      alsoSet: { exchange_rate: new Decimal(rate).toFixed(6), exchange_rate_date: rateDate, posted_by: auth.userId, posted_at: new Date().toISOString() },
    });

    const received = new Map<string, Decimal>();
    for (const l of lines) received.set(l.poLineId, (received.get(l.poLineId) ?? new Decimal(0)).plus(l.qty));
    for (const [poLineId, qty] of received) await repo.addReceived(tx, poLineId, qty.toFixed(4));
    const after = await poLinesOf(tx, [po.id]);
    const to = after.every((l) => new Decimal(l.receivedQty).greaterThanOrEqualTo(l.qty)) ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
    if (to !== po.status) await transition(tx, PurchaseOrderMoves, { entityId: po.id, to, actor: auth, reason: `GRN ${grn.docNo}` });
  });
  return getGrn(auth, id);
}

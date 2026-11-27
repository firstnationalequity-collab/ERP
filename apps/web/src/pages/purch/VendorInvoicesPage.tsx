// Vendor invoices (M3 task 5; owner Q3, Q4, Q5). The Accountant enters a vendor's bill: GOODS against the received GRN
// lines of one PO (3-way match), or CHARGES against posted landed costs (customs, forwarder, clearing agent). Posting
// inside the match tolerances posts it; outside, it is held in MATCH_EXCEPTION for a Finance Manager, who releases it
// with an e-signature and a reason (or returns it). Foreign bills convert at the invoice-date rate.
import { useState } from 'react';
import dayjs from 'dayjs';
import { Alert, App, Button, DatePicker, Descriptions, Drawer, Input, InputNumber, Modal, Radio, Select, Space, Table, Tag, Typography } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreateVendorInvoiceRequest,
  UpdateVendorInvoiceRequest,
  VendorInvoiceStatus,
  type BillableDto,
  type Page,
  type TaxCodeDto,
  type VendorInvoiceDto,
  type VendorInvoiceLineDto,
  type VendorInvoiceType,
} from '@albert/shared';
import { api, errorText, newIdempotencyKey } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable, statusFilter } from '../../components/DataTable';
import { PageHeader } from '../../components/PageHeader';
import { ReasonModal } from '../../components/ReasonModal';
import { ESignModal } from '../../components/ESignModal';
import { RefSelect } from '../../components/RefSelect';
import { StatusTag } from '../../components/StatusTag';
import { companyToday, formatDate, formatDecimal, toBusinessDate } from '../../lib/format';

/** Something paid or debited against the invoice (amount strings compared as text: no floats for money). */
const isZeroAmount = (s: string) => /^-?0*(\.0*)?$/.test(s.trim());
const settledAgainst = (inv: { paidAmount: string; debitedAmount: string }) => !isZeroAmount(inv.paidAmount) || !isZeroAmount(inv.debitedAmount);

export const invoicesKey = ['purch', 'vendor-invoices'];

function useSalesTaxCodes() {
  return useQuery({
    queryKey: ['master', 'tax-codes', 'sales'],
    queryFn: async () => (await api<Page<TaxCodeDto>>('/master/tax-codes?pageSize=200')).items.filter((t) => t.kind === 'SALES_TAX' && t.isActive),
  });
}

export function VendorInvoicesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader title="Vendor invoices">
        Goods bills are matched to the PO price and the quantity received; a bill outside the tolerances waits for a Finance Manager. Charges bills (customs, freight,
        clearing) settle the landed costs already booked. Foreign bills convert at the invoice-date rate.
      </PageHeader>
      <DataTable<VendorInvoiceDto>
        title="Vendor invoices"
        path="/purch/vendor-invoices"
        queryKey={invoicesKey}
        filters={[statusFilter(VendorInvoiceStatus)]}
        searchPlaceholder="Search number or vendor's invoice number"
        onRowClick={(r) => setOpenId(r.id)}
        toolbar={can('fin.invoice.manage') && <Button type="primary" onClick={() => setAdding(true)}>Enter invoice</Button>}
        columns={[
          { key: 'docNo', title: 'Number' },
          { key: 'vendorName', title: 'Vendor', render: (r) => `${r.vendorCode} — ${r.vendorName}`, exportValue: (r) => r.vendorCode },
          { key: 'vendorInvoiceNo', title: "Vendor's no." },
          { key: 'invoiceType', title: 'Type', render: (r) => (r.invoiceType === 'GOODS' ? `Goods · ${r.poDocNo ?? ''}` : 'Charges') },
          { key: 'invoiceDate', title: 'Date', render: (r) => formatDate(r.invoiceDate), exportValue: (r) => formatDate(r.invoiceDate) },
          { key: 'dueDate', title: 'Due', render: (r) => formatDate(r.dueDate), exportValue: (r) => formatDate(r.dueDate) },
          { key: 'totalAmount', title: 'Total', render: (r) => `${r.currency} ${formatDecimal(r.totalAmount)}`, exportValue: (r) => r.totalAmount, exportFormat: 'money' },
          { key: 'totalPkr', title: 'PKR', render: (r) => formatDecimal(r.totalPkr), exportValue: (r) => r.totalPkr, exportFormat: 'money' },
          { key: 'openAmount', title: 'Open', render: (r) => (r.status === 'POSTED' ? formatDecimal(r.openAmount) : '—'), exportValue: (r) => r.openAmount, exportFormat: 'money' },
          { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
        ]}
      />
      {adding && (
        <InvoiceEditor
          invoice={null}
          onClose={() => setAdding(false)}
          onSaved={async (id) => {
            await qc.invalidateQueries({ queryKey: invoicesKey });
            setOpenId(id);
          }}
        />
      )}
      {openId && <InvoiceDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => qc.invalidateQueries({ queryKey: invoicesKey })} />}
    </>
  );
}

// ---------------------------------------------------------------- editor

interface LineState {
  ref: string; // GRN line or landed cost id
  qty: string;
  unitPrice: string;
  amount: string;
  taxCodeId?: string;
}

function InvoiceEditor({ invoice, onClose, onSaved }: { invoice: VendorInvoiceDto | null; onClose(): void; onSaved(id: string): Promise<void> }) {
  const taxCodes = useSalesTaxCodes();
  const [type, setType] = useState<VendorInvoiceType>(invoice?.invoiceType ?? 'GOODS');
  const [poId, setPoId] = useState<string | undefined>(invoice?.poId ?? undefined);
  const [vendorId, setVendorId] = useState<string | undefined>(invoice?.vendorId);
  const [head, setHead] = useState({ vendorInvoiceNo: invoice?.vendorInvoiceNo ?? '', invoiceDate: invoice?.invoiceDate ?? companyToday(), notes: invoice?.notes ?? '' });
  const [lines, setLines] = useState<Record<string, LineState>>(() =>
    Object.fromEntries(
      (invoice?.lines ?? []).map((l) => {
        const ref = l.grnLineId ?? l.landedCostId!;
        return [ref, { ref, qty: l.qty ?? '', unitPrice: l.unitPrice ?? '', amount: l.amount, taxCodeId: l.taxCodeId ?? undefined }];
      }),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const billable = useQuery({
    queryKey: [...invoicesKey, 'billable', type, poId, vendorId],
    enabled: type === 'GOODS' ? !!poId : !!vendorId,
    queryFn: () => api<BillableDto>(`/purch/vendor-invoices/billable?${type === 'GOODS' ? `poId=${poId}` : `vendorId=${vendorId}`}`),
  });
  const set = (ref: string, patch: Partial<LineState>) => setLines({ ...lines, [ref]: { ...(lines[ref] ?? { ref, qty: '', unitPrice: '', amount: '' }), ...patch } });
  const taxSelect = (ref: string) => (
    <Select
      aria-label="Sales tax"
      allowClear
      placeholder="No tax"
      value={lines[ref]?.taxCodeId}
      onChange={(v) => set(ref, { taxCodeId: v })}
      options={(taxCodes.data ?? []).map((t) => ({ value: t.id, label: `${t.code} (${formatDecimal(t.rate, 2)}%)` }))}
      style={{ width: 150 }}
    />
  );

  const save = async () => {
    const chosen = Object.values(lines).filter((l) => (type === 'GOODS' ? l.qty && l.unitPrice !== '' : l.amount));
    const body = {
      ...head,
      notes: head.notes || null,
      lines: chosen.map((l) =>
        type === 'GOODS'
          ? { grnLineId: l.ref, qty: l.qty, unitPrice: l.unitPrice, taxCodeId: l.taxCodeId ?? null }
          : { landedCostId: l.ref, amount: l.amount, taxCodeId: l.taxCodeId ?? null },
      ),
    };
    const parsed = invoice
      ? UpdateVendorInvoiceRequest.safeParse(body)
      : CreateVendorInvoiceRequest.safeParse({ ...body, invoiceType: type, ...(type === 'GOODS' ? { poId } : { vendorId }) });
    if (!parsed.success) return setError(parsed.error.issues.map((i) => i.message).join('; '));
    setBusy(true);
    try {
      const saved = await api<VendorInvoiceDto>(invoice ? `/purch/vendor-invoices/${invoice.id}` : '/purch/vendor-invoices', { method: invoice ? 'PATCH' : 'POST', body: parsed.data });
      await onSaved(saved.id);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  // While editing, lines already on this invoice stay listed even though the open quantity excludes them.
  return (
    <Modal open width={980} title={invoice ? `Edit ${invoice.docNo}` : 'Enter a vendor invoice'} okText="Save draft" confirmLoading={busy} onOk={save} onCancel={onClose}>
      <Space direction="vertical" style={{ width: '100%' }}>
        {error && <Alert type="error" showIcon message={error} />}
        {!invoice && (
          <Radio.Group value={type} onChange={(e) => { setType(e.target.value as VendorInvoiceType); setLines({}); }}>
            <Radio.Button value="GOODS">Goods (against a PO)</Radio.Button>
            <Radio.Button value="CHARGES">Charges (customs, freight, clearing)</Radio.Button>
          </Radio.Group>
        )}
        {!invoice && type === 'GOODS' && <RefSelect path="/purch/pos" aria-label="Purchase order" placeholder="Purchase order" value={poId} onChange={(v) => { setPoId(v); setLines({}); }} />}
        {!invoice && type === 'CHARGES' && <RefSelect path="/master/vendors" params={{ status: 'ACTIVE' }} aria-label="Vendor" placeholder="Vendor (e.g. Pakistan Customs)" value={vendorId} onChange={(v) => { setVendorId(v); setLines({}); }} />}
        <Space wrap>
          <Input aria-label="Vendor's invoice number" placeholder="Vendor's invoice number" value={head.vendorInvoiceNo} onChange={(e) => setHead({ ...head, vendorInvoiceNo: e.target.value })} style={{ width: 220 }} />
          <DatePicker aria-label="Invoice date" format="DD-MM-YYYY" value={dayjs(head.invoiceDate)} onChange={(d) => d && setHead({ ...head, invoiceDate: toBusinessDate(d) })} />
        </Space>
        {type === 'GOODS' ? (
          <Table
            rowKey="grnLineId"
            size="small"
            pagination={false}
            loading={billable.isFetching}
            dataSource={billable.data?.goods ?? []}
            locale={{ emptyText: poId ? 'Nothing received is left to bill on this PO' : 'Pick the purchase order' }}
            columns={[
              { title: 'GRN', render: (_, l) => `${l.grnDocNo} · ${formatDate(l.grnDate)}` },
              { title: 'Item', render: (_, l) => `${l.itemCode} — ${l.itemName}` },
              { title: 'Lot', dataIndex: 'lotNo' },
              { title: 'Received', render: (_, l) => formatDecimal(l.receivedQty, 4) },
              { title: 'Open', render: (_, l) => formatDecimal(l.openQty, 4) },
              { title: 'PO price', render: (_, l) => `${l.currency} ${formatDecimal(l.poUnitPrice, 6)}` },
              {
                title: 'Qty billed',
                render: (_, l) => (
                  <InputNumber<string> aria-label={`Qty ${l.itemCode}`} stringMode min="0" precision={4} value={lines[l.grnLineId]?.qty || null}
                    onChange={(v) => set(l.grnLineId, { qty: v ?? '', unitPrice: lines[l.grnLineId]?.unitPrice || l.poUnitPrice })} style={{ width: 110 }} />
                ),
              },
              {
                title: 'Unit price billed',
                render: (_, l) => (
                  <InputNumber<string> aria-label={`Unit price ${l.itemCode}`} stringMode min="0" precision={6} value={lines[l.grnLineId]?.unitPrice || null}
                    onChange={(v) => set(l.grnLineId, { unitPrice: v ?? '' })} style={{ width: 130 }} />
                ),
              },
              { title: 'Sales tax', render: (_, l) => taxSelect(l.grnLineId) },
            ]}
          />
        ) : (
          <Table
            rowKey="landedCostId"
            size="small"
            pagination={false}
            loading={billable.isFetching}
            dataSource={billable.data?.charges ?? []}
            locale={{ emptyText: vendorId ? 'No posted charges of this vendor are open' : 'Pick the vendor' }}
            columns={[
              { title: 'Charge', render: (_, c) => `${c.docNo} · ${c.chargeTypeCode}` },
              { title: 'GRN', dataIndex: 'grnDocNo' },
              { title: 'Reference', render: (_, c) => c.reference ?? '—' },
              { title: 'Charged', render: (_, c) => `${c.currency} ${formatDecimal(c.chargedAmount)}` },
              { title: 'Open', render: (_, c) => formatDecimal(c.openAmount) },
              {
                title: 'Amount billed',
                render: (_, c) => (
                  <InputNumber<string> aria-label={`Amount ${c.docNo}`} stringMode min="0" precision={2} value={lines[c.landedCostId]?.amount || null}
                    onChange={(v) => set(c.landedCostId, { amount: v ?? '' })} style={{ width: 140 }} />
                ),
              },
              { title: 'Sales tax', render: (_, c) => taxSelect(c.landedCostId) },
            ]}
          />
        )}
        <Input.TextArea rows={2} aria-label="Notes" placeholder="Notes" value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} />
      </Space>
    </Modal>
  );
}

// ---------------------------------------------------------------- drawer

function InvoiceDrawer({ id, onClose, onChanged }: { id: string; onClose(): void; onChanged(): Promise<unknown> }) {
  const { can, user } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [returning, setReturning] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [reversing, setReversing] = useState(false);
  const detail = useQuery({ queryKey: [...invoicesKey, 'detail', id], queryFn: () => api<VendorInvoiceDto>(`/purch/vendor-invoices/${id}`) });
  const inv = detail.data;
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: [...invoicesKey, 'detail', id] });
    await onChanged();
  };
  const manage = can('fin.invoice.manage');
  const release = can('fin.invoice.match_release');
  const postIt = () =>
    modal.confirm({
      title: `Post ${inv?.docNo}?`,
      content: 'Posted on the invoice date. A goods line outside the price or quantity tolerance holds the whole invoice for a Finance Manager instead.',
      okText: 'Post',
      onOk: async () => {
        try {
          const res = await api<VendorInvoiceDto>(`/purch/vendor-invoices/${id}/post`, { method: 'POST', idempotencyKey: newIdempotencyKey() });
          if (res.status === 'MATCH_EXCEPTION') void message.warning('Outside the match tolerances: held for a Finance Manager');
          else void message.success('Invoice posted');
          await reload();
        } catch (err) {
          void message.error(errorText(err));
        }
      },
    });
  const lineCols = [
    { title: '#', dataIndex: 'lineNo', width: 40 },
    {
      title: inv?.invoiceType === 'GOODS' ? 'GRN line' : 'Charge',
      render: (_: unknown, l: VendorInvoiceLineDto) => (l.grnLineId ? `${l.grnDocNo} · ${l.itemCode} · lot ${l.lotNo}` : `${l.landedCostDocNo} · ${l.chargeTypeCode}`),
    },
    ...(inv?.invoiceType === 'GOODS'
      ? [
          { title: 'Qty', render: (_: unknown, l: VendorInvoiceLineDto) => formatDecimal(l.qty, 4) },
          { title: 'Price (PO)', render: (_: unknown, l: VendorInvoiceLineDto) => `${formatDecimal(l.unitPrice, 6)}${l.poUnitPrice ? ` (${formatDecimal(l.poUnitPrice, 6)})` : ''}` },
          {
            title: 'Match',
            render: (_: unknown, l: VendorInvoiceLineDto) =>
              l.inTolerance === null ? '—' : (
                <Tag color={l.inTolerance ? 'green' : 'red'}>
                  {l.inTolerance ? 'OK' : 'Outside'} · price {formatDecimal(l.priceDiffPct, 2)}%{l.qtyOver && Number(l.qtyOver) > 0 ? ` · qty +${formatDecimal(l.qtyOver, 4)}` : ''}
                </Tag>
              ),
          },
        ]
      : []),
    { title: `Amount (${inv?.currency ?? ''})`, render: (_: unknown, l: VendorInvoiceLineDto) => formatDecimal(l.amount) },
    { title: 'Tax', render: (_: unknown, l: VendorInvoiceLineDto) => (l.taxCode ? `${l.taxCode} ${formatDecimal(l.taxAmount)}` : '—') },
    ...(inv?.status === 'POSTED'
      ? [
          { title: inv.invoiceType === 'GOODS' ? 'GRNI cleared' : 'Clearing', render: (_: unknown, l: VendorInvoiceLineDto) => formatDecimal(l.clearedPkr) },
          { title: 'Price var.', render: (_: unknown, l: VendorInvoiceLineDto) => formatDecimal(l.priceVariancePkr) },
          { title: 'Exchange', render: (_: unknown, l: VendorInvoiceLineDto) => formatDecimal(l.exchangeDiffPkr) },
        ]
      : []),
  ];
  return (
    <Drawer
      open
      onClose={onClose}
      width={1000}
      title={inv ? `Vendor invoice ${inv.docNo}` : 'Vendor invoice'}
      extra={
        inv && (
          <Space>
            {manage && inv.status === 'DRAFT' && <Button onClick={() => setEditing(true)}>Edit</Button>}
            {manage && (inv.status === 'DRAFT' || inv.status === 'MATCH_EXCEPTION') && <Button danger onClick={() => setCancelling(true)}>Cancel</Button>}
            {manage && inv.status === 'DRAFT' && <Button type="primary" onClick={postIt}>Post</Button>}
            {release && inv.status === 'MATCH_EXCEPTION' && <Button onClick={() => setReturning(true)}>Return to draft</Button>}
            {release && inv.status === 'MATCH_EXCEPTION' && (
              <Button type="primary" disabled={inv.createdBy === user?.id} title={inv.createdBy === user?.id ? 'You entered it; another person releases it' : undefined} onClick={() => setReleasing(true)}>
                Release and post
              </Button>
            )}
            {can('fin.invoice.reverse') && inv.status === 'POSTED' && (
              <Button
                danger
                disabled={settledAgainst(inv)}
                title={settledAgainst(inv) ? 'Paid or debited: reverse the payment first; a debited invoice is not reversed' : undefined}
                onClick={() => setReversing(true)}
              >
                Reverse
              </Button>
            )}
          </Space>
        )
      }
    >
      {inv && (
        <>
          {inv.status === 'MATCH_EXCEPTION' && (
            <Alert style={{ marginBottom: 12 }} type="warning" showIcon message="Outside the 3-way match tolerances" description="A Finance Manager releases it with an e-signature and a reason, or returns it to the Accountant." />
          )}
          {inv.status === 'REVERSED' && (
            <Alert
              style={{ marginBottom: 12 }}
              type="error"
              showIcon
              message={`Reversed on ${formatDate(inv.reversalDate)} by ${inv.reversedByName}`}
              description={`${inv.reversalReason} · journal ${inv.reversalJournalDocNo ?? '—'}. What it billed can be billed again.`}
            />
          )}
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Vendor">{inv.vendorCode} — {inv.vendorName}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={inv.status} /></Descriptions.Item>
            <Descriptions.Item label="Type">{inv.invoiceType === 'GOODS' ? `Goods · PO ${inv.poDocNo}` : 'Charges (landed-cost clearing)'}</Descriptions.Item>
            <Descriptions.Item label="Vendor's number">{inv.vendorInvoiceNo}</Descriptions.Item>
            <Descriptions.Item label="Invoice date">{formatDate(inv.invoiceDate)}</Descriptions.Item>
            <Descriptions.Item label="Due">{formatDate(inv.dueDate)}</Descriptions.Item>
            <Descriptions.Item label="Total">
              {inv.currency} {formatDecimal(inv.totalAmount)} (goods {formatDecimal(inv.goodsAmount)} + tax {formatDecimal(inv.taxAmount)})
            </Descriptions.Item>
            <Descriptions.Item label="PKR">
              {formatDecimal(inv.totalPkr)}
              {inv.currency !== 'PKR' && ` at ${inv.exchangeRate} (rate of ${formatDate(inv.exchangeRateDate)})`}
            </Descriptions.Item>
            {inv.status === 'POSTED' && (
              <Descriptions.Item label="Paid / debited / open">
                {formatDecimal(inv.paidAmount)} / {formatDecimal(inv.debitedAmount)} / {formatDecimal(inv.openAmount)} {inv.currency}
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Posted">{inv.postedByName ? `${formatDate(inv.postingDate)} by ${inv.postedByName} · journal ${inv.journalDocNo ?? '—'}` : '—'}</Descriptions.Item>
            {inv.releasedByName && <Descriptions.Item label="Released" span={2}>by {inv.releasedByName}: {inv.releaseReason}</Descriptions.Item>}
            <Descriptions.Item label="Entered by">{inv.createdByName}</Descriptions.Item>
            {inv.notes && <Descriptions.Item label="Notes">{inv.notes}</Descriptions.Item>}
          </Descriptions>
          <Typography.Title level={5} style={{ marginTop: 16 }}>Lines</Typography.Title>
          <Table rowKey="id" size="small" pagination={false} dataSource={inv.lines} columns={lineCols} />
        </>
      )}
      {editing && inv && <InvoiceEditor invoice={inv} onClose={() => setEditing(false)} onSaved={async () => { await reload(); }} />}
      <ESignModal
        open={releasing}
        title={`Release ${inv?.docNo ?? ''}`}
        meaning="APPROVED"
        summary="Posts the invoice despite the match difference, on the invoice date. Give the reason (e.g. price rise agreed). The person who entered it cannot release it."
        okText="Release and post"
        onCancel={() => setReleasing(false)}
        onSubmit={async (r) => {
          await api(`/purch/vendor-invoices/${id}/release`, { method: 'POST', body: { signature: r.signature }, idempotencyKey: newIdempotencyKey() });
          void message.success('Invoice released and posted');
          setReleasing(false);
          await reload();
        }}
      />
      <ESignModal
        open={reversing}
        title={`Reverse ${inv?.docNo ?? ''}`}
        meaning="REVERSED"
        summary="Mirrors the invoice's journal today. The GRN quantities and charges it billed are open again and a closed PO re-opens. Give the reason (e.g. entered against the wrong PO)."
        okText="Reverse invoice"
        onCancel={() => setReversing(false)}
        onSubmit={async (r) => {
          await api(`/purch/vendor-invoices/${id}/reverse`, { method: 'POST', body: { signature: r.signature }, idempotencyKey: newIdempotencyKey() });
          void message.success('Invoice reversed');
          setReversing(false);
          await reload();
        }}
      />
      <ReasonModal
        open={returning}
        title={`Return ${inv?.docNo ?? ''} to draft?`}
        text="The Accountant corrects the bill (or cancels it) and posts it again."
        reasonRequired
        okText="Return"
        onCancel={() => setReturning(false)}
        onSubmit={async (reason) => {
          await api(`/purch/vendor-invoices/${id}/return`, { method: 'POST', body: { reason }, idempotencyKey: newIdempotencyKey() });
          setReturning(false);
          await reload();
        }}
      />
      <ReasonModal
        open={cancelling}
        title={`Cancel ${inv?.docNo ?? ''}?`}
        text="Nothing was posted. The invoice stays on record as CANCELLED; the vendor's number can be entered again."
        reasonRequired
        danger
        okText="Cancel invoice"
        onCancel={() => setCancelling(false)}
        onSubmit={async (reason) => {
          await api(`/purch/vendor-invoices/${id}/cancel`, { method: 'POST', body: { reason }, idempotencyKey: newIdempotencyKey() });
          setCancelling(false);
          await reload();
        }}
      />
    </Drawer>
  );
}

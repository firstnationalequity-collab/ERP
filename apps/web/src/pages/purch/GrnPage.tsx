// Goods received notes (M3 task 3). The Storekeeper scans (or types) the PO number, enters what arrived per line
// (manufacturer source for GMP materials, batch and dates), saves a DRAFT, then posts it: the lots are created in
// QUARANTINE, valued at PO price × the GRN-date rate, a QC sample request is opened per lot, and labels print.
// Owner 2026-11-25 (0028): an item that needs no QC is received APPROVED without a sample request; a DRAFT is
// cancelled with a reason; a POSTED GRN whose lots are untouched is reversed by the Warehouse Manager (e-signature).
import { useState } from 'react';
import dayjs from 'dayjs';
import { Alert, App, Button, DatePicker, Descriptions, Drawer, Input, InputNumber, Modal, Select, Space, Table, Typography } from 'antd';
import { BarcodeOutlined, DeleteOutlined, PrinterOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreateGrnRequest,
  GrnStatus,
  UpdateGrnRequest,
  type GrnDto,
  type GrnLineDto,
  type PoReceiptDto,
  type PoReceiptLineDto,
} from '@albert/shared';
import { api, apiBlob, errorText, newIdempotencyKey } from '../../api/client';
import { ESignModal } from '../../components/ESignModal';
import { useAuth } from '../../auth/AuthContext';
import { DataTable, statusFilter } from '../../components/DataTable';
import { PageHeader } from '../../components/PageHeader';
import { RefSelect } from '../../components/RefSelect';
import { StatusTag } from '../../components/StatusTag';
import { companyToday, formatDate, formatDecimal, formatRate, toBusinessDate } from '../../lib/format';

const grnKey = ['purch', 'grns'];

function DateInput({ value, onChange, label }: { value?: string | null; onChange(v: string | null): void; label: string }) {
  return (
    <DatePicker
      aria-label={label}
      format="DD-MM-YYYY"
      value={value ? dayjs(value) : null}
      onChange={(d) => onChange(d ? toBusinessDate(d) : null)}
      style={{ width: '100%' }}
    />
  );
}

export function GrnPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<GrnDto | 'new' | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: grnKey });
  return (
    <>
      <PageHeader title="Goods received (GRN)" extra={can('purch.grn.post') && <Button type="primary" icon={<BarcodeOutlined />} onClick={() => setEditing('new')}>Receive against a PO</Button>}>
        Scan the PO number, enter what arrived and post. Received stock goes into QUARANTINE until QC decides, with a QC sample request per lot; items that need no QC are received APPROVED.
      </PageHeader>
      <DataTable<GrnDto>
        title="Goods received notes"
        path="/purch/grns"
        queryKey={grnKey}
        filters={[statusFilter(GrnStatus)]}
        searchPlaceholder="Search number, delivery note or notes"
        onRowClick={(r) => setOpenId(r.id)}
        columns={[
          { key: 'docNo', title: 'Number' },
          { key: 'grnDate', title: 'Date', render: (r) => formatDate(r.grnDate), exportValue: (r) => formatDate(r.grnDate) },
          { key: 'poDocNo', title: 'PO' },
          { key: 'vendorCode', title: 'Vendor', render: (r) => `${r.vendorCode} — ${r.vendorName}`, exportValue: (r) => `${r.vendorCode} — ${r.vendorName}` },
          { key: 'totalPkr', title: 'Value (PKR)', render: (r) => (r.totalPkr ? formatDecimal(r.totalPkr) : '—'), exportValue: (r) => r.totalPkr ?? '', exportFormat: 'money' },
          { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
        ]}
      />
      {editing && <GrnEditor grn={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async (id) => { await refresh(); setOpenId(id); }} />}
      {openId && <GrnDrawer id={openId} onClose={() => setOpenId(null)} onEdit={(g) => setEditing(g)} onChanged={refresh} />}
    </>
  );
}

type EditLine = {
  key: number;
  poLineId: string;
  qty: string;
  containers: number;
  approvedSourceId?: string | null;
  manufacturer?: string | null;
  manufacturingSite?: string | null;
  mfrBatchNo?: string | null;
  mfgDate?: string | null;
  expiryDate?: string | null;
  retestDate?: string | null;
  notes?: string | null;
};

function GrnEditor({ grn, onClose, onSaved }: { grn: GrnDto | null; onClose(): void; onSaved(id: string): Promise<void> }) {
  const [scan, setScan] = useState('');
  const [receipt, setReceipt] = useState<PoReceiptDto | null>(null);
  const [header, setHeader] = useState({ grnDate: grn?.grnDate ?? companyToday(), locationId: grn?.locationId, deliveryNoteNo: grn?.deliveryNoteNo ?? '', notes: grn?.notes ?? '' });
  const [lines, setLines] = useState<EditLine[]>(() =>
    (grn?.lines ?? []).map((l, i) => ({
      key: i,
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
      notes: l.notes,
    })),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // An existing draft loads its PO at once; a new GRN waits for the scan.
  useQuery({
    queryKey: [...grnKey, 'receipt', grn?.poId],
    enabled: !!grn,
    queryFn: async () => {
      const r = await api<PoReceiptDto>(`/purch/grns/po-receipt?poId=${grn!.poId}`);
      setReceipt(r);
      return r;
    },
  });

  const loadPo = async () => {
    setErrors([]);
    try {
      const r = await api<PoReceiptDto>(`/purch/grns/po-receipt?docNo=${encodeURIComponent(scan.trim())}`);
      setReceipt(r);
      // One line per PO line still open, with its open quantity proposed.
      setLines(
        r.lines
          .filter((l) => Number(l.maxQty) > 0)
          .map((l, i) => ({ key: i, poLineId: l.poLineId, qty: l.openQty !== '0.0000' ? l.openQty : l.maxQty, containers: 1, approvedSourceId: l.sources.length === 1 ? l.sources[0]!.id : null })),
      );
    } catch (err) {
      setErrors([errorText(err)]);
    }
  };

  const poLine = (id: string): PoReceiptLineDto | undefined => receipt?.lines.find((l) => l.poLineId === id);
  const update = (key: number, patch: Partial<EditLine>) => setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = async () => {
    if (!receipt) return setErrors(['Scan the PO number first']);
    const body = {
      ...header,
      deliveryNoteNo: header.deliveryNoteNo || null,
      notes: header.notes || null,
      lines: lines.map(({ key: _k, ...l }) => ({ ...l, notes: l.notes || null, mfrBatchNo: l.mfrBatchNo || null, manufacturer: l.manufacturer || null, manufacturingSite: l.manufacturingSite || null })),
    };
    const parsed = grn ? UpdateGrnRequest.safeParse(body) : CreateGrnRequest.safeParse({ ...body, poId: receipt.poId });
    if (!parsed.success) {
      return setErrors(parsed.error.issues.map((i) => (i.path[0] === 'lines' && typeof i.path[1] === 'number' ? `Line ${i.path[1] + 1}: ${i.message}` : i.message)));
    }
    setBusy(true);
    setErrors([]);
    try {
      const saved = await api<GrnDto>(grn ? `/purch/grns/${grn.id}` : '/purch/grns', { method: grn ? 'PATCH' : 'POST', body: parsed.data });
      await onSaved(saved.id);
      onClose();
    } catch (err) {
      setErrors([errorText(err)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={grn ? `Edit ${grn.docNo}` : 'Receive goods against a PO'} width={1300} okText="Save draft" onOk={() => void save()} confirmLoading={busy} onCancel={onClose} maskClosable={false}>
      {errors.length > 0 && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={errors.map((e, i) => <div key={i}>{e}</div>)} />}
      {!grn && (
        <Space.Compact style={{ width: 420, marginBottom: 12 }}>
          <Input
            autoFocus
            aria-label="PO number"
            prefix={<BarcodeOutlined />}
            placeholder="Scan or type the PO number, then Enter"
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            onPressEnter={() => void loadPo()}
          />
          <Button onClick={() => void loadPo()}>Load PO</Button>
        </Space.Compact>
      )}
      {receipt && (
        <>
          <Descriptions size="small" column={4} bordered style={{ marginBottom: 12 }}>
            <Descriptions.Item label="PO">{receipt.poDocNo}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={receipt.poStatus} /></Descriptions.Item>
            <Descriptions.Item label="Vendor">{receipt.vendorCode} — {receipt.vendorName}</Descriptions.Item>
            <Descriptions.Item label="Tolerance">+{receipt.overReceiptPct}% over the ordered quantity</Descriptions.Item>
          </Descriptions>
          <Space wrap style={{ marginBottom: 12 }}>
            <div style={{ width: 160 }}><DateInput label="GRN date" value={header.grnDate} onChange={(v) => setHeader((h) => ({ ...h, grnDate: v ?? companyToday() }))} /></div>
            <div style={{ width: 260 }}><RefSelect path="/master/locations" params={{ active: 'active' }} value={header.locationId} onChange={(v) => setHeader((h) => ({ ...h, locationId: v }))} placeholder="Put into (quarantine area)" aria-label="Location" /></div>
            <Input aria-label="Delivery note" placeholder="Vendor delivery note no." style={{ width: 200 }} value={header.deliveryNoteNo} onChange={(e) => setHeader((h) => ({ ...h, deliveryNoteNo: e.target.value }))} />
            <Input aria-label="Notes" placeholder="Notes" style={{ width: 300 }} value={header.notes} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} />
          </Space>
          <Table<EditLine>
            rowKey="key"
            size="small"
            pagination={false}
            scroll={{ x: 1250 }}
            dataSource={lines}
            columns={[
              {
                title: 'Item',
                width: 220,
                render: (_, l) => {
                  const p = poLine(l.poLineId);
                  return p ? (
                    <div>
                      <div>{p.itemCode} — {p.itemName}</div>
                      <Typography.Text type="secondary">ordered {formatDecimal(p.orderedQty, 4)}, received {formatDecimal(p.receivedQty, 4)}, max {formatDecimal(p.maxQty, 4)} {p.uomCode}</Typography.Text>
                    </div>
                  ) : l.poLineId;
                },
              },
              { title: 'Qty', width: 110, render: (_, l) => <Input aria-label="Quantity" inputMode="decimal" value={l.qty} onChange={(e) => update(l.key, { qty: e.target.value.trim() })} /> },
              { title: 'Containers', width: 90, render: (_, l) => <InputNumber aria-label="Containers" min={1} max={999} value={l.containers} onChange={(v) => update(l.key, { containers: v ?? 1 })} /> },
              {
                title: 'Manufacturer / site',
                width: 260,
                render: (_, l) => {
                  const p = poLine(l.poLineId);
                  if (p?.needsSource) {
                    return (
                      <Select
                        aria-label="Approved source"
                        style={{ width: '100%' }}
                        placeholder={p.sources.length ? 'Approved source (AVL)' : 'No APPROVED source: cannot receive'}
                        value={l.approvedSourceId ?? undefined}
                        onChange={(v) => update(l.key, { approvedSourceId: v })}
                        options={p.sources.map((s) => ({ value: s.id, label: `${s.manufacturer}, ${s.manufacturingSite}` }))}
                      />
                    );
                  }
                  return (
                    <Space.Compact style={{ width: '100%' }}>
                      <Input aria-label="Manufacturer" placeholder="Manufacturer" value={l.manufacturer ?? ''} onChange={(e) => update(l.key, { manufacturer: e.target.value })} />
                      <Input aria-label="Site" placeholder="Site" value={l.manufacturingSite ?? ''} onChange={(e) => update(l.key, { manufacturingSite: e.target.value })} />
                    </Space.Compact>
                  );
                },
              },
              { title: 'Mfr batch', width: 120, render: (_, l) => <Input aria-label="Manufacturer batch" value={l.mfrBatchNo ?? ''} onChange={(e) => update(l.key, { mfrBatchNo: e.target.value })} /> },
              { title: 'Mfg', width: 130, render: (_, l) => <DateInput label="Mfg date" value={l.mfgDate} onChange={(v) => update(l.key, { mfgDate: v })} /> },
              { title: 'Expiry', width: 130, render: (_, l) => <DateInput label="Expiry date" value={l.expiryDate} onChange={(v) => update(l.key, { expiryDate: v })} /> },
              { title: 'Retest', width: 130, render: (_, l) => <DateInput label="Retest date" value={l.retestDate} onChange={(v) => update(l.key, { retestDate: v })} /> },
              {
                title: '',
                width: 110,
                render: (_, l) => (
                  <Space size={4}>
                    <Button size="small" onClick={() => setLines((cur) => [...cur, { ...l, key: Math.max(0, ...cur.map((x) => x.key)) + 1, qty: '', mfrBatchNo: null }])}>
                      Split
                    </Button>
                    <Button size="small" type="text" danger aria-label="Remove line" icon={<DeleteOutlined />} onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))} />
                  </Space>
                ),
              },
            ]}
          />
          <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
            One line per manufacturer batch: use Split when a PO line arrives in several batches. An API needs the manufacturer batch, mfg, expiry and retest dates.
          </Typography.Paragraph>
        </>
      )}
    </Modal>
  );
}

async function openLabels(grn: GrnDto): Promise<void> {
  const blob = await apiBlob(`/purch/grns/${grn.id}/labels.pdf`);
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function GrnDrawer({ id, onClose, onEdit, onChanged }: { id: string; onClose(): void; onEdit(g: GrnDto): void; onChanged(): Promise<void> }) {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [reversing, setReversing] = useState(false);
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: [...grnKey, 'detail', id], queryFn: () => api<GrnDto>(`/purch/grns/${id}`) });
  const g = detail.data;
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: [...grnKey, 'detail', id] });
    await qc.invalidateQueries({ queryKey: ['purch', 'pos'] });
    await onChanged();
  };
  const postIt = () =>
    modal.confirm({
      title: 'Post this GRN?',
      content: 'Lots are created in QUARANTINE (APPROVED for items that need no QC) and valued at the PO price × Finance’s rate for the GRN date; the stock and the journal are posted and cannot be edited afterwards. The PO’s creator and approvers cannot post it.',
      okText: 'Post',
      onOk: async () => {
        try {
          await api(`/purch/grns/${id}/post`, { method: 'POST', idempotencyKey: newIdempotencyKey() });
          void message.success('Posted: lots in QUARANTINE, QC sample requests opened');
          await reload();
        } catch (err) {
          void message.error(errorText(err));
        }
      },
    });
  return (
    <Drawer
      open
      onClose={onClose}
      width={1100}
      title={g ? `GRN ${g.docNo}` : 'GRN'}
      extra={
        g && (
          <Space>
            {can('purch.grn.post') && g.status === 'DRAFT' && <Button onClick={() => onEdit(g)}>Edit</Button>}
            {can('purch.grn.post') && g.status === 'DRAFT' && <Button danger onClick={() => setCancelling(true)}>Cancel GRN</Button>}
            {can('purch.grn.post') && g.status === 'DRAFT' && <Button type="primary" onClick={postIt}>Post</Button>}
            {can('purch.grn.reverse') && g.status === 'POSTED' && <Button danger onClick={() => setReversing(true)}>Reverse</Button>}
            {can('inv.label.print') && g.status === 'POSTED' && (
              <Button icon={<PrinterOutlined />} onClick={() => openLabels(g).catch((err) => void message.error(errorText(err)))}>Print labels</Button>
            )}
          </Space>
        )
      }
    >
      {g && (
        <>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="PO">{g.poDocNo}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={g.status} /></Descriptions.Item>
            <Descriptions.Item label="Vendor">{g.vendorCode} — {g.vendorName}</Descriptions.Item>
            <Descriptions.Item label="Date">{formatDate(g.grnDate)}</Descriptions.Item>
            <Descriptions.Item label="Location">{g.locationCode} — {g.locationName}</Descriptions.Item>
            <Descriptions.Item label="Delivery note">{g.deliveryNoteNo ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Rate">
              {g.exchangeRate ? `${g.currency} at ${formatRate(g.exchangeRate)}${g.currency !== 'PKR' ? ` (rate of ${formatDate(g.exchangeRateDate)})` : ''}` : 'Set when posted'}
            </Descriptions.Item>
            <Descriptions.Item label="Value (PKR)">{g.totalPkr ? formatDecimal(g.totalPkr) : '—'}</Descriptions.Item>
            <Descriptions.Item label="Created by">{g.createdByName}</Descriptions.Item>
            <Descriptions.Item label="Posted">{g.postedByName ? `${g.postedByName} · journal ${g.journalDocNo ?? '—'}` : '—'}</Descriptions.Item>
            {g.reversalJournalDocNo && <Descriptions.Item label="Reversed" span={2}>Reversal journal {g.reversalJournalDocNo}; the lots are kept at zero stock</Descriptions.Item>}
            {g.notes && <Descriptions.Item label="Notes" span={2}>{g.notes}</Descriptions.Item>}
          </Descriptions>
          <Typography.Title level={5} style={{ marginTop: 16 }}>Lines</Typography.Title>
          <Table<GrnLineDto>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={g.lines}
            columns={[
              { title: '#', dataIndex: 'lineNo', width: 40 },
              { title: 'Item', render: (_, l) => `${l.itemCode} — ${l.itemName}` },
              { title: 'Qty', render: (_, l) => `${formatDecimal(l.qty, 4)} ${l.uomCode} · ${l.containers} cont.` },
              { title: 'Manufacturer', render: (_, l) => [l.manufacturer, l.manufacturingSite].filter(Boolean).join(', ') || '—' },
              { title: 'Mfr batch', render: (_, l) => l.mfrBatchNo ?? '—' },
              { title: 'Expiry / retest', render: (_, l) => `${formatDate(l.expiryDate)} / ${formatDate(l.retestDate)}` },
              { title: `Price (${g.currency})`, render: (_, l) => formatRate(l.unitPrice) },
              { title: 'Unit cost (PKR)', render: (_, l) => formatRate(l.unitCost) },
              { title: 'Value (PKR)', render: (_, l) => (l.valuePkr ? formatDecimal(l.valuePkr) : '—') },
              { title: 'Lot', render: (_, l) => (l.lotNo ? <Space direction="vertical" size={0}><span>{l.lotNo}</span><StatusTag status={l.lotStatus ?? ''} /></Space> : '—') },
              { title: 'QC sample', render: (_, l) => (l.sampleRequest ? <StatusTag status={l.sampleRequest.status} /> : '—') },
            ]}
          />
        </>
      )}
      <Modal
        open={cancelling}
        title="Cancel this draft GRN?"
        okText="Cancel GRN"
        okButtonProps={{ danger: true, disabled: cancelReason.trim().length < 3 }}
        cancelText="Keep"
        onCancel={() => setCancelling(false)}
        onOk={async () => {
          try {
            await api(`/purch/grns/${id}/cancel`, { method: 'POST', body: { reason: cancelReason.trim() }, idempotencyKey: newIdempotencyKey() });
            void message.success('GRN cancelled');
            setCancelling(false);
            setCancelReason('');
            await reload();
          } catch (err) {
            void message.error(errorText(err));
          }
        }}
      >
        <Typography.Paragraph>Nothing was posted. The draft stays on record as CANCELLED.</Typography.Paragraph>
        <Input.TextArea rows={2} placeholder="Reason (at least 3 characters)" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
      </Modal>
      <ESignModal
        open={reversing}
        title={`Reverse GRN ${g?.docNo ?? ''}`}
        meaning="APPROVED"
        summary="Only while no lot was sampled, moved, reserved or changed status. The receipt and its journal are reversed today, the QC sample requests are cancelled and the PO quantities are given back. Once a sample is taken, reject the lot through QC and return it to the vendor instead."
        okText="Reverse"
        onCancel={() => setReversing(false)}
        onSubmit={async (r) => {
          await api(`/purch/grns/${id}/reverse`, { method: 'POST', body: { signature: r.signature }, idempotencyKey: newIdempotencyKey() });
          void message.success('GRN reversed');
          setReversing(false);
          await reload();
        }}
      />
    </Drawer>
  );
}

// Procurement (M3 task 2): purchase requisitions (no approval, owner Q6) and purchase orders (approval matrix in
// "My approvals"; AVL block for GMP materials). A PO converts at Finance's rate on its date when submitted.
import { useState } from 'react';
import dayjs from 'dayjs';
import { Alert, App, Button, DatePicker, Descriptions, Drawer, Input, Modal, Select, Space, Table, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ConvertPrRequest,
  CreatePoRequest,
  CreatePrRequest,
  Incoterm,
  PurchaseOrderStatus,
  PurchaseRequisitionStatus,
  UpdatePoRequest,
  type PoDto,
  type PoLineDto,
  type PrDto,
  type PrLineDto,
  type PurchaseOrderType,
} from '@albert/shared';
import { api, errorText, newIdempotencyKey } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable, statusFilter } from '../../components/DataTable';
import { PageHeader } from '../../components/PageHeader';
import { ReasonModal } from '../../components/ReasonModal';
import { RefSelect } from '../../components/RefSelect';
import { StatusTag } from '../../components/StatusTag';
import { companyToday, formatDate, formatDecimal, toBusinessDate } from '../../lib/format';

const prKey = ['purch', 'prs'];
const poKey = ['purch', 'pos'];

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

function issues(err: { issues: { path: (string | number)[]; message: string }[] }): string[] {
  return err.issues.map((i) => (i.path[0] === 'lines' && typeof i.path[1] === 'number' ? `Line ${i.path[1] + 1}: ${i.message}` : i.message));
}

// ================================================================= requisitions

export function RequisitionsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<PrDto | 'new' | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: prKey });
  return (
    <>
      <PageHeader title="Purchase requisitions" extra={can('purch.pr.manage') && <Button type="primary" onClick={() => setEditing('new')}>New requisition</Button>}>
        What is needed and when. A submitted requisition is ordered on one or more purchase orders; it needs no approval.
      </PageHeader>
      <DataTable<PrDto>
        title="Purchase requisitions"
        path="/purch/prs"
        queryKey={prKey}
        filters={[statusFilter(PurchaseRequisitionStatus)]}
        searchPlaceholder="Search number, department or notes"
        onRowClick={(r) => setOpenId(r.id)}
        columns={[
          { key: 'docNo', title: 'Number' },
          { key: 'prDate', title: 'Date', render: (r) => formatDate(r.prDate), exportValue: (r) => formatDate(r.prDate) },
          { key: 'requiredBy', title: 'Required by', render: (r) => formatDate(r.requiredBy), exportValue: (r) => formatDate(r.requiredBy) },
          { key: 'department', title: 'Department' },
          { key: 'lines', title: 'Lines', render: (r) => r.lines.length, exportValue: (r) => String(r.lines.length) },
          { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
          { key: 'createdByName', title: 'Raised by' },
        ]}
      />
      {editing && <PrEditor pr={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async (id) => { await refresh(); setOpenId(id); }} />}
      {openId && <PrDrawer id={openId} onClose={() => setOpenId(null)} onEdit={(pr) => setEditing(pr)} onChanged={refresh} />}
    </>
  );
}

type EditPrLine = { key: number; itemId?: string; qty: string; notes?: string | null };

function PrEditor({ pr, onClose, onSaved }: { pr: PrDto | null; onClose(): void; onSaved(id: string): Promise<void> }) {
  const [prDate, setPrDate] = useState<string | null>(pr?.prDate ?? companyToday());
  const [requiredBy, setRequiredBy] = useState<string | null>(pr?.requiredBy ?? null);
  const [department, setDepartment] = useState(pr?.department ?? '');
  const [notes, setNotes] = useState(pr?.notes ?? '');
  const [lines, setLines] = useState<EditPrLine[]>(() => (pr?.lines ?? []).map((l, i) => ({ key: i, itemId: l.itemId, qty: l.qty, notes: l.notes })));
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const update = (key: number, patch: Partial<EditPrLine>) => setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = async () => {
    const parsed = CreatePrRequest.safeParse({
      prDate,
      requiredBy,
      department: department || null,
      notes: notes || null,
      lines: lines.map(({ key: _k, ...l }) => ({ ...l, notes: l.notes || null })),
    });
    if (!parsed.success) return setErrors(issues(parsed.error));
    setBusy(true);
    setErrors([]);
    try {
      const saved = await api<PrDto>(pr ? `/purch/prs/${pr.id}` : '/purch/prs', { method: pr ? 'PATCH' : 'POST', body: parsed.data });
      await onSaved(saved.id);
      onClose();
    } catch (err) {
      setErrors([errorText(err)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={pr ? `Edit ${pr.docNo}` : 'New purchase requisition'} width={900} okText="Save" onOk={() => void save()} confirmLoading={busy} onCancel={onClose} maskClosable={false}>
      {errors.length > 0 && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={errors.map((e, i) => <div key={i}>{e}</div>)} />}
      <Space wrap style={{ marginBottom: 12 }}>
        <span>Date <DateInput label="Requisition date" value={prDate} onChange={setPrDate} /></span>
        <span>Required by <DateInput label="Required by" value={requiredBy} onChange={setRequiredBy} /></span>
        <Input aria-label="Department" placeholder="Department" value={department} onChange={(e) => setDepartment(e.target.value)} style={{ width: 200 }} />
      </Space>
      <Input.TextArea aria-label="Notes" placeholder="Notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ marginBottom: 12 }} />
      <Table<EditPrLine>
        rowKey="key"
        size="small"
        pagination={false}
        dataSource={lines}
        columns={[
          { title: '#', width: 40, render: (_, __, i) => i + 1 },
          { title: 'Item', width: 360, render: (_, l) => <RefSelect path="/master/items" params={{ status: 'ACTIVE' }} value={l.itemId} onChange={(v) => update(l.key, { itemId: v })} aria-label="Item" /> },
          { title: 'Quantity (base unit)', width: 150, render: (_, l) => <Input aria-label="Quantity" inputMode="decimal" value={l.qty} onChange={(e) => update(l.key, { qty: e.target.value.trim() })} /> },
          { title: 'Notes', render: (_, l) => <Input aria-label="Line notes" value={l.notes ?? ''} onChange={(e) => update(l.key, { notes: e.target.value })} /> },
          { title: '', width: 40, render: (_, l) => <Button type="text" danger aria-label="Remove line" icon={<DeleteOutlined />} onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))} /> },
        ]}
      />
      <Button icon={<PlusOutlined />} style={{ marginTop: 8 }} onClick={() => setLines((cur) => [...cur, { key: Math.max(0, ...cur.map((l) => l.key)) + 1, qty: '' }])}>Add line</Button>
    </Modal>
  );
}

function PrDrawer({ id, onClose, onEdit, onChanged }: { id: string; onClose(): void; onEdit(pr: PrDto): void; onChanged(): Promise<void> }) {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: [...prKey, 'detail', id], queryFn: () => api<PrDto>(`/purch/prs/${id}`) });
  const [cancelling, setCancelling] = useState(false);
  const [converting, setConverting] = useState(false);
  const pr = detail.data;
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: [...prKey, 'detail', id] });
    await qc.invalidateQueries({ queryKey: poKey });
    await onChanged();
  };
  const submit = () =>
    modal.confirm({
      title: 'Submit this requisition?',
      content: 'It is locked once submitted and can then be ordered on purchase orders.',
      okText: 'Submit',
      onOk: async () => {
        try {
          await api(`/purch/prs/${id}/submit`, { method: 'POST', idempotencyKey: newIdempotencyKey() });
          void message.success('Requisition submitted');
          await reload();
        } catch (err) {
          void message.error(errorText(err));
        }
      },
    });
  const manage = can('purch.pr.manage');
  const unordered = (pr?.lines ?? []).filter((l) => !l.poId);
  return (
    <Drawer
      open
      onClose={onClose}
      width={900}
      title={pr ? `Requisition ${pr.docNo}` : 'Requisition'}
      extra={
        pr && (
          <Space>
            {manage && pr.status === 'DRAFT' && <Button onClick={() => onEdit(pr)}>Edit</Button>}
            {manage && pr.status === 'DRAFT' && <Button type="primary" onClick={submit}>Submit</Button>}
            {can('purch.po.manage') && pr.status === 'SUBMITTED' && unordered.length > 0 && <Button type="primary" onClick={() => setConverting(true)}>Order lines</Button>}
            {manage && (pr.status === 'DRAFT' || pr.status === 'SUBMITTED') && <Button danger onClick={() => setCancelling(true)}>Cancel</Button>}
          </Space>
        )
      }
    >
      {pr && (
        <>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Date">{formatDate(pr.prDate)}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={pr.status} /></Descriptions.Item>
            <Descriptions.Item label="Required by">{formatDate(pr.requiredBy)}</Descriptions.Item>
            <Descriptions.Item label="Department">{pr.department}</Descriptions.Item>
            <Descriptions.Item label="Raised by">{pr.createdByName}</Descriptions.Item>
            {pr.notes && <Descriptions.Item label="Notes" span={2}>{pr.notes}</Descriptions.Item>}
          </Descriptions>
          <Typography.Title level={5} style={{ marginTop: 16 }}>Lines</Typography.Title>
          <Table<PrLineDto>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={pr.lines}
            columns={[
              { title: '#', dataIndex: 'lineNo', width: 50 },
              { title: 'Item', render: (_, l) => `${l.itemCode} — ${l.itemName}` },
              { title: 'Quantity', render: (_, l) => `${formatDecimal(l.qty, 4)} ${l.uomCode}` },
              { title: 'Ordered on', render: (_, l) => l.poDocNo ?? '—' },
              { title: 'Notes', dataIndex: 'notes' },
            ]}
          />
          <ReasonModal
            open={cancelling}
            title={`Cancel ${pr.docNo}`}
            text="A cancelled requisition cannot be ordered."
            reasonRequired
            okText="Cancel requisition"
            danger
            onCancel={() => setCancelling(false)}
            onSubmit={async (reason) => {
              await api(`/purch/prs/${id}/cancel`, { method: 'POST', body: { reason }, idempotencyKey: newIdempotencyKey() });
              setCancelling(false);
              await reload();
            }}
          />
          {converting && <ConvertModal pr={pr} lines={unordered} onClose={() => setConverting(false)} onDone={reload} />}
        </>
      )}
    </Drawer>
  );
}

// ================================================================= purchase orders

interface PoHeaderState {
  poDate: string | null;
  vendorId?: string;
  poType: PurchaseOrderType;
  currency: string;
  incoterm?: Incoterm | null;
  deliveryDate?: string | null;
  notes?: string | null;
}

function PoHeaderFields({ h, set }: { h: PoHeaderState; set(patch: Partial<PoHeaderState>): void }) {
  return (
    <Space wrap style={{ marginBottom: 12 }} align="start">
      <span>PO date <DateInput label="PO date" value={h.poDate} onChange={(v) => set({ poDate: v })} /></span>
      <div style={{ width: 320 }}>
        Vendor <RefSelect path="/master/vendors" params={{ status: 'ACTIVE' }} value={h.vendorId} onChange={(v) => set({ vendorId: v })} aria-label="Vendor" />
      </div>
      <span>
        Type{' '}
        <Select<PurchaseOrderType>
          aria-label="PO type"
          value={h.poType}
          onChange={(v) => set({ poType: v, currency: v === 'LOCAL' ? 'PKR' : h.currency === 'PKR' ? 'USD' : h.currency, incoterm: v === 'LOCAL' ? null : h.incoterm })}
          options={[{ value: 'LOCAL', label: 'Local (PKR)' }, { value: 'IMPORT', label: 'Import' }]}
          style={{ width: 140 }}
        />
      </span>
      {h.poType === 'IMPORT' && (
        <>
          <span>Currency <Input aria-label="Currency" value={h.currency} maxLength={3} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} style={{ width: 80 }} /></span>
          <span>
            Incoterm{' '}
            <Select<Incoterm> aria-label="Incoterm" value={h.incoterm ?? undefined} onChange={(v) => set({ incoterm: v })} options={Incoterm.map((i) => ({ value: i, label: i }))} style={{ width: 100 }} />
          </span>
        </>
      )}
      <span>Delivery by <DateInput label="Delivery date" value={h.deliveryDate} onChange={(v) => set({ deliveryDate: v })} /></span>
    </Space>
  );
}

function ConvertModal({ pr, lines, onClose, onDone }: { pr: PrDto; lines: PrLineDto[]; onClose(): void; onDone(): Promise<void> }) {
  const { message } = App.useApp();
  const [h, setH] = useState<PoHeaderState>({ poDate: companyToday(), poType: 'LOCAL', currency: 'PKR' });
  const [picked, setPicked] = useState<Record<string, string>>({}); // prLineId → unit price
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const parsed = ConvertPrRequest.safeParse({ ...h, lines: Object.entries(picked).map(([prLineId, unitPrice]) => ({ prLineId, unitPrice })) });
    if (!parsed.success) return setErrors(issues(parsed.error));
    setBusy(true);
    try {
      const po = await api<PoDto>(`/purch/prs/${pr.id}/convert`, { method: 'POST', body: parsed.data, idempotencyKey: newIdempotencyKey() });
      void message.success(`${po.docNo} created as DRAFT`);
      await onDone();
      onClose();
    } catch (err) {
      setErrors([errorText(err)]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={`Order lines of ${pr.docNo}`} width={1000} okText="Create purchase order" onOk={() => void save()} confirmLoading={busy} onCancel={onClose} maskClosable={false}>
      <Typography.Paragraph type="secondary">Pick the lines this vendor supplies and give their unit prices. GMP materials need an approved source (AVL) for the vendor.</Typography.Paragraph>
      {errors.length > 0 && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={errors.map((e, i) => <div key={i}>{e}</div>)} />}
      <PoHeaderFields h={h} set={(p) => setH((cur) => ({ ...cur, ...p }))} />
      <Table<PrLineDto>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={lines}
        rowSelection={{
          selectedRowKeys: Object.keys(picked),
          onChange: (keys) => setPicked((cur) => Object.fromEntries(keys.map((k) => [String(k), cur[String(k)] ?? '']))),
        }}
        columns={[
          { title: 'Item', render: (_, l) => `${l.itemCode} — ${l.itemName}` },
          { title: 'Quantity', render: (_, l) => `${formatDecimal(l.qty, 4)} ${l.uomCode}` },
          {
            title: `Unit price (${h.currency})`,
            width: 160,
            render: (_, l) => (
              <Input aria-label="Unit price" inputMode="decimal" disabled={!(l.id in picked)} value={picked[l.id] ?? ''} onChange={(e) => setPicked((cur) => ({ ...cur, [l.id]: e.target.value.trim() }))} />
            ),
          },
        ]}
      />
    </Modal>
  );
}

export function PurchaseOrdersPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<PoDto | 'new' | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: poKey });
  return (
    <>
      <PageHeader title="Purchase orders" extra={can('purch.po.manage') && <Button type="primary" onClick={() => setEditing('new')}>New purchase order</Button>}>
        Local and import orders. Submitting sends the PO to the approvers set by the approval matrix on its PKR value; GMP materials need an approved source (AVL).
      </PageHeader>
      <DataTable<PoDto>
        title="Purchase orders"
        path="/purch/pos"
        queryKey={poKey}
        filters={[statusFilter(PurchaseOrderStatus)]}
        searchPlaceholder="Search number or notes"
        onRowClick={(r) => setOpenId(r.id)}
        columns={[
          { key: 'docNo', title: 'Number' },
          { key: 'poDate', title: 'Date', render: (r) => formatDate(r.poDate), exportValue: (r) => formatDate(r.poDate) },
          { key: 'vendorCode', title: 'Vendor', render: (r) => `${r.vendorCode} — ${r.vendorName}`, exportValue: (r) => `${r.vendorCode} — ${r.vendorName}` },
          { key: 'poType', title: 'Type' },
          { key: 'totalAmount', title: 'Total', render: (r) => `${r.currency} ${formatDecimal(r.totalAmount)}`, exportValue: (r) => r.totalAmount, exportFormat: 'money' },
          { key: 'currency', title: 'Currency' },
          { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
        ]}
      />
      {editing && <PoEditor po={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async (id) => { await refresh(); setOpenId(id); }} />}
      {openId && <PoDrawer id={openId} onClose={() => setOpenId(null)} onEdit={(po) => setEditing(po)} onChanged={refresh} />}
    </>
  );
}

type EditPoLine = { key: number; itemId?: string; qty: string; unitPrice: string; notes?: string | null; prLineId?: string | null; prDocNo?: string | null };

function PoEditor({ po, onClose, onSaved }: { po: PoDto | null; onClose(): void; onSaved(id: string): Promise<void> }) {
  const [h, setH] = useState<PoHeaderState>(
    po
      ? { poDate: po.poDate, vendorId: po.vendorId, poType: po.poType, currency: po.currency, incoterm: po.incoterm, deliveryDate: po.deliveryDate, notes: po.notes }
      : { poDate: companyToday(), poType: 'LOCAL', currency: 'PKR' },
  );
  const [lines, setLines] = useState<EditPoLine[]>(() =>
    (po?.lines ?? []).map((l, i) => ({ key: i, itemId: l.itemId, qty: l.qty, unitPrice: l.unitPrice, notes: l.notes, prLineId: l.prLineId, prDocNo: l.prDocNo })),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const update = (key: number, patch: Partial<EditPoLine>) => setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = async () => {
    const lineBodies = lines.map(({ key: _k, prDocNo: _d, prLineId, ...l }) => ({ ...l, notes: l.notes || null, ...(po ? { prLineId: prLineId ?? null } : {}) }));
    const body = { ...h, notes: h.notes || null, lines: lineBodies };
    const parsed = po ? UpdatePoRequest.safeParse(body) : CreatePoRequest.safeParse(body);
    if (!parsed.success) return setErrors(issues(parsed.error));
    setBusy(true);
    setErrors([]);
    try {
      const saved = await api<PoDto>(po ? `/purch/pos/${po.id}` : '/purch/pos', { method: po ? 'PATCH' : 'POST', body: parsed.data });
      await onSaved(saved.id);
      onClose();
    } catch (err) {
      setErrors([errorText(err)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={po ? `Edit ${po.docNo}` : 'New purchase order'} width={1100} okText="Save" onOk={() => void save()} confirmLoading={busy} onCancel={onClose} maskClosable={false}>
      {errors.length > 0 && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={errors.map((e, i) => <div key={i}>{e}</div>)} />}
      <PoHeaderFields h={h} set={(p) => setH((cur) => ({ ...cur, ...p }))} />
      <Input.TextArea aria-label="Notes" placeholder="Notes" rows={2} value={h.notes ?? ''} onChange={(e) => setH((cur) => ({ ...cur, notes: e.target.value }))} style={{ marginBottom: 12 }} />
      <Table<EditPoLine>
        rowKey="key"
        size="small"
        pagination={false}
        dataSource={lines}
        columns={[
          { title: '#', width: 40, render: (_, __, i) => i + 1 },
          {
            title: 'Item',
            width: 340,
            render: (_, l) =>
              l.prLineId ? (
                <span>
                  <RefSelect path="/master/items" value={l.itemId} onChange={() => undefined} disabled aria-label="Item" /> from {l.prDocNo}
                </span>
              ) : (
                <RefSelect path="/master/items" params={{ status: 'ACTIVE' }} value={l.itemId} onChange={(v) => update(l.key, { itemId: v })} aria-label="Item" />
              ),
          },
          { title: 'Quantity', width: 130, render: (_, l) => <Input aria-label="Quantity" inputMode="decimal" value={l.qty} onChange={(e) => update(l.key, { qty: e.target.value.trim() })} /> },
          { title: `Unit price (${h.currency})`, width: 140, render: (_, l) => <Input aria-label="Unit price" inputMode="decimal" value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value.trim() })} /> },
          { title: 'Notes', render: (_, l) => <Input aria-label="Line notes" value={l.notes ?? ''} onChange={(e) => update(l.key, { notes: e.target.value })} /> },
          {
            title: '',
            width: 40,
            render: (_, l) =>
              !l.prLineId && <Button type="text" danger aria-label="Remove line" icon={<DeleteOutlined />} onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))} />,
          },
        ]}
      />
      <Button icon={<PlusOutlined />} style={{ marginTop: 8 }} onClick={() => setLines((cur) => [...cur, { key: Math.max(0, ...cur.map((l) => l.key)) + 1, qty: '', unitPrice: '' }])}>Add line</Button>
    </Modal>
  );
}

function PoDrawer({ id, onClose, onEdit, onChanged }: { id: string; onClose(): void; onEdit(po: PoDto): void; onChanged(): Promise<void> }) {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: [...poKey, 'detail', id], queryFn: () => api<PoDto>(`/purch/pos/${id}`) });
  const [cancelling, setCancelling] = useState(false);
  const po = detail.data;
  const manage = can('purch.po.manage');
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: [...poKey, 'detail', id] });
    await onChanged();
  };
  const submit = () =>
    modal.confirm({
      title: 'Submit for approval?',
      content: 'The PO is locked while it is approved. An import PO is valued in PKR at Finance’s rate on the PO date.',
      okText: 'Submit',
      onOk: async () => {
        try {
          await api(`/purch/pos/${id}/submit`, { method: 'POST', idempotencyKey: newIdempotencyKey() });
          void message.success('Submitted; it waits in the approvers’ inbox');
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
      width={1000}
      title={po ? `Purchase order ${po.docNo}` : 'Purchase order'}
      extra={
        po && (
          <Space>
            {manage && po.status === 'DRAFT' && <Button onClick={() => onEdit(po)}>Edit</Button>}
            {manage && po.status === 'DRAFT' && <Button type="primary" onClick={submit}>Submit for approval</Button>}
            {manage && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(po.status) && <Button danger onClick={() => setCancelling(true)}>Cancel PO</Button>}
          </Space>
        )
      }
    >
      {po && (
        <>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Vendor">{po.vendorCode} — {po.vendorName}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={po.status} /></Descriptions.Item>
            <Descriptions.Item label="Date">{formatDate(po.poDate)}</Descriptions.Item>
            <Descriptions.Item label="Type">{po.poType}{po.incoterm ? ` · ${po.incoterm}` : ''}</Descriptions.Item>
            <Descriptions.Item label="Total">{po.currency} {formatDecimal(po.totalAmount)}</Descriptions.Item>
            <Descriptions.Item label="PKR (approval value)">
              {po.totalPkr ? `PKR ${formatDecimal(po.totalPkr)} at ${formatDecimal(po.exchangeRate, 4)}` : 'Set when submitted'}
            </Descriptions.Item>
            <Descriptions.Item label="Delivery by">{formatDate(po.deliveryDate)}</Descriptions.Item>
            <Descriptions.Item label="Created by">{po.createdByName}</Descriptions.Item>
            {po.notes && <Descriptions.Item label="Notes" span={2}>{po.notes}</Descriptions.Item>}
          </Descriptions>
          {po.status === 'PENDING_APPROVAL' && <Alert style={{ marginTop: 12 }} type="info" showIcon message="Waiting for approval (My approvals). The creator and submitter cannot approve it." />}
          <Typography.Title level={5} style={{ marginTop: 16 }}>Lines</Typography.Title>
          <Table<PoLineDto>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={po.lines}
            columns={[
              { title: '#', dataIndex: 'lineNo', width: 50 },
              { title: 'Item', render: (_, l) => `${l.itemCode} — ${l.itemName}` },
              { title: 'Quantity', render: (_, l) => `${formatDecimal(l.qty, 4)} ${l.uomCode}` },
              { title: 'Unit price', render: (_, l) => formatDecimal(l.unitPrice) },
              { title: 'Amount', render: (_, l) => formatDecimal(l.lineAmount) },
              { title: 'Received', render: (_, l) => formatDecimal(l.receivedQty, 4) },
              { title: 'Requisition', render: (_, l) => l.prDocNo ?? '—' },
            ]}
          />
          <ReasonModal
            open={cancelling}
            title={`Cancel ${po.docNo}`}
            text="Only a PO with no receipts can be cancelled. A pending approval is cancelled with it."
            reasonRequired
            okText="Cancel PO"
            danger
            onCancel={() => setCancelling(false)}
            onSubmit={async (reason) => {
              await api(`/purch/pos/${id}/cancel`, { method: 'POST', body: { reason }, idempotencyKey: newIdempotencyKey() });
              setCancelling(false);
              await reload();
            }}
          />
        </>
      )}
    </Drawer>
  );
}

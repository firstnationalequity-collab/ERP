// Master formulas: the Production Manager drafts a version (lines: API with assay basis, one filler line when there
// is an API, other excipients), submits it, and the QA Manager approves it in "My approvals". Approving a version
// makes the previous APPROVED one OBSOLETE. A submitted or approved version is locked.
import { useState } from 'react';
import { Alert, App, Button, Checkbox, Descriptions, Drawer, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AssayBasis,
  CreateFormulaRequest,
  FormulaStatus,
  SetFormulaLinesRequest,
  UpdateFormulaRequest,
  type FormulaDto,
  type FormulaLineDto,
  type FormulaLineInput,
} from '@albert/shared';
import { api, errorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable, statusFilter } from '../../components/DataTable';
import { DocForm } from '../../components/DocForm';
import { PageHeader } from '../../components/PageHeader';
import { RefLabel, RefSelect } from '../../components/RefSelect';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime, formatDecimal } from '../../lib/format';

const queryKey = ['master', 'formulas'];

export function FormulasPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey });

  return (
    <>
      <PageHeader title="Master formulas" extra={can('master.formula.manage') && <Button type="primary" onClick={() => setCreating(true)}>New version</Button>}>
        Bill of materials per product and version. QA approves each version; only one version per product is APPROVED at a time.
      </PageHeader>
      <DataTable<FormulaDto>
        title="Master formulas"
        path="/master/formulas"
        queryKey={queryKey}
        filters={[statusFilter(FormulaStatus)]}
        searchPlaceholder="Search product code or name"
        onRowClick={(r) => setOpenId(r.id)}
        columns={[
          { key: 'productItemCode', title: 'Product', render: (r) => `${r.productItemCode} — ${r.productItemName}`, exportValue: (r) => `${r.productItemCode} — ${r.productItemName}` },
          { key: 'version', title: 'Version' },
          { key: 'batchSize', title: 'Batch size', render: (r) => <>{formatDecimal(r.batchSize, 4)} <RefLabel path="/master/uoms" id={r.batchUomId} /></>, exportValue: (r) => r.batchSize, exportFormat: 'quantity' },
          { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
          { key: 'updatedAt', title: 'Updated', render: (r) => formatDateTime(r.updatedAt), exportValue: (r) => formatDateTime(r.updatedAt) },
        ]}
        actions={(r) => <Button type="link" onClick={() => setOpenId(r.id)}>Open</Button>}
      />
      <DocForm
        open={creating}
        title="New formula version"
        mode="create"
        schema={CreateFormulaRequest}
        intro={<Typography.Paragraph type="secondary">A first version needs its batch size. A later version copies the latest version's batch size and lines unless you give new ones.</Typography.Paragraph>}
        fields={[
          { name: 'productId', label: 'Product', kind: 'ref', path: '/master/products', params: { active: 'active' } },
          { name: 'batchSize', label: 'Batch size', kind: 'decimal' },
          { name: 'batchUomId', label: 'Batch unit', kind: 'ref', path: '/master/uoms', params: { active: 'active' } },
          { name: 'notes', label: 'Notes (what changed)', kind: 'textarea' },
        ]}
        onCancel={() => setCreating(false)}
        onSubmit={async (values) => {
          const f = await api<FormulaDto>('/master/formulas', { method: 'POST', body: values });
          void message.success(`Version ${f.version} created as DRAFT`);
          setCreating(false);
          await refresh();
          setOpenId(f.id);
        }}
      />
      {openId && <FormulaDrawer id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </>
  );
}

function FormulaDrawer({ id, onClose, onChanged }: { id: string; onClose(): void; onChanged(): Promise<void> }) {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: [...queryKey, 'detail', id], queryFn: () => api<FormulaDto>(`/master/formulas/${id}`) });
  const [editHeader, setEditHeader] = useState(false);
  const [editLines, setEditLines] = useState(false);
  const f = detail.data;
  const editable = f?.status === 'DRAFT' && can('master.formula.manage');
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: [...queryKey, 'detail', id] });
    await onChanged();
  };

  const submit = () =>
    modal.confirm({
      title: 'Submit for QA approval?',
      content: 'The version is locked while QA reviews it. If QA rejects it, it returns to DRAFT.',
      okText: 'Submit',
      onOk: async () => {
        try {
          await api(`/master/formulas/${id}/submit`, { method: 'POST' });
          void message.success('Submitted; it waits in the QA Manager’s approvals');
          await reload();
        } catch (err) {
          void message.error(errorText(err));
        }
      },
    });

  return (
    <Drawer open onClose={onClose} width={860} title={f ? `${f.productItemCode} — version ${f.version}` : 'Formula'}
      extra={editable && <Space><Button onClick={() => setEditHeader(true)}>Edit header</Button><Button onClick={() => setEditLines(true)}>Edit lines</Button><Button type="primary" onClick={submit}>Submit for approval</Button></Space>}>
      {f && (
        <>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Product">{f.productItemCode} — {f.productItemName}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={f.status} /></Descriptions.Item>
            <Descriptions.Item label="Batch size">{formatDecimal(f.batchSize, 4)} <RefLabel path="/master/uoms" id={f.batchUomId} /></Descriptions.Item>
            <Descriptions.Item label="Version">{f.version}</Descriptions.Item>
            {f.notes && <Descriptions.Item label="Notes" span={2}>{f.notes}</Descriptions.Item>}
          </Descriptions>
          {f.status === 'PENDING_APPROVAL' && <Alert style={{ marginTop: 12 }} type="info" showIcon message="Waiting for the QA Manager’s approval (My approvals)." />}
          <Typography.Title level={5} style={{ marginTop: 16 }}>Lines</Typography.Title>
          <FormulaLinesTable lines={f.lines ?? []} />
          {editHeader && (
            <DocForm
              open
              title="Edit formula header"
              mode="edit"
              schema={UpdateFormulaRequest}
              initialValues={{ batchSize: f.batchSize, batchUomId: f.batchUomId, notes: f.notes ?? '' }}
              fields={[
                { name: 'batchSize', label: 'Batch size', kind: 'decimal' },
                { name: 'batchUomId', label: 'Batch unit', kind: 'ref', path: '/master/uoms', params: { active: 'active' } },
                { name: 'notes', label: 'Notes', kind: 'textarea', nullable: true },
              ]}
              onCancel={() => setEditHeader(false)}
              onSubmit={async (values) => {
                await api(`/master/formulas/${id}`, { method: 'PATCH', body: values });
                setEditHeader(false);
                await reload();
              }}
            />
          )}
          {editLines && <LinesEditor formula={f} onClose={() => setEditLines(false)} onSaved={reload} />}
        </>
      )}
    </Drawer>
  );
}

export function FormulaLinesTable({ lines }: { lines: FormulaLineDto[] }) {
  return (
    <Table<FormulaLineDto>
      rowKey="id"
      size="small"
      pagination={false}
      dataSource={lines}
      scroll={{ x: true }}
      locale={{ emptyText: 'No lines yet' }}
      columns={[
        { title: '#', dataIndex: 'lineNo', width: 50 },
        { title: 'Item', render: (_, l) => `${l.itemCode} — ${l.itemName}` },
        { title: 'Qty per batch', render: (_, l) => <>{formatDecimal(l.qtyPerBatch, 4)} <RefLabel path="/master/uoms" id={l.uomId} /></> },
        {
          title: 'Role',
          render: (_, l) => (
            <>
              {l.isApi && <Tag color="blue">API · {l.assayBasis?.replace('_', ' ')}</Tag>}
              {l.isFiller && <Tag color="gold">FILLER</Tag>}
            </>
          ),
        },
      ]}
    />
  );
}

type EditLine = { key: number; itemId?: string; qtyPerBatch: string; uomId?: string; isApi: boolean; isFiller: boolean; assayBasis?: AssayBasis | null };

function LinesEditor({ formula, onClose, onSaved }: { formula: FormulaDto; onClose(): void; onSaved(): Promise<void> }) {
  const { message } = App.useApp();
  const [lines, setLines] = useState<EditLine[]>(() =>
    (formula.lines ?? []).map((l, i) => ({ key: i, itemId: l.itemId, qtyPerBatch: l.qtyPerBatch, uomId: l.uomId, isApi: l.isApi, isFiller: l.isFiller, assayBasis: l.assayBasis })),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const update = (key: number, patch: Partial<EditLine>) => setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = async () => {
    const body = { lines: lines.map(({ key: _k, ...l }) => ({ ...l, assayBasis: l.isApi ? (l.assayBasis ?? null) : null })) };
    const parsed = SetFormulaLinesRequest.safeParse(body);
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => `Line ${typeof i.path[1] === 'number' ? i.path[1] + 1 : ''}: ${i.message}`));
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      await api(`/master/formulas/${formula.id}/lines`, { method: 'PUT', body: parsed.data satisfies { lines: FormulaLineInput[] } });
      void message.success('Lines saved');
      await onSaved();
      onClose();
    } catch (err) {
      setErrors([errorText(err)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={`Lines of ${formula.productItemCode} v${formula.version}`} width={1000} okText="Save lines" onOk={() => void save()} confirmLoading={busy} onCancel={onClose} maskClosable={false}>
      <Typography.Paragraph type="secondary">
        An API line needs its assay basis (as is / dried). A formula with an API needs exactly one filler line, which absorbs the potency adjustment.
      </Typography.Paragraph>
      {errors.length > 0 && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={errors.map((e, i) => <div key={i}>{e}</div>)} />}
      <Table<EditLine>
        rowKey="key"
        size="small"
        pagination={false}
        dataSource={lines}
        scroll={{ x: true }}
        columns={[
          { title: '#', width: 40, render: (_, __, i) => i + 1 },
          { title: 'Item', width: 300, render: (_, l) => <RefSelect path="/master/items" params={{ status: 'ACTIVE' }} value={l.itemId} onChange={(v) => update(l.key, { itemId: v })} aria-label="Item" /> },
          { title: 'Qty per batch', width: 130, render: (_, l) => <Input aria-label="Quantity per batch" inputMode="decimal" value={l.qtyPerBatch} onChange={(e) => update(l.key, { qtyPerBatch: e.target.value.trim() })} /> },
          { title: 'Unit', width: 140, render: (_, l) => <RefSelect path="/master/uoms" params={{ active: 'active' }} value={l.uomId} onChange={(v) => update(l.key, { uomId: v })} aria-label="Unit" /> },
          { title: 'API', width: 50, render: (_, l) => <Checkbox aria-label="API" checked={l.isApi} onChange={(e) => update(l.key, { isApi: e.target.checked, isFiller: e.target.checked ? false : l.isFiller })} /> },
          {
            title: 'Assay basis',
            width: 120,
            render: (_, l) => (
              <Select aria-label="Assay basis" disabled={!l.isApi} value={l.assayBasis ?? undefined} onChange={(v: AssayBasis) => update(l.key, { assayBasis: v })} options={AssayBasis.map((a) => ({ value: a, label: a.replace('_', ' ') }))} style={{ width: '100%' }} />
            ),
          },
          { title: 'Filler', width: 60, render: (_, l) => <Checkbox aria-label="Filler" checked={l.isFiller} disabled={l.isApi} onChange={(e) => update(l.key, { isFiller: e.target.checked })} /> },
          { title: '', width: 40, render: (_, l) => <Button type="text" danger aria-label="Remove line" icon={<DeleteOutlined />} onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))} /> },
        ]}
      />
      <Button icon={<PlusOutlined />} style={{ marginTop: 8 }} onClick={() => setLines((cur) => [...cur, { key: Math.max(0, ...cur.map((l) => l.key)) + 1, qtyPerBatch: '', isApi: false, isFiller: false }])}>
        Add line
      </Button>
    </Modal>
  );
}

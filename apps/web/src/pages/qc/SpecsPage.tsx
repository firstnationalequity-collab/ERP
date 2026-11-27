// QC specifications (M4 task 1): the QC Analyst drafts a version per item (tests with limits: numeric min / max or a
// text limit; one assay and one water test), submits it, and a QC Manager approves it with an e-signature or returns
// it to DRAFT with a reason. Approving a version makes the previous APPROVED one OBSOLETE. The drafter or submitter
// never approves.
import { useState } from 'react';
import { Alert, App, Button, Checkbox, Descriptions, Drawer, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreateSpecRequest,
  QcResultType,
  QcSpecStatus,
  SetSpecTestsRequest,
  UpdateSpecRequest,
  type SpecDto,
  type SpecTestDto,
} from '@albert/shared';
import { api, errorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable, statusFilter } from '../../components/DataTable';
import { DocForm } from '../../components/DocForm';
import { ESignModal } from '../../components/ESignModal';
import { PageHeader } from '../../components/PageHeader';
import { ReasonModal } from '../../components/ReasonModal';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime } from '../../lib/format';

const queryKey = ['qc', 'specs'];

/** "98.000000" → "98"; "0.500000" → "0.5" (display only; the value stays a string). */
const trimLimit = (v: string | null) => (v === null ? null : v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

export function limitText(t: Pick<SpecTestDto, 'resultType' | 'minValue' | 'maxValue' | 'textLimit' | 'unit'>): string {
  if (t.resultType === 'TEXT') return t.textLimit ?? '';
  const unit = t.unit ? ` ${t.unit}` : '';
  const min = trimLimit(t.minValue);
  const max = trimLimit(t.maxValue);
  if (min !== null && max !== null) return `${min} – ${max}${unit}`;
  if (min !== null) return `≥ ${min}${unit}`;
  return `≤ ${max ?? ''}${unit}`;
}

export function SpecsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey });

  return (
    <>
      <PageHeader title="QC specifications" extra={can('qc.spec.manage') && <Button type="primary" onClick={() => setCreating(true)}>New version</Button>}>
        Tests and limits per item and version. A QC Manager approves each version with an e-signature; only one version per item is APPROVED at a time.
      </PageHeader>
      <DataTable<SpecDto>
        title="QC specifications"
        path="/qc/specs"
        queryKey={queryKey}
        filters={[statusFilter(QcSpecStatus)]}
        searchPlaceholder="Search item code or name"
        onRowClick={(r) => setOpenId(r.id)}
        columns={[
          { key: 'itemCode', title: 'Item', render: (r) => `${r.itemCode} — ${r.itemName}`, exportValue: (r) => `${r.itemCode} — ${r.itemName}` },
          { key: 'itemType', title: 'Type' },
          { key: 'version', title: 'Version' },
          { key: 'reference', title: 'Reference', render: (r) => r.reference ?? '—', exportValue: (r) => r.reference ?? '' },
          { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
          { key: 'updatedAt', title: 'Updated', render: (r) => formatDateTime(r.updatedAt), exportValue: (r) => formatDateTime(r.updatedAt) },
        ]}
        actions={(r) => <Button type="link" onClick={() => setOpenId(r.id)}>Open</Button>}
      />
      <DocForm
        open={creating}
        title="New specification version"
        mode="create"
        schema={CreateSpecRequest}
        intro={<Typography.Paragraph type="secondary">A later version copies the latest version's reference, notes and tests; edit them before you submit.</Typography.Paragraph>}
        fields={[
          { name: 'itemId', label: 'Item (RM, PM, API, excipient, bulk or FG)', kind: 'ref', path: '/master/items' },
          { name: 'reference', label: 'Reference (pharmacopoeia, in-house method)', kind: 'text' },
          { name: 'notes', label: 'Notes (what changed)', kind: 'textarea' },
        ]}
        onCancel={() => setCreating(false)}
        onSubmit={async (values) => {
          const s = await api<SpecDto>('/qc/specs', { method: 'POST', body: values });
          void message.success(`Version ${s.version} created as DRAFT`);
          setCreating(false);
          await refresh();
          setOpenId(s.id);
        }}
      />
      {openId && <SpecDrawer id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </>
  );
}

function SpecDrawer({ id, onClose, onChanged }: { id: string; onClose(): void; onChanged(): Promise<void> }) {
  const { can, user } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: [...queryKey, 'detail', id], queryFn: () => api<SpecDto>(`/qc/specs/${id}`) });
  const [editHeader, setEditHeader] = useState(false);
  const [editTests, setEditTests] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const s = detail.data;
  const editable = s?.status === 'DRAFT' && can('qc.spec.manage');
  const mine = s && user && (s.createdBy === user.id || s.submittedBy === user.id);
  const decidable = s?.status === 'PENDING_APPROVAL' && can('qc.spec.approve');
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: [...queryKey, 'detail', id] });
    await onChanged();
  };

  const submit = () =>
    modal.confirm({
      title: 'Submit for QC Manager approval?',
      content: 'The version is locked while it is reviewed. If it is rejected, it returns to DRAFT.',
      okText: 'Submit',
      onOk: async () => {
        try {
          await api(`/qc/specs/${id}/submit`, { method: 'POST' });
          void message.success('Submitted for approval');
          await reload();
        } catch (err) {
          void message.error(errorText(err));
        }
      },
    });

  return (
    <Drawer open onClose={onClose} width={900} title={s ? `${s.itemCode} — specification v${s.version}` : 'Specification'}
      extra={
        <Space>
          {editable && <><Button onClick={() => setEditHeader(true)}>Edit header</Button><Button onClick={() => setEditTests(true)}>Edit tests</Button><Button type="primary" onClick={submit}>Submit for approval</Button></>}
          {decidable && <><Button onClick={() => setRejecting(true)} disabled={!!mine}>Reject</Button><Button type="primary" onClick={() => setApproving(true)} disabled={!!mine}>Approve</Button></>}
        </Space>
      }>
      {s && (
        <>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Item">{s.itemCode} — {s.itemName} ({s.itemType})</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={s.status} /></Descriptions.Item>
            <Descriptions.Item label="Version">{s.version}</Descriptions.Item>
            <Descriptions.Item label="Reference">{s.reference ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Drafted by">{s.userNames[s.createdBy] ?? s.createdBy}</Descriptions.Item>
            <Descriptions.Item label="Approved by">{s.approvedBy ? `${s.userNames[s.approvedBy] ?? s.approvedBy} · ${formatDateTime(s.approvedAt)}` : '—'}</Descriptions.Item>
            {s.notes && <Descriptions.Item label="Notes" span={2}>{s.notes}</Descriptions.Item>}
          </Descriptions>
          {decidable && mine && <Alert style={{ marginTop: 12 }} type="warning" showIcon message="You drafted or submitted this version; another QC Manager approves it." />}
          {s.status === 'PENDING_APPROVAL' && !decidable && <Alert style={{ marginTop: 12 }} type="info" showIcon message="Waiting for a QC Manager’s approval." />}
          <Typography.Title level={5} style={{ marginTop: 16 }}>Tests</Typography.Title>
          <SpecTestsTable tests={s.tests ?? []} />
          {editHeader && (
            <DocForm
              open
              title="Edit specification header"
              mode="edit"
              schema={UpdateSpecRequest}
              initialValues={{ reference: s.reference ?? '', notes: s.notes ?? '' }}
              fields={[
                { name: 'reference', label: 'Reference', kind: 'text', nullable: true },
                { name: 'notes', label: 'Notes', kind: 'textarea', nullable: true },
              ]}
              onCancel={() => setEditHeader(false)}
              onSubmit={async (values) => {
                await api(`/qc/specs/${id}`, { method: 'PATCH', body: values });
                setEditHeader(false);
                await reload();
              }}
            />
          )}
          {editTests && <TestsEditor spec={s} onClose={() => setEditTests(false)} onSaved={reload} />}
          <ESignModal
            open={approving}
            title={`Approve ${s.itemCode} specification v${s.version}`}
            meaning="APPROVED"
            summary="Lots of this item are tested against this version from now on; the previous APPROVED version becomes OBSOLETE."
            okText="Approve"
            onCancel={() => setApproving(false)}
            onSubmit={async (r) => {
              await api(`/qc/specs/${id}/approve`, { method: 'POST', body: { signature: r.signature } });
              void message.success('Specification approved');
              setApproving(false);
              await reload();
            }}
          />
          <ReasonModal
            open={rejecting}
            title="Return to DRAFT"
            text="The analyst sees your reason and edits the version."
            reasonRequired
            okText="Reject"
            danger
            onCancel={() => setRejecting(false)}
            onSubmit={async (reason) => {
              await api(`/qc/specs/${id}/reject`, { method: 'POST', body: { reason } });
              setRejecting(false);
              await reload();
            }}
          />
        </>
      )}
    </Drawer>
  );
}

export function SpecTestsTable({ tests }: { tests: SpecTestDto[] }) {
  return (
    <Table<SpecTestDto>
      rowKey="id"
      size="small"
      pagination={false}
      dataSource={tests}
      scroll={{ x: true }}
      locale={{ emptyText: 'No tests yet' }}
      columns={[
        { title: '#', dataIndex: 'seq', width: 50 },
        { title: 'Test', dataIndex: 'name' },
        { title: 'Method', render: (_, t) => t.method ?? '—' },
        { title: 'Limit', render: (_, t) => limitText(t) },
        {
          title: 'Writes to lot',
          render: (_, t) => (
            <>
              {t.isAssay && <Tag color="blue">ASSAY %</Tag>}
              {t.isWater && <Tag color="cyan">WATER %</Tag>}
            </>
          ),
        },
      ]}
    />
  );
}

type EditTest = {
  key: number;
  name: string;
  method: string;
  resultType: QcResultType;
  minValue: string;
  maxValue: string;
  textLimit: string;
  unit: string;
  isAssay: boolean;
  isWater: boolean;
};

const toEdit = (t: SpecTestDto, key: number): EditTest => ({
  key,
  name: t.name,
  method: t.method ?? '',
  resultType: t.resultType,
  minValue: trimLimit(t.minValue) ?? '',
  maxValue: trimLimit(t.maxValue) ?? '',
  textLimit: t.textLimit ?? '',
  unit: t.unit ?? '',
  isAssay: t.isAssay,
  isWater: t.isWater,
});

function TestsEditor({ spec, onClose, onSaved }: { spec: SpecDto; onClose(): void; onSaved(): Promise<void> }) {
  const { message } = App.useApp();
  const [tests, setTests] = useState<EditTest[]>(() => (spec.tests ?? []).map(toEdit));
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const update = (key: number, patch: Partial<EditTest>) => setTests((cur) => cur.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  const opt = (v: string) => (v.trim() === '' ? null : v.trim());

  const save = async () => {
    const body = {
      tests: tests.map((t) => ({
        name: t.name,
        method: opt(t.method),
        resultType: t.resultType,
        minValue: t.resultType === 'NUMERIC' ? opt(t.minValue) : null,
        maxValue: t.resultType === 'NUMERIC' ? opt(t.maxValue) : null,
        textLimit: t.resultType === 'TEXT' ? opt(t.textLimit) : null,
        unit: opt(t.unit),
        isAssay: t.resultType === 'NUMERIC' && t.isAssay,
        isWater: t.resultType === 'NUMERIC' && t.isWater,
      })),
    };
    const parsed = SetSpecTestsRequest.safeParse(body);
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => `${typeof i.path[1] === 'number' ? `Test ${i.path[1] + 1}: ` : ''}${i.message}`));
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      await api(`/qc/specs/${spec.id}/tests`, { method: 'PUT', body: parsed.data });
      void message.success('Tests saved');
      await onSaved();
      onClose();
    } catch (err) {
      setErrors([errorText(err)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={`Tests of ${spec.itemCode} v${spec.version}`} width={1150} okText="Save tests" onOk={() => void save()} confirmLoading={busy} onCancel={onClose} maskClosable={false}>
      <Typography.Paragraph type="secondary">
        A numeric test needs a minimum, a maximum or both (negative limits are allowed). A text test needs its limit, e.g. “Complies”. Mark at most one assay
        and one water test: their results are written onto the lot when QC approves it.
      </Typography.Paragraph>
      {errors.length > 0 && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={errors.map((e, i) => <div key={i}>{e}</div>)} />}
      <Table<EditTest>
        rowKey="key"
        size="small"
        pagination={false}
        dataSource={tests}
        scroll={{ x: true }}
        columns={[
          { title: '#', width: 40, render: (_, __, i) => i + 1 },
          { title: 'Test', width: 200, render: (_, t) => <Input aria-label="Test name" value={t.name} onChange={(e) => update(t.key, { name: e.target.value })} /> },
          { title: 'Method', width: 140, render: (_, t) => <Input aria-label="Method" value={t.method} onChange={(e) => update(t.key, { method: e.target.value })} /> },
          {
            title: 'Type',
            width: 110,
            render: (_, t) => (
              <Select aria-label="Result type" value={t.resultType} onChange={(v: QcResultType) => update(t.key, { resultType: v })} options={QcResultType.map((r) => ({ value: r, label: r === 'NUMERIC' ? 'Numeric' : 'Text' }))} style={{ width: '100%' }} />
            ),
          },
          { title: 'Min', width: 100, render: (_, t) => <Input aria-label="Minimum" inputMode="decimal" disabled={t.resultType !== 'NUMERIC'} value={t.minValue} onChange={(e) => update(t.key, { minValue: e.target.value.trim() })} /> },
          { title: 'Max', width: 100, render: (_, t) => <Input aria-label="Maximum" inputMode="decimal" disabled={t.resultType !== 'NUMERIC'} value={t.maxValue} onChange={(e) => update(t.key, { maxValue: e.target.value.trim() })} /> },
          { title: 'Text limit', width: 160, render: (_, t) => <Input aria-label="Text limit" disabled={t.resultType !== 'TEXT'} value={t.textLimit} onChange={(e) => update(t.key, { textLimit: e.target.value })} /> },
          { title: 'Unit', width: 80, render: (_, t) => <Input aria-label="Unit" value={t.unit} onChange={(e) => update(t.key, { unit: e.target.value })} /> },
          { title: 'Assay', width: 60, render: (_, t) => <Checkbox aria-label="Assay" disabled={t.resultType !== 'NUMERIC'} checked={t.isAssay} onChange={(e) => update(t.key, { isAssay: e.target.checked, isWater: e.target.checked ? false : t.isWater })} /> },
          { title: 'Water', width: 60, render: (_, t) => <Checkbox aria-label="Water" disabled={t.resultType !== 'NUMERIC'} checked={t.isWater} onChange={(e) => update(t.key, { isWater: e.target.checked, isAssay: e.target.checked ? false : t.isAssay })} /> },
          { title: '', width: 40, render: (_, t) => <Button type="text" danger aria-label="Remove test" icon={<DeleteOutlined />} onClick={() => setTests((cur) => cur.filter((x) => x.key !== t.key))} /> },
        ]}
      />
      <Button
        icon={<PlusOutlined />}
        style={{ marginTop: 8 }}
        onClick={() => setTests((cur) => [...cur, { key: Math.max(0, ...cur.map((t) => t.key)) + 1, name: '', method: '', resultType: 'NUMERIC', minValue: '', maxValue: '', textLimit: '', unit: '', isAssay: false, isWater: false }])}>
        Add test
      </Button>
    </Modal>
  );
}

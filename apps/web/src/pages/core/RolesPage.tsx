// Roles and permission bundles (core.role.manage; read also with core.user.manage).
// Shows the same rules the API enforces: admin keys never with action keys; changes to QA-controlled keys need
// a QA Manager countersign (docs/roles.md, decision Q1).
import { useMemo, useState } from 'react';
import { Alert, App, Button, Checkbox, Collapse, Form, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Permissions, isQaControlledKey, type PermissionDto, type PermissionKey, type RoleDto } from '@albert/shared';
import { api, errorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ESignModal, type ESignResult } from '../../components/ESignModal';
import { PageHeader } from '../../components/PageHeader';
import { StatusTag } from '../../components/StatusTag';

const CLASS_COLOUR = { ADMIN: 'purple', VIEW: 'default', ACTION: 'blue' } as const;
const MODULE_NAMES: Record<string, string> = {
  core: 'Core', master: 'Masters', inv: 'Inventory', sales: 'Sales', purch: 'Procurement', qc: 'QC',
  prod: 'Production', qa: 'QA', fg: 'Dispatch', fin: 'Finance', dash: 'Dashboard',
};

function needsCountersign(keys: Iterable<PermissionKey>): boolean {
  for (const k of keys) if (isQaControlledKey(k)) return true;
  return false;
}

function mixesAdminAndAction(keys: PermissionKey[]): boolean {
  const classes = new Set(keys.map((k) => Permissions[k].class));
  return classes.has('ADMIN') && classes.has('ACTION');
}

type Pending =
  | { kind: 'create'; code: string; name: string; description?: string; keys: PermissionKey[] }
  | { kind: 'keys'; role: RoleDto; keys: PermissionKey[] }
  | { kind: 'active'; role: RoleDto; active: boolean };

export function RolesPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const manage = can('core.role.manage');
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<RoleDto[]>('/core/roles') });
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api<PermissionDto[]>('/core/permissions') });
  const [editing, setEditing] = useState<{ role: RoleDto | null } | null>(null);
  const [renaming, setRenaming] = useState<RoleDto | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const pendingNeedsCountersign =
    pending?.kind === 'create'
      ? needsCountersign(pending.keys)
      : pending?.kind === 'keys'
        ? pending.role.needsCountersign || needsCountersign(pending.keys)
        : pending?.kind === 'active'
          ? pending.role.needsCountersign
          : false;

  const submitPending = async (r: ESignResult) => {
    if (!pending) return;
    const cs = r.countersign ? { countersign: r.countersign } : {};
    if (pending.kind === 'create') {
      await api('/core/roles', {
        method: 'POST',
        body: { code: pending.code, name: pending.name, description: pending.description, keys: pending.keys, reason: r.reason, ...cs },
      });
    } else if (pending.kind === 'keys') {
      await api(`/core/roles/${pending.role.id}/permissions`, { method: 'PUT', body: { keys: pending.keys, reason: r.reason, ...cs } });
    } else {
      await api(`/core/roles/${pending.role.id}/${pending.active ? 'activate' : 'deactivate'}`, { method: 'POST', body: { reason: r.reason, ...cs } });
    }
    void message.success('Saved');
    setPending(null);
    await qc.invalidateQueries({ queryKey: ['roles'] });
  };

  return (
    <>
      <PageHeader title="Roles" extra={manage && <Button type="primary" onClick={() => setEditing({ role: null })}>New role</Button>}>
        A role is a bundle of permission keys. A role with admin keys can never hold action keys.
      </PageHeader>
      <Table<RoleDto>
        rowKey="id"
        loading={roles.isLoading}
        dataSource={roles.data ?? []}
        pagination={false}
        scroll={{ x: true }}
        columns={[
          { title: 'Code', dataIndex: 'code' },
          { title: 'Name', dataIndex: 'name' },
          { title: 'Keys', render: (_, r) => r.keys.length },
          { title: 'Users', dataIndex: 'userCount' },
          { title: 'Status', render: (_, r) => <StatusTag status={r.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
          { title: 'Changes need', render: (_, r) => (r.needsCountersign ? <Tag color="gold">QA countersign</Tag> : null) },
          {
            title: '',
            render: (_, r) =>
              manage && (
                <Space size={0} wrap>
                  <Button type="link" onClick={() => setEditing({ role: r })}>Permissions</Button>
                  <Button type="link" onClick={() => setRenaming(r)}>Rename</Button>
                  <Button type="link" danger={r.isActive} onClick={() => setPending({ kind: 'active', role: r, active: !r.isActive })}>
                    {r.isActive ? 'Deactivate' : 'Activate'}
                  </Button>
                </Space>
              ),
          },
        ]}
        expandable={{ expandedRowRender: (r) => <Space wrap>{r.keys.map((k) => <Tag key={k} color={CLASS_COLOUR[Permissions[k].class]}>{k}</Tag>)}</Space> }}
      />

      {editing && (
        <RoleEditor
          role={editing.role}
          catalogue={perms.data ?? []}
          onClose={() => setEditing(null)}
          onNext={(p) => {
            setEditing(null);
            setPending(p);
          }}
        />
      )}
      {renaming && <RenameModal role={renaming} onClose={() => setRenaming(null)} onSaved={() => qc.invalidateQueries({ queryKey: ['roles'] })} />}
      <ESignModal
        open={pending !== null}
        title={pending?.kind === 'active' ? `${pending.active ? 'Activate' : 'Deactivate'} role ${pending.role.name}` : 'Save role'}
        meaning="APPROVED"
        ownSignature={false}
        countersign={pendingNeedsCountersign ? 'required' : 'none'}
        summary="The reason is stored in the audit trail."
        okText="Save"
        onCancel={() => setPending(null)}
        onSubmit={submitPending}
      />
    </>
  );
}

function RoleEditor({ role, catalogue, onClose, onNext }: { role: RoleDto | null; catalogue: PermissionDto[]; onClose(): void; onNext(p: Pending): void }) {
  const [keys, setKeys] = useState<PermissionKey[]>(role?.keys ?? ['core.approval.inbox']);
  const [form] = Form.useForm<{ code: string; name: string; description?: string }>();
  const byModule = useMemo(() => {
    const groups = new Map<string, PermissionDto[]>();
    for (const p of catalogue) {
      const mod = p.key.split('.')[0] ?? '';
      groups.set(mod, [...(groups.get(mod) ?? []), p]);
    }
    return [...groups.entries()];
  }, [catalogue]);
  const conflict = mixesAdminAndAction(keys);
  const toggle = (k: PermissionKey, on: boolean) => setKeys((cur) => (on ? [...new Set([...cur, k])] : cur.filter((x) => x !== k)));

  const next = async () => {
    if (role) {
      onNext({ kind: 'keys', role, keys });
      return;
    }
    const v = await form.validateFields();
    onNext({ kind: 'create', code: v.code, name: v.name, description: v.description, keys });
  };

  return (
    <Modal open width={760} title={role ? `Permissions of ${role.name}` : 'New role'} onCancel={onClose} okText="Next" onOk={() => void next()} okButtonProps={{ disabled: conflict }}>
      {!role && (
        <Form form={form} layout="vertical">
          <Space wrap align="start">
            <Form.Item name="code" label="Code" rules={[{ required: true, pattern: /^[A-Z][A-Z0-9_]{1,39}$/, message: 'Upper case, digits, _' }]}><Input /></Form.Item>
            <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
          </Space>
          <Form.Item name="description" label="Description"><Input /></Form.Item>
        </Form>
      )}
      {conflict && <Alert type="error" showIcon style={{ marginBottom: 12 }} message="A role with an admin key (purple) cannot also hold action keys (blue)." />}
      {(role?.needsCountersign || needsCountersign(keys)) && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="This role holds QA-controlled keys: saving needs a QA Manager countersign." />
      )}
      <Collapse
        size="small"
        items={byModule.map(([mod, list]) => ({
          key: mod,
          label: `${MODULE_NAMES[mod] ?? mod} (${list.filter((p) => keys.includes(p.key)).length}/${list.length})`,
          children: (
            <Space direction="vertical">
              {list.map((p) => (
                <Checkbox key={p.key} checked={keys.includes(p.key)} onChange={(e) => toggle(p.key, e.target.checked)}>
                  <Tag color={CLASS_COLOUR[p.class]}>{p.class}</Tag>
                  <Typography.Text code>{p.key}</Typography.Text> {p.description}
                </Checkbox>
              ))}
            </Space>
          ),
        }))}
      />
    </Modal>
  );
}

function RenameModal({ role, onClose, onSaved }: { role: RoleDto; onClose(): void; onSaved(): unknown }) {
  const [form] = Form.useForm<{ name: string; description: string }>();
  const { message } = App.useApp();
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const v = await form.validateFields();
    try {
      await api(`/core/roles/${role.id}`, { method: 'PATCH', body: { name: v.name, description: v.description || null } });
      void message.success('Saved');
      await onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal open title={`Rename ${role.code}`} onCancel={onClose} onOk={() => void save()}>
      {error && <Typography.Paragraph type="danger">{error}</Typography.Paragraph>}
      <Form form={form} layout="vertical" initialValues={{ name: role.name, description: role.description ?? '' }}>
        <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="description" label="Description"><Input /></Form.Item>
      </Form>
    </Modal>
  );
}

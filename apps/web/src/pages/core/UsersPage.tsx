// User administration (core.user.manage). Rules enforced by the API (decisions Q1, Q5–Q7):
// no self role change / deactivation / reset; QA countersign when roles with QC/QA action keys change.
import { useState } from 'react';
import { App, Button, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateUserRequest, Page, RoleDto, UserDto } from '@albert/shared';
import { api, errorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ESignModal, type ESignResult } from '../../components/ESignModal';
import { PageHeader } from '../../components/PageHeader';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime } from '../../lib/format';

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; user: UserDto }
  | { kind: 'reset'; user: UserDto }
  | { kind: 'roles'; user: UserDto }
  | null;

export function UsersPage() {
  const { user: me } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pendingRoles, setPendingRoles] = useState<{ user: UserDto; roleIds: string[]; countersign: boolean } | null>(null);

  const users = useQuery({
    queryKey: ['users', search, page],
    queryFn: () => api<Page<UserDto>>(`/core/users?page=${page}&pageSize=25${search ? `&search=${encodeURIComponent(search)}` : ''}`),
  });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<RoleDto[]>('/core/roles') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });

  const act = useMutation({
    mutationFn: ({ u, action }: { u: UserDto; action: 'activate' | 'deactivate' | 'unlock' }) =>
      api(`/core/users/${u.id}/${action}`, { method: 'POST' }),
    onSuccess: (_d, v) => {
      void message.success(`${v.u.username}: ${v.action} done`);
      void refresh();
    },
    onError: (err) => void message.error(errorText(err)),
  });

  const confirmAction = (u: UserDto, action: 'activate' | 'deactivate' | 'unlock') => {
    const text = {
      activate: `Activate ${u.username}? They can sign in again.`,
      deactivate: `Deactivate ${u.username}? Their sessions end at once and they can no longer sign in.`,
      unlock: `Unlock ${u.username}? The failed-attempt count is reset. This is logged.`,
    }[action];
    modal.confirm({ title: 'Please confirm', content: text, onOk: () => act.mutateAsync({ u, action }) });
  };

  /** Roles chosen in the dialog → does the change touch QC/QA action keys? → reason (+ countersign). */
  const chooseRoles = (u: UserDto, roleIds: string[]) => {
    const current = u.roles.map((r) => r.id);
    const changed = [...roleIds.filter((id) => !current.includes(id)), ...current.filter((id) => !roleIds.includes(id))];
    const countersign = changed.some((id) => roles.data?.find((r) => r.id === id)?.needsCountersign);
    setDialog(null);
    setPendingRoles({ user: u, roleIds, countersign });
  };

  const saveRoles = async (r: ESignResult) => {
    if (!pendingRoles) return;
    await api(`/core/users/${pendingRoles.user.id}/roles`, {
      method: 'PUT',
      body: { roleIds: pendingRoles.roleIds, reason: r.reason, ...(r.countersign ? { countersign: r.countersign } : {}) },
    });
    void message.success('Roles updated');
    setPendingRoles(null);
    await refresh();
  };

  return (
    <>
      <PageHeader title="Users" extra={<Button type="primary" onClick={() => setDialog({ kind: 'create' })}>New user</Button>}>
        Employees who can sign in. New users must change their temporary password at first login.
      </PageHeader>
      <Input.Search
        placeholder="Search employee code, name or email"
        allowClear
        onSearch={(v) => {
          setSearch(v);
          setPage(1);
        }}
        style={{ maxWidth: 360, marginBottom: 12 }}
      />
      <Table<UserDto>
        rowKey="id"
        loading={users.isLoading}
        dataSource={users.data?.items ?? []}
        pagination={{ current: page, pageSize: 25, total: users.data?.total ?? 0, onChange: setPage }}
        scroll={{ x: true }}
        columns={[
          { title: 'Employee code', dataIndex: 'username' },
          { title: 'Name', dataIndex: 'fullName' },
          { title: 'Roles', render: (_, u) => u.roles.map((r) => <Tag key={r.id}>{r.name}</Tag>) },
          {
            title: 'Status',
            render: (_, u) => (
              <Space size={4} wrap>
                <StatusTag status={u.isActive ? 'ACTIVE' : 'INACTIVE'} />
                {u.isLocked && <StatusTag status="LOCKED" />}
                {u.mustChangePassword && <Tag>must change password</Tag>}
                {u.passwordExpired && !u.mustChangePassword && <Tag color="orange">password expired</Tag>}
              </Space>
            ),
          },
          { title: 'Last sign-in', render: (_, u) => formatDateTime(u.lastLoginAt) },
          {
            title: '',
            render: (_, u) => {
              const self = u.id === me?.id;
              return (
                <Space size={0} wrap>
                  <Button type="link" onClick={() => setDialog({ kind: 'edit', user: u })}>Edit</Button>
                  <Button type="link" disabled={self} title={self ? 'You cannot change your own roles' : undefined} onClick={() => setDialog({ kind: 'roles', user: u })}>
                    Roles
                  </Button>
                  {u.isLocked && <Button type="link" onClick={() => confirmAction(u, 'unlock')}>Unlock</Button>}
                  <Button type="link" disabled={self} onClick={() => setDialog({ kind: 'reset', user: u })}>Reset password</Button>
                  <Button type="link" danger={u.isActive} disabled={self} onClick={() => confirmAction(u, u.isActive ? 'deactivate' : 'activate')}>
                    {u.isActive ? 'Deactivate' : 'Activate'}
                  </Button>
                </Space>
              );
            },
          },
        ]}
      />

      <CreateUserModal open={dialog?.kind === 'create'} onClose={() => setDialog(null)} onSaved={refresh} />
      {dialog?.kind === 'edit' && <EditUserModal user={dialog.user} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog?.kind === 'reset' && <ResetPasswordModal user={dialog.user} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'roles' && (
        <RolesModal user={dialog.user} roles={roles.data ?? []} onClose={() => setDialog(null)} onNext={(ids) => chooseRoles(dialog.user, ids)} />
      )}
      <ESignModal
        open={pendingRoles !== null}
        title={`Change roles of ${pendingRoles?.user.username ?? ''}`}
        meaning="APPROVED"
        ownSignature={false}
        countersign={pendingRoles?.countersign ? 'required' : 'none'}
        summary="The reason is stored in the audit trail."
        okText="Save roles"
        onCancel={() => setPendingRoles(null)}
        onSubmit={saveRoles}
      />
    </>
  );
}

function useSave(onClose: () => void, onSaved?: () => unknown) {
  const { message } = App.useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      void message.success(done);
      await onSaved?.();
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? <Typography.Paragraph type="danger">{error}</Typography.Paragraph> : null;
}

function CreateUserModal({ open, onClose, onSaved }: { open: boolean; onClose(): void; onSaved(): unknown }) {
  const [form] = Form.useForm<CreateUserRequest>();
  const { error, busy, run } = useSave(onClose, onSaved);
  return (
    <Modal open={open} title="New user" onCancel={onClose} confirmLoading={busy} destroyOnClose
      onOk={() => void form.validateFields().then((v) => run(() => api('/core/users', { method: 'POST', body: { ...v, email: v.email || undefined } }), 'User created'))}>
      <ErrorLine error={error} />
      <Form form={form} layout="vertical" preserve={false} autoComplete="off">
        <Form.Item name="username" label="Employee code" rules={[{ required: true, pattern: /^[A-Za-z0-9._-]{2,40}$/, message: '2–40 letters, digits, . _ -' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="fullName" label="Full name" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="email" label="Email (optional)" rules={[{ type: 'email' }]}><Input /></Form.Item>
        <Form.Item name="temporaryPassword" label="Temporary password" extra="Give it to the user; they must change it at first login." rules={[{ required: true }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function EditUserModal({ user, onClose, onSaved }: { user: UserDto; onClose(): void; onSaved(): unknown }) {
  const [form] = Form.useForm<{ fullName: string; email: string }>();
  const { error, busy, run } = useSave(onClose, onSaved);
  return (
    <Modal open title={`Edit ${user.username}`} onCancel={onClose} confirmLoading={busy}
      onOk={() => void form.validateFields().then((v) => run(() => api(`/core/users/${user.id}`, { method: 'PATCH', body: { fullName: v.fullName, email: v.email || null } }), 'Saved'))}>
      <ErrorLine error={error} />
      <Form form={form} layout="vertical" initialValues={{ fullName: user.fullName, email: user.email ?? '' }}>
        <Form.Item name="fullName" label="Full name" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="email" label="Email (optional)" rules={[{ type: 'email' }]}><Input /></Form.Item>
      </Form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: UserDto; onClose(): void }) {
  const [form] = Form.useForm<{ temporaryPassword: string }>();
  const { error, busy, run } = useSave(onClose);
  return (
    <Modal open title={`Reset password of ${user.username}`} onCancel={onClose} confirmLoading={busy} okText="Reset"
      onOk={() => void form.validateFields().then((v) => run(() => api(`/core/users/${user.id}/reset-password`, { method: 'POST', body: v }), 'Password reset; the user must change it at next sign-in'))}>
      <Typography.Paragraph type="secondary">The user's sessions end now. The reset is logged with your name.</Typography.Paragraph>
      <ErrorLine error={error} />
      <Form form={form} layout="vertical" autoComplete="off">
        <Form.Item name="temporaryPassword" label="Temporary password" rules={[{ required: true }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function RolesModal({ user, roles, onClose, onNext }: { user: UserDto; roles: RoleDto[]; onClose(): void; onNext(ids: string[]): void }) {
  const [selected, setSelected] = useState(user.roles.map((r) => r.id));
  return (
    <Modal open title={`Roles of ${user.username}`} onCancel={onClose} okText="Next" onOk={() => onNext(selected)}>
      <Select
        mode="multiple"
        style={{ width: '100%' }}
        value={selected}
        onChange={setSelected}
        optionFilterProp="label"
        options={roles.filter((r) => r.isActive).map((r) => ({ value: r.id, label: r.needsCountersign ? `${r.name} (QA countersign)` : r.name }))}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
        Adding or removing a role marked "QA countersign" needs a QA Manager to countersign on the next screen.
      </Typography.Paragraph>
    </Modal>
  );
}

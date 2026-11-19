// A master screen built from DataTable + DocForm: list with search/filters/paging/Excel, "New", "Edit" and
// activate/deactivate (POST /:id/activate | /deactivate — never PATCH, CLAUDE.md). The API checks every key and
// rule again; buttons are only hidden for users who lack the key.
import { useState, type ReactNode } from 'react';
import { App, Button, Space } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import type { PermissionKey, WitnessSignRequest } from '@albert/shared';
import type { z } from 'zod';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable, type DataColumn, type FilterDef } from '../../components/DataTable';
import { DocForm, type FieldDef } from '../../components/DocForm';
import { PageHeader } from '../../components/PageHeader';
import { ReasonModal } from '../../components/ReasonModal';

export interface MasterPageConfig<T extends { id: string }, C extends z.ZodTypeAny, E extends z.ZodTypeAny> {
  title: string;
  intro?: ReactNode;
  /** API path, e.g. "/master/uoms". */
  path: string;
  /** Singular noun for buttons and messages, e.g. "unit of measure". */
  noun: string;
  manageKey: PermissionKey;
  /** Who may activate/deactivate when it differs from manageKey (customers, vendors, GMP items). */
  activateKeys?: PermissionKey[];
  columns: DataColumn<T>[];
  filters?: FilterDef[];
  params?: Record<string, string | undefined>;
  searchPlaceholder?: string;
  exportPageSize?: number;
  create?: { schema: C; fields: FieldDef[]; initial?: Record<string, unknown>; intro?: ReactNode };
  edit?: { schema: E; fields: (row: T) => FieldDef[]; initial: (row: T) => Record<string, unknown>; readOnly?: (row: T) => { label: string; value: ReactNode }[] };
  /** Who countersigns when the API answers COUNTERSIGN_REQUIRED (sensitive fields). */
  countersignBy?: string;
  /** Is the record active (is_active flag or status ACTIVE)? Omit when the master has no activate/deactivate. */
  isActive?: (row: T) => boolean;
  /** Records that may be activated (e.g. a DRAFT customer); default: every inactive one. */
  canActivate?: (row: T) => boolean;
  extraActions?: (row: T, refresh: () => Promise<void>) => ReactNode;
  onRowClick?: (row: T) => void;
  toolbar?: ReactNode;
}

export function MasterPage<T extends { id: string }, C extends z.ZodTypeAny, E extends z.ZodTypeAny>({ config }: { config: MasterPageConfig<T, C, E> }) {
  const c = config;
  const { can, canAny } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const queryKey = ['master-page', c.path];
  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey }), qc.invalidateQueries({ queryKey: ['ref'] })]);
  };
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);
  const [toggling, setToggling] = useState<{ row: T; activate: boolean } | null>(null);
  const mayManage = can(c.manageKey);
  const mayActivate = canAny(...(c.activateKeys ?? [c.manageKey]));

  const send = async (path: string, method: 'POST' | 'PATCH', values: object, countersign?: WitnessSignRequest) => {
    await api(path, { method, body: countersign ? { ...values, countersign } : values });
  };

  return (
    <>
      <PageHeader
        title={c.title}
        extra={c.create && mayManage ? <Button type="primary" onClick={() => setCreating(true)}>New {c.noun}</Button> : undefined}
      >
        {c.intro}
      </PageHeader>
      <DataTable<T>
        title={c.title}
        path={c.path}
        queryKey={queryKey}
        columns={c.columns}
        filters={c.filters}
        params={c.params}
        searchPlaceholder={c.searchPlaceholder}
        exportPageSize={c.exportPageSize}
        onRowClick={c.onRowClick}
        toolbar={c.toolbar}
        actions={(row) => (
          <Space size={0} wrap>
            {c.edit && mayManage && <Button type="link" onClick={() => setEditing(row)}>Edit</Button>}
            {c.isActive && mayActivate && (c.isActive(row) || (c.canActivate ?? (() => true))(row)) && (
              <Button type="link" danger={c.isActive(row)} onClick={() => setToggling({ row, activate: !c.isActive!(row) })}>
                {c.isActive(row) ? 'Deactivate' : 'Activate'}
              </Button>
            )}
            {c.extraActions?.(row, async () => { await refresh(); })}
          </Space>
        )}
      />

      {c.create && (
        <DocForm
          open={creating}
          title={`New ${c.noun}`}
          mode="create"
          schema={c.create.schema}
          fields={c.create.fields}
          initialValues={c.create.initial}
          intro={c.create.intro}
          countersignBy={c.countersignBy}
          onCancel={() => setCreating(false)}
          onSubmit={async (values, countersign) => {
            await send(c.path, 'POST', values as object, countersign);
            void message.success(`${c.noun[0]!.toUpperCase()}${c.noun.slice(1)} created`);
            setCreating(false);
            await refresh();
          }}
        />
      )}
      {c.edit && editing && (
        <DocForm
          open
          title={`Edit ${c.noun}`}
          mode="edit"
          schema={c.edit.schema}
          fields={c.edit.fields(editing)}
          initialValues={c.edit.initial(editing)}
          readOnly={c.edit.readOnly?.(editing)}
          countersignBy={c.countersignBy}
          onCancel={() => setEditing(null)}
          onSubmit={async (values, countersign) => {
            await send(`${c.path}/${editing.id}`, 'PATCH', values as object, countersign);
            void message.success('Saved');
            setEditing(null);
            await refresh();
          }}
        />
      )}
      <ReasonModal
        open={toggling !== null}
        title={toggling?.activate ? `Activate ${c.noun}` : `Deactivate ${c.noun}`}
        text={toggling?.activate ? 'The change is logged with your name.' : 'An inactive record cannot be used on new documents. A reason is required.'}
        reasonRequired={!toggling?.activate}
        danger={!toggling?.activate}
        okText={toggling?.activate ? 'Activate' : 'Deactivate'}
        onCancel={() => setToggling(null)}
        onSubmit={async (reason) => {
          if (!toggling) return;
          await api(`${c.path}/${toggling.row.id}/${toggling.activate ? 'activate' : 'deactivate'}`, { method: 'POST', body: reason ? { reason } : {} });
          void message.success(toggling.activate ? 'Activated' : 'Deactivated');
          setToggling(null);
          await refresh();
        }}
      />
    </>
  );
}

/** Column helpers. */
export const yesNo = (v: boolean) => (v ? 'Yes' : 'No');
export const enumOptions = (values: readonly string[]) => values.map((v) => ({ value: v, label: v.replace(/_/g, ' ') }));

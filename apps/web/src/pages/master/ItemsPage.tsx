// Items (M2 task 3b): created DRAFT; GMP types (RM, PM, API, EXCIPIENT, BULK, FG) are activated by QA
// (master.item.approve), others by another item keeper. Shelf life, retest, storage and controlled status of an
// active GMP item change only with a QA countersign (the API asks; the form collects it).
import {
  CreateItemRequest,
  GmpItemTypes,
  ItemStatus,
  ItemType,
  StorageZone,
  UpdateItemRequest,
  type ItemDto,
} from '@albert/shared';
import { Tag } from 'antd';
import { statusFilter } from '../../components/DataTable';
import { RefLabel } from '../../components/RefSelect';
import { StatusTag } from '../../components/StatusTag';
import type { FieldDef } from '../../components/DocForm';
import { MasterPage, enumOptions, yesNo } from './MasterPage';

const commonFields: FieldDef[] = [
  { name: 'name', label: 'Name', kind: 'text' },
  { name: 'categoryId', label: 'Category', kind: 'ref', path: '/master/item-categories', params: { active: 'active' } },
  { name: 'taxCodeId', label: 'Tax code', kind: 'ref', path: '/master/tax-codes', params: { active: 'active' }, nullable: true },
  { name: 'shelfLifeDays', label: 'Shelf life (days)', kind: 'int', nullable: true },
  { name: 'retestDays', label: 'Retest period (days)', kind: 'int', nullable: true },
  { name: 'storageZone', label: 'Storage condition', kind: 'select', options: enumOptions(StorageZone) },
  { name: 'isControlled', label: 'Controlled substance', kind: 'switch' },
];

export function ItemsPage() {
  return (
    <MasterPage<ItemDto, typeof CreateItemRequest, typeof UpdateItemRequest>
      config={{
        title: 'Items',
        intro: 'New items start as DRAFT. QA activates GMP items (RM, PM, API, excipient, bulk, FG); another item keeper activates spares and consumables.',
        path: '/master/items',
        noun: 'item',
        manageKey: 'master.item.manage',
        activateKeys: ['master.item.approve', 'master.item.manage'],
        countersignBy: 'QA Manager',
        filters: [statusFilter(ItemStatus), { name: 'type', label: 'Type', options: enumOptions(ItemType) }],
        columns: [
          { key: 'code', title: 'Code' },
          { key: 'name', title: 'Name' },
          { key: 'type', title: 'Type', render: (r) => <>{r.type} {GmpItemTypes.includes(r.type) && <Tag>GMP</Tag>}</> },
          { key: 'categoryId', title: 'Category', render: (r) => <RefLabel path="/master/item-categories" id={r.categoryId} /> },
          { key: 'baseUomId', title: 'Base UoM', render: (r) => <RefLabel path="/master/uoms" id={r.baseUomId} /> },
          { key: 'shelfLifeDays', title: 'Shelf life (d)' },
          { key: 'retestDays', title: 'Retest (d)' },
          { key: 'storageZone', title: 'Storage', render: (r) => r.storageZone.replace(/_/g, ' ') },
          { key: 'isControlled', title: 'Controlled', render: (r) => (r.isControlled ? <Tag color="red">CONTROLLED</Tag> : ''), exportValue: (r) => yesNo(r.isControlled) },
          { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
        ],
        isActive: (r) => r.status === 'ACTIVE',
        create: {
          schema: CreateItemRequest,
          initial: { storageZone: 'AMBIENT', isControlled: false },
          intro: 'Code, type and base unit cannot be changed later.',
          fields: [
            { name: 'code', label: 'Code', kind: 'text' },
            { name: 'type', label: 'Type', kind: 'select', options: enumOptions(ItemType) },
            { name: 'baseUomId', label: 'Base unit', kind: 'ref', path: '/master/uoms', params: { active: 'active' } },
            ...commonFields,
          ],
        },
        edit: {
          schema: UpdateItemRequest,
          readOnly: (r) => [
            { label: 'Code', value: r.code },
            { label: 'Type', value: r.type },
            { label: 'Base unit', value: <RefLabel path="/master/uoms" id={r.baseUomId} /> },
            { label: 'Status', value: <StatusTag status={r.status} /> },
          ],
          initial: (r) => ({
            name: r.name,
            categoryId: r.categoryId,
            taxCodeId: r.taxCodeId ?? '',
            shelfLifeDays: r.shelfLifeDays,
            retestDays: r.retestDays,
            storageZone: r.storageZone,
            isControlled: r.isControlled,
          }),
          fields: () => commonFields,
        },
      }}
    />
  );
}

import { afterEach, expect, it } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import StorageTable from '../components/StorageTable.svelte';
import { buildNoteInventory } from '../domain/storageSync';
import type { StorageSnapshot } from '../domain/storageSync';
import type { StorageComparison, StorageColumn } from '../services/storageManagement';
import {
  available,
  note,
  OLD_SOURCE,
  NEW_SOURCE,
  OTHER_SOURCE,
  NEWER
} from './helpers/storageSyncFixtures';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
});

function render(snapshots: StorageSnapshot[], columns?: StorageColumn[]) {
  target = document.createElement('div');
  document.body.append(target);
  const model: StorageComparison = {
    catalogError: null,
    columns:
      columns ??
      snapshots.map((snapshot, index) => ({
        id: snapshot.storageId,
        label: `Хранилище ${index + 1}`,
        kind: index === 2 ? 'local' : 'cloud',
        contextId: null,
        active: index === 0
      })),
    snapshots,
    rows: buildNoteInventory(snapshots),

    storages: new Map()
  };
  component = mount(StorageTable, { target, props: { model } });
  flushSync();
  return target;
}

function cell(id: string, path = 'note.md') {
  return target.querySelector(`tr[data-note-path="${path}"] td[data-storage-id="${id}"]`);
}

it('puts the active cloud and its exact cache first, pairs other clouds and preserves each cell and version', () => {
  const columns: StorageColumn[] = [
    { id: 'reserve', label: 'Reserve', kind: 'cloud', contextId: 'reserve-context', active: false },
    { id: 'old', label: 'Old cache', kind: 'local', contextId: 'old-context', active: false },
    { id: 'active', label: 'Active', kind: 'cloud', contextId: 'active-context', active: true },
    {
      id: 'local-reserve',
      label: 'Reserve cache',
      kind: 'local',
      contextId: 'reserve-context',
      active: false
    },
    { id: 'unassigned', label: 'Unassigned', kind: 'local', contextId: null, active: false },
    {
      id: 'local-active',
      label: 'Active cache',
      kind: 'local',
      contextId: 'active-context',
      active: true
    }
  ];
  render(
    columns.map(column =>
      available(column.id, [note('note.md', column.active ? NEW_SOURCE : OLD_SOURCE)])
    ),
    columns
  );
  const order = ['active', 'local-active', 'reserve', 'local-reserve', 'old', 'unassigned'];
  expect(
    [...target.querySelectorAll('thead th[scope="col"]')]
      .slice(1)
      .map(header =>
        header.textContent?.replace('Папка неизвестна', '').replace('Активное', '').trim()
      )
  ).toEqual(['Active', 'Active cache', 'Reserve', 'Reserve cache', 'Old cache', 'Unassigned']);
  expect(
    [...target.querySelectorAll('tbody td')].map(cell => cell.getAttribute('data-storage-id'))
  ).toEqual(order);
  expect(cell('active')?.textContent).toContain('Актуальная · версия 2');
  expect(cell('reserve')?.querySelector('pre')?.textContent).toBe(OLD_SOURCE);
  expect(cell('local-active')?.querySelector('pre')?.textContent).toBe(NEW_SOURCE);
});

it('does not associate a cache by its label or an unknown context', () => {
  const columns: StorageColumn[] = [
    { id: 'unassigned', label: 'Unassigned', kind: 'local', contextId: null, active: false },
    { id: 'active', label: 'Cloud', kind: 'cloud', contextId: null, active: true },
    { id: 'wrong-cache', label: 'Cloud', kind: 'local', contextId: 'old-context', active: false },
    { id: 'reserve', label: 'Reserve', kind: 'cloud', contextId: 'reserve-context', active: false }
  ];
  render(
    columns.map(column => available(column.id, [note('note.md', OLD_SOURCE)])),
    columns
  );
  expect(
    [...target.querySelectorAll('tbody td')].map(cell => cell.getAttribute('data-storage-id'))
  ).toEqual(['active', 'reserve', 'wrong-cache', 'unassigned']);
});

it('groups historical caches with their cloud connection and leaves only unassigned caches last', () => {
  const columns: StorageColumn[] = [
    { id: 'unassigned', label: 'Unassigned', kind: 'local', contextId: null, active: false },
    { id: 'disk', label: 'Disk', kind: 'cloud', contextId: 'disk-current', active: false },
    {
      id: 'historical-dropbox',
      label: 'Dropbox · 24bee099',
      kind: 'local',
      contextId: 'dropbox-old',
      storageId: 'dropbox',
      active: false
    },
    {
      id: 'orphan',
      label: 'Removed connection',
      kind: 'local',
      contextId: 'removed-context',
      storageId: 'removed',
      active: false
    },
    { id: 'dropbox', label: 'Dropbox', kind: 'cloud', contextId: 'dropbox-current', active: true },
    {
      id: 'local-disk',
      label: 'Disk cache',
      kind: 'local',
      contextId: 'disk-current',
      storageId: 'disk',
      active: false
    },
    {
      id: 'local-dropbox',
      label: 'Dropbox cache',
      kind: 'local',
      contextId: 'dropbox-current',
      storageId: 'dropbox',
      active: true
    }
  ];
  render(
    columns.map(column => available(column.id, [note('note.md', OLD_SOURCE)])),
    columns
  );
  const expected = [
    'dropbox',
    'local-dropbox',
    'historical-dropbox',
    'disk',
    'local-disk',
    'orphan',
    'unassigned'
  ];
  expect(
    [...target.querySelectorAll('thead th[data-storage-id]')].map(header =>
      header.getAttribute('data-storage-id')
    )
  ).toEqual(expected);
  expect(
    [...target.querySelectorAll('tbody td')].map(cell => cell.getAttribute('data-storage-id'))
  ).toEqual(expected);
});

it('renders a union of notes with dynamic cloud/local columns and active label', () => {
  render([
    available('one', [note('note.md', OLD_SOURCE)]),
    available('two', [note('other.md', NEW_SOURCE)]),
    available('local')
  ]);
  expect(target.querySelectorAll('thead th')).toHaveLength(4);
  expect(target.querySelectorAll('tbody tr')).toHaveLength(2);
  expect(target.textContent).toContain('Хранилище 3');
  expect(target.textContent).toContain('Активное');
});

it('highlights every exact copy of the newest supported document', () => {
  render([
    available('one', [note('note.md', OLD_SOURCE, null, 9999999999999)]),
    available('two', [note('note.md', NEW_SOURCE)]),
    available('local', [note('note.md', NEW_SOURCE)])
  ]);
  expect(cell('one')?.getAttribute('data-latest')).not.toBe('true');
  expect(cell('two')?.getAttribute('data-latest')).toBe('true');
  expect(cell('local')?.getAttribute('data-latest')).toBe('true');
  expect(cell('two')?.querySelector('strong')?.textContent).toContain('Актуальная');
});

it('shows tied conflicting versions without highlighting a winner', () => {
  render([
    available('one', [note('note.md', OLD_SOURCE)]),
    available('two', [note('note.md', OTHER_SOURCE)])
  ]);
  expect(target.querySelectorAll('[data-latest="true"]')).toHaveLength(0);
  expect(target.textContent).toContain('Актуальность неопределённа');
});

it('distinguishes a confirmed missing file from an unavailable copy', () => {
  render([
    available('one', [note('note.md', OLD_SOURCE)]),
    available('missing'),
    { storageId: 'broken', status: 'unavailable' }
  ]);
  expect(cell('missing')?.textContent).toContain('Нет файла');
  expect(cell('broken')?.textContent).toContain('Недоступно');
  expect(target.querySelectorAll('[data-latest="true"]')).toHaveLength(0);
});

it('shows source Modified and the separate cloud listing timestamp including epoch', () => {
  render([available('one', [note('note.md', NEW_SOURCE, 'rev', 0)])]);
  expect(cell('one')?.querySelector('time[data-document-modified]')?.getAttribute('datetime')).toBe(
    new Date(NEWER).toISOString()
  );
  expect(cell('one')?.querySelector('time[data-storage-modified]')?.getAttribute('datetime')).toBe(
    '1970-01-01T00:00:00.000Z'
  );
  expect(cell('one')?.textContent).toContain('Дата в листинге облака');
  expect(cell('one')?.textContent).toContain('rev');
});

it('previews exact unsupported source as escaped text and shows an unknown date', () => {
  const source = '\uFEFF<script>bad()</script>\r\nraw\r\n';
  render([available('one', [note('note.md', source)])]);
  expect(cell('one')?.querySelector('pre')?.textContent).toBe(source);
  expect(cell('one')?.querySelector('script')).toBeNull();
  expect(cell('one')?.textContent).toContain('Дата документа неизвестна');
});

it('does not claim an empty folder when the entire inventory is unavailable', () => {
  render([{ storageId: 'broken', status: 'unavailable' }]);
  expect(target.querySelector('[role="alert"]')?.textContent).toContain('недоступен');
  expect(target.textContent).not.toContain('Заметок нет');
});

it('shows an explicitly confirmed empty inventory', () => {
  render([available('empty')]);
  expect(target.textContent).toContain('Заметок нет');
});

it('does not claim a globally empty inventory when only an empty source is available', () => {
  render([available('empty'), { storageId: 'broken', status: 'unavailable' }]);
  expect(target.querySelector('[role="alert"]')).not.toBeNull();
  expect(target.textContent).not.toContain('Заметок нет');
});

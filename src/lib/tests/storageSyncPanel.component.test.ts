import StorageSyncHarness from './helpers/StorageSyncHarness.svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import StorageSyncPanel from '../components/StorageSyncPanel.svelte';
import { buildNoteInventory, planNoteSync } from '../domain/storageSync';
import { available, note, OLD_SOURCE, NEW_SOURCE } from './helpers/storageSyncFixtures';
import type { StorageComparison } from '../services/storageManagement';

const actions = vi.hoisted(() => ({
  prepareStorageSync: vi.fn(),
  runStorageSync: vi.fn(),
  readManualSyncState: vi.fn(),
  verifyManualSync: vi.fn(),
  dismissManualSync: vi.fn()
}));
vi.mock('../stores/appFacade', () => ({ app: actions }));

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let complete: import('vitest').Mock<() => Promise<void>>;
const snapshots = [
  available('cloud', [note('note.md', NEW_SOURCE), note('only-cloud.md', NEW_SOURCE)]),
  available('local:fixture', [note('note.md', OLD_SOURCE)])
];
const port = (id: string, label: string, kind: 'cloud' | 'local') => ({
  id,
  label,
  kind,
  contextId: null,
  caseSensitive: true,
  list: vi.fn(),
  read: vi.fn(),
  copy: vi.fn()
});

const storages = new Map([
  ['cloud', port('cloud', 'Облако', 'cloud')],
  ['local:fixture', port('local:fixture', 'Локальная копия', 'local')]
]);
const model: StorageComparison = {
  catalogError: null,
  columns: [
    { id: 'cloud', label: 'Облако', kind: 'cloud', contextId: null, active: true },
    { id: 'local:fixture', label: 'Локальная копия', kind: 'local', contextId: null, active: false }
  ],
  snapshots,
  rows: buildNoteInventory(snapshots),

  storages
};
beforeEach(() => {
  actions.prepareStorageSync.mockImplementation((model, selection) =>
    planNoteSync(model.snapshots, selection)
  );
  actions.runStorageSync.mockResolvedValue([
    {
      path: 'note.md',
      sourceStorageId: 'local:fixture',
      targetStorageId: 'cloud',
      outcome: { status: 'written', revision: null }
    },
    {
      path: 'only-cloud.md',
      sourceStorageId: 'local:fixture',
      targetStorageId: 'cloud',
      outcome: { status: 'skipped', reason: 'source-missing' }
    }
  ]);
  actions.readManualSyncState.mockResolvedValue({ pending: [], archives: [], history: [] });
  complete = vi.fn(async () => {});
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  vi.clearAllMocks();
});

async function render(current: StorageComparison = model) {
  component = mount(StorageSyncPanel, { target, props: { model: current, oncomplete: complete } });
  flushSync();
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
}

function button(text: string) {
  const found = [...target.querySelectorAll('button')].find(button =>
    button.textContent?.includes(text)
  );
  expect(found, `button ${text}`).toBeDefined();
  return found!;
}

function select(label: string, value: string) {
  const input = target.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(input).not.toBeNull();
  input!.value = value;
  input!.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}

it('orders references and destinations by active cloud, current cache, historical caches and other cloud groups', async () => {
  const columns: StorageComparison['columns'] = [
    { id: 'legacy', label: 'Legacy', kind: 'local', contextId: null, active: false },
    { id: 'reserve', label: 'Reserve', kind: 'cloud', contextId: 'reserve-current', active: false },
    {
      id: 'old',
      label: 'Old active cache',
      kind: 'local',
      contextId: 'active-old',
      storageId: 'active',
      active: false
    },
    { id: 'active', label: 'Active', kind: 'cloud', contextId: 'active-current', active: true },
    {
      id: 'current',
      label: 'Current cache',
      kind: 'local',
      contextId: 'active-current',
      storageId: 'active',
      active: true
    },
    {
      id: 'empty',
      label: 'Empty reserve cache',
      kind: 'local',
      contextId: 'reserve-current',
      storageId: 'reserve',
      active: false
    }
  ];
  const snapshots = columns.map(column =>
    available(column.id, column.id === 'empty' ? [] : [note('note.md', OLD_SOURCE)])
  );
  const storages = new Map(
    columns.map(column => [column.id, port(column.id, column.label, column.kind)])
  );
  await render({
    ...model,
    columns,
    snapshots,
    rows: buildNoteInventory(snapshots),
    storages
  });
  const references = () =>
    [...target.querySelectorAll<HTMLOptionElement>('select[aria-label="Эталон"] option')]
      .map(option => option.value)
      .filter(Boolean);
  const targets = () =>
    [...target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(
      input => input.value
    );
  expect(references()).toEqual(['active', 'current', 'old', 'reserve', 'legacy']);
  expect(targets()).toEqual(['active', 'current', 'old', 'reserve', 'empty', 'legacy']);
  expect(target.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(6);
  expect(actions.runStorageSync).not.toHaveBeenCalled();
  select('Эталон', 'active');
  expect(targets()).toEqual(['current', 'old', 'reserve', 'empty', 'legacy']);
  select('Заметки', 'note.md');
  expect(references()).toEqual(['active', 'current', 'old', 'reserve', 'legacy']);
});

it('previews all selected copies and missing-source skips before explicit execution', async () => {
  await render();
  select('Эталон', 'local:fixture');
  button('Подготовить').click();
  flushSync();
  const preview = target.querySelectorAll('[data-sync-preview] li');
  expect(preview).toHaveLength(2);
  expect(preview[0].textContent).toMatch(/note\.md: Локальная копия.*→.*Облако.*Копировать/s);
  expect(preview[1].textContent).toMatch(/only-cloud\.md:.*Нет в эталоне/s);
  expect(actions.runStorageSync).not.toHaveBeenCalled();
  button('Выполнить').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
  expect(actions.runStorageSync).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(target.textContent).toContain('Записано');
});

it('supports one note and invalidates the preview when selection changes', async () => {
  await render();
  select('Эталон', 'local:fixture');
  select('Заметки', 'note.md');
  button('Подготовить').click();
  flushSync();
  const preview = target.querySelectorAll('[data-sync-preview] li');
  expect(preview).toHaveLength(1);
  expect(preview[0].textContent).toContain('note.md');
  select('Заметки', 'only-cloud.md');
  expect(
    [...target.querySelectorAll('button')].some(button => button.textContent?.includes('Выполнить'))
  ).toBe(false);
  expect(actions.runStorageSync).not.toHaveBeenCalled();
});

it('shows a per-target unknown result without retrying automatically', async () => {
  actions.runStorageSync.mockResolvedValue([
    {
      path: 'note.md',
      sourceStorageId: 'local:fixture',
      targetStorageId: 'cloud',
      outcome: { status: 'unavailable', reason: 'network', outcome: 'unknown' }
    }
  ]);
  await render();
  select('Эталон', 'local:fixture');
  button('Подготовить').click();
  flushSync();
  button('Выполнить').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
  expect(target.textContent).toContain('Результат неизвестен');
  expect(actions.runStorageSync).toHaveBeenCalledTimes(1);
});

it('offers explicit verification for a persisted unknown outcome without automatic execution', async () => {
  actions.readManualSyncState.mockResolvedValue({
    pending: [
      {
        id: 'manual',
        targetKey: 'cloud:old',
        pathKey: 'note.md',
        path: 'note.md',
        sourceStorageId: 'local:fixture',
        targetStorageId: 'cloud',
        source: OLD_SOURCE,
        startedAt: 1,
        state: 'unknown'
      }
    ],
    archives: [],
    history: []
  });
  actions.verifyManualSync.mockResolvedValue('different');
  await render();
  expect(target.textContent).toContain('note.md');
  button('Проверить запись').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
  expect(actions.verifyManualSync).toHaveBeenCalledTimes(1);
  expect(actions.runStorageSync).not.toHaveBeenCalled();
  expect(target.textContent).toContain('отличается');
});

it('dismisses only after an explicit click and renders escaped archive/history source', async () => {
  const pending = {
    id: 'manual',
    targetKey: 'cloud:old',
    pathKey: 'note.md',
    path: 'note.md',
    sourceStorageId: 'local:fixture',
    targetStorageId: 'cloud',
    source: '\uFEFF<script>keep()</script>\r\n',
    startedAt: 1,
    state: 'unknown'
  };
  actions.readManualSyncState.mockResolvedValue({
    pending: [pending],
    archives: [
      {
        id: 'archive',
        path: 'note.md',
        storageLabel: 'Local',
        createdAt: 1,
        draft: { filename: 'note', source: pending.source, saveMode: 'update' },
        remote: null,
        operations: []
      }
    ],
    history: [pending]
  });
  actions.dismissManualSync.mockResolvedValue(true);
  await render();
  expect(actions.dismissManualSync).not.toHaveBeenCalled();
  expect(
    [...target.querySelectorAll('pre')].some(pre => pre.textContent?.includes(pending.source))
  ).toBe(true);
  expect(target.querySelector('script')).toBeNull();
  button('Снять блокировку').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
  expect(actions.dismissManualSync).toHaveBeenCalledWith(model, pending);
  expect(actions.runStorageSync).not.toHaveBeenCalled();
});

it('invalidates a prepared preview when a refreshed comparison replaces the model', async () => {
  component = mount(StorageSyncHarness, {
    target,
    props: {
      initial: model,
      replacement: {
        ...model,
        columns: model.columns.map(column => ({ ...column, contextId: 'another-context' }))
      },
      oncomplete: complete
    }
  });
  flushSync();
  select('Эталон', 'local:fixture');
  button('Подготовить').click();
  flushSync();
  expect(
    [...target.querySelectorAll('button')].some(button => button.textContent?.includes('Выполнить'))
  ).toBe(true);
  button('Replace comparison').click();
  flushSync();
  expect(
    [...target.querySelectorAll('button')].some(button => button.textContent?.includes('Выполнить'))
  ).toBe(false);
  expect(actions.runStorageSync).not.toHaveBeenCalled();
});

it.each(['resolve', 'reject'] as const)(
  'does not publish a stale recovery %s after a newer unknown result',
  async mode => {
    const first = Promise.withResolvers<{
      pending: unknown[];
      archives: unknown[];
      history: unknown[];
    }>();
    const pending = {
      id: 'manual',
      targetKey: 'cloud:old',
      pathKey: 'note.md',
      path: 'note.md',
      sourceStorageId: 'local:fixture',
      targetStorageId: 'cloud',
      source: OLD_SOURCE,
      startedAt: 1,
      state: 'unknown'
    };
    actions.readManualSyncState
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ pending: [pending], archives: [], history: [] });
    await render();
    select('Эталон', 'local:fixture');
    button('Подготовить').click();
    flushSync();
    button('Выполнить').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync();
    expect(
      [...target.querySelectorAll('button')].some(button =>
        button.textContent?.includes('Проверить запись')
      )
    ).toBe(true);
    if (mode === 'resolve') first.resolve({ pending: [], archives: [], history: [] });
    else first.reject(new Error('stale failure'));
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync();
    expect(
      [...target.querySelectorAll('button')].some(button =>
        button.textContent?.includes('Проверить запись')
      )
    ).toBe(true);
    expect(target.textContent).not.toContain('Не удалось прочитать журнал');
  }
);

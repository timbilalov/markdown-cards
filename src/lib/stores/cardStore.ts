import { getStorageSession } from '../services/storageSession';
import { stateField } from './appState';
import { get, type Readable } from 'svelte/store';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../domain/markdown';
import { migrateMarkdownDocument } from '../domain/markdownMigration';
import { browser } from '$app/environment';
import type { Card, MarkdownMigrationResult, MarkdownParseResult } from '../domain/types';
import type { EditBase } from '../application/cardSync';
import type { CloudUnavailableReason } from '../ports/cloudStorage';
import { getCardSync, retryCardSync, describeSyncStatus } from '../services/cardSyncRuntime';
import { syncFilesFromCloud } from './cloudStore';

export const cardStore = stateField('card');

// Loading status
export const cardLoading = stateField('loading');
export const cardLoadSource = stateField('loadSource');
export const cardLoadTime = stateField('loadTime');
export const cardLoadWarning = stateField('loadWarning');

// Save status
export const cardSaving = stateField('saving');
export const cardSaveError = stateField('saveError');
export const isOffline = stateField('offline');
export const cardSaveMessage = stateField('saveMessage');

export type OpenedCardDocument =
  | {
      status: 'loaded';
      filename: string;
      storageContextId?: string;
      result: MarkdownParseResult;
      migrationError: string | null;
      saveMode: 'create' | 'update';
      readOnlyReason?: 'remote-missing';
      editBase: EditBase;
    }
  | { status: 'unavailable'; filename: string; message: string };

const openedDocument = stateField('document');
export const cardDeliveryStatus = stateField('delivery');
export const cardDocument: Readable<OpenedCardDocument | null> = { subscribe: openedDocument.subscribe };
let loadRequest = 0;
const changedStorageMessage = 'Хранилище изменилось. Откройте заметку заново перед сохранением.';
const contextId = () => getStorageSession()?.descriptor?.contextId;
const documentIsCurrent = (document: Extract<OpenedCardDocument, { status: 'loaded' }>) => document.storageContextId === contextId();
const remoteMissingMessage = 'Заметка не найдена в облаке. Сохранение и обновление формата по этому адресу заблокированы.';

function describeCloudLoadFailure(reason: CloudUnavailableReason): string {
  switch (reason) {
    case 'auth': return 'Ошибка авторизации запроса к API облака.';
    case 'network': return 'Не удалось соединиться с облаком.';
    case 'remote': return 'Облако вернуло ошибку при загрузке заметки.';
    case 'invalid-response': return 'Получен некорректный ответ облака.';
  }
}

function describeFormatProblem(reason: string): string {
  switch (reason) {
    case 'missing-version': return 'Старый формат заметки. Обновите формат перед редактированием и сохранением.';
    case 'unknown-version': return 'Версия формата этой заметки пока не поддерживается.';
    case 'unsupported-content': return 'Неподдерживаемое содержимое: преобразование без потери данных невозможно.';
    case 'invalid-version': return 'Некорректный маркер версии формата.';
    case 'invalid-id': return 'Некорректный идентификатор заметки.';
    case 'invalid-timestamp': return 'Некорректная дата или время в заметке.';
    default: return 'Некорректная структура заметки. Сохранение заблокировано.';
  }
}

export function getCardDocumentSource(document: OpenedCardDocument): string {
  if (document.status === 'unavailable') return '';
  return document.result.status === 'success' ? document.result.document.source : document.result.source;
}

export function getCardDocumentMessage(document: OpenedCardDocument): string | null {
  if (document.status === 'unavailable') return document.message;
  if (document.readOnlyReason === 'remote-missing') return remoteMissingMessage;
  if (document.migrationError) return document.migrationError;
  return document.result.status === 'success' ? null : describeFormatProblem(document.result.reason);
}

export function resetCardDocument(): void {
  loadRequest++;
  cardDeliveryStatus.set('idle');
  openedDocument.set(null);
  cardStore.set(null);
  cardLoading.set(false);
  cardLoadSource.set(null);
  cardLoadWarning.set(null);
  cardSaveError.set(null);
  cardSaveMessage.set(null);
}

export function openNewCard(): void {
  if (!browser) return;
  resetCardDocument();
  isOffline.set(!navigator.onLine);
  const timestamp = Date.now();
  const card: Card = {
    title: 'New Card',
    meta: { id: generateRandomId(), created: timestamp, modified: timestamp },
    description: '',
    sections: []
  };
  const serialized = serializeMarkdownDocument(card);
  if (serialized.status !== 'success') {
    openedDocument.set({ status: 'unavailable', filename: card.meta.id,
      message: describeFormatProblem(serialized.reason) });
    return;
  }
  const result = parseMarkdownDocument(serialized.markdown);
  openedDocument.set({ status: 'loaded', filename: card.meta.id, result,
    ...(contextId() === undefined ? {} : { storageContextId: contextId() }),
    migrationError: null, saveMode: 'create', editBase: { base: { kind: 'missing' } } });
  // The editable draft must not mutate the original document or its ID.
  cardStore.set(result.status === 'success' ? structuredClone(result.document.card) : null);
}

export function migrateCurrentCardFormat(): MarkdownMigrationResult {
  const current = get(openedDocument);
  if (!current || current.status !== 'loaded') {
    return { status: 'invalid', source: '', reason: 'invalid-structure' };
  }
  if (current.readOnlyReason) {
    // Migration must not turn a read-only recovered source into an editable file.
    return { status: 'invalid', source: getCardDocumentSource(current), reason: 'invalid-structure' };
  }
  const result = migrateMarkdownDocument(getCardDocumentSource(current));
  if (result.status !== 'success') {
    openedDocument.set({ ...current, migrationError: describeFormatProblem(result.reason) });
    return result;
  }
  // A repeated call must not replace edits in an already supported document.
  if (result.appliedSteps.length > 0) {
    cardStore.set(structuredClone(result.document.card));
    openedDocument.set({ ...current, result: { status: 'success', document: result.document },
      migrationError: null });
    cardSaveError.set(null);
    cardSaveMessage.set('Формат обновлён в редакторе. Чтобы записать изменения в облако, нажмите Save.');
  }
  return result;
}

function setLoadedDocument(
  document: Extract<OpenedCardDocument, { status: 'loaded' }>,
  source: 'indexeddb' | 'cloud',
  startTime: number,
  message: string | null = null
): void {
  openedDocument.set(document);
  cardStore.set(document.result.status === 'success' ? structuredClone(document.result.document.card) : null);
  cardLoadSource.set(source);
  cardLoadTime.set(performance.now() - startTime);
  cardSaveMessage.set(message);
  isOffline.set(!navigator.onLine);
}

export async function loadCard(filename: string) {
  if (!browser) return;
  const request = ++loadRequest;
  const storageContextId = contextId();
  cardLoading.set(true);
  cardDeliveryStatus.set('idle');
  cardLoadSource.set(null);
  cardLoadWarning.set(null);
  cardSaveError.set(null);
  cardSaveMessage.set(null);
  cardStore.set(null);
  isOffline.set(!navigator.onLine);
  openedDocument.set({ status: 'unavailable', filename, message: 'Заметка загружается.' });
  const startTime = performance.now();

  try {
    const loaded = await (await getCardSync()).load(`${filename}.md`, { checkIsCurrent: () => request === loadRequest });
    if (request !== loadRequest) return;
    if (storageContextId !== contextId()) {
      openedDocument.set({ status: 'unavailable', filename, message: changedStorageMessage }); return;
    }
    if ('source' in loaded) {
      if (loaded.loadFailure) {
        cardLoadWarning.set(`${describeCloudLoadFailure(loaded.loadFailure)} Показана локальная копия; её актуальность в облаке не проверена.`);
      }
      if (loaded.saveId || loaded.status === 'legacy') cardDeliveryStatus.set(loaded.status);
      const result = parseMarkdownDocument(loaded.source);
      setLoadedDocument({ status: 'loaded', filename, result, migrationError: null,
        ...(storageContextId === undefined ? {} : { storageContextId }),
        saveMode: loaded.saveMode,
        editBase: { base: loaded.base, baseSource: loaded.baseSource, previousSaveId: loaded.previousSaveId },
        readOnlyReason: loaded.readOnly ? 'remote-missing' : undefined },
        loaded.origin === 'cloud' ? 'cloud' : 'indexeddb', startTime,
        loaded.origin === 'cloud' ? null : loaded.saveId || loaded.status === 'legacy'
          ? describeSyncStatus(loaded.status) : 'Восстановлена локальная копия. Актуальность в облаке не проверена.');
      if ((loaded.saveId || loaded.status === 'legacy') && !['synced', 'pending', 'offline'].includes(loaded.status)) {
        cardSaveError.set(describeSyncStatus(loaded.status));
      }
      return;
    }
    const message = loaded.status === 'not-found' ? remoteMissingMessage
      : loaded.status === 'storage-error' ? `Не удалось загрузить заметку: ${loaded.detail ?? 'ошибка локального хранилища'}.`
      : loaded.loadFailure ? `${describeCloudLoadFailure(loaded.loadFailure)} Локальная копия отсутствует. Повторите загрузку позже.`
      : 'Исходный Markdown недоступен. Загрузите заметку из облака перед редактированием.';
    if (loaded.status === 'storage-error') {
      openedDocument.set({ status: 'unavailable', filename, message });
      return;
    }
    openedDocument.set({ status: 'unavailable', filename, message });
    cardLoadTime.set(performance.now() - startTime);
    isOffline.set(!navigator.onLine);
  } catch (error) {
    if (request !== loadRequest) return;
    openedDocument.set({ status: 'unavailable', filename,
      message: `Не удалось загрузить заметку: ${error instanceof Error ? error.message : 'ошибка загрузки'}` });
    cardStore.set(null);
  } finally {
    if (request === loadRequest) cardLoading.set(false);
  }
}

async function saveOpenedCard(document: OpenedCardDocument, filename: string, card: Card): Promise<void> {
  cardSaveError.set(null);
  cardSaveMessage.set(null);
  if (get(cardLoading) || document.status !== 'loaded' || document.readOnlyReason || document.result.status !== 'success') {
    cardSaveError.set(getCardDocumentMessage(document) ?? 'Сохранение заметки заблокировано.');
    return;
  }
  if (!documentIsCurrent(document)) { cardSaveError.set(changedStorageMessage); return; }
  if (filename !== document.filename || card.meta.id !== document.result.document.card.meta.id) {
    cardSaveError.set('Нельзя менять адрес или идентификатор открытой заметки при сохранении.');
    return;
  }
  const data = card;
  const serialized = serializeMarkdownDocument({ ...data, meta: { ...data.meta, modified: Date.now() } });
  if (serialized.status !== 'success') {
    cardSaveError.set(describeFormatProblem(serialized.reason));
    return;
  }
  const snapshot = parseMarkdownDocument(serialized.markdown);
  if (snapshot.status !== 'success') {
    cardSaveError.set(describeFormatProblem(snapshot.reason));
    return;
  }
  // The codec creates a separate, validated snapshot before the first await.
  const draftBeforeSave = serializeMarkdownDocument(data);
  cardSaving.set(true);
  try {
    const result = await (await getCardSync()).save(`${filename}.md`, snapshot.document,
      document.editBase);
    if (get(openedDocument) !== document) return;
    if (!documentIsCurrent(document)) { cardSaveError.set(changedStorageMessage); return; }
    cardDeliveryStatus.set(result.status);
    if (!result.savedLocally) {
      cardSaveError.set(result.status === 'storage-error'
        ? 'Не удалось сохранить локально; отправка в облако не выполнена.' : describeSyncStatus(result.status));
      return;
    }
    const current = get(cardStore);
    const currentDraft = serializeMarkdownDocument(current);
    const hasUnsubmittedEdits = draftBeforeSave.status !== 'success' || currentDraft.status !== 'success'
      || currentDraft.markdown !== draftBeforeSave.markdown;
    if (!hasUnsubmittedEdits) cardStore.set(structuredClone(snapshot.document.card));
    const synced = result.status === 'synced';
    if (synced) cardLoadWarning.set(null);
    openedDocument.set({ ...document, result: snapshot,
      saveMode: synced ? 'update' : document.saveMode,
      editBase: synced ? { base: { kind: 'present', revision: null }, baseSource: snapshot.document.source,
        previousSaveId: result.saveId } : { ...document.editBase, previousSaveId: result.saveId } });
    if (['synced', 'pending', 'offline'].includes(result.status)) {
      cardSaveMessage.set(describeSyncStatus(result.status) + (hasUnsubmittedEdits ? ' В редакторе есть новые несохранённые изменения.' : ''));
    } else cardSaveError.set(describeSyncStatus(result.status));
    isOffline.set(!navigator.onLine);
    if (synced) await syncFilesFromCloud();
  } catch (error) {
    if (get(openedDocument) === document) cardSaveError.set('Не удалось сохранить локально; отправка в облако не выполнена.');
  } finally { cardSaving.set(false); }
}

export async function saveCard(filename: string, card: Card) {
  if (!browser) return;
  if (get(cardSaving)) return;
  const document = get(openedDocument);
  if (document) return saveOpenedCard(document, filename, card);

  // A bare Card cannot establish the document's format, destination or save mode.
  cardSaveMessage.set(null);
  cardSaveError.set('Сохранение недоступно без контекста документа. Откройте заметку заново.');
}

function generateRandomId(): string {
  return 'card-' + Math.random().toString(36).substr(2, 9);
}

// Process offline queue
export async function processOfflineQueue(): Promise<void> {
  if (navigator.onLine) {
    await retryCardSync(true);
    await refreshCurrentSyncStatus();
  }
}

// Background completion changes delivery metadata only; keep unsent editor edits.
export async function refreshCurrentSyncStatus(): Promise<void> {
  const document = get(openedDocument);
  if (!document || document.status !== 'loaded' || !documentIsCurrent(document) || !document.editBase?.previousSaveId || get(cardSaving)) return;
  let result;
  try { result = await (await getCardSync()).status(`${document.filename}.md`, document.editBase.previousSaveId,
    getCardDocumentSource(document)); }
  catch { return; }
  if (get(openedDocument) !== document || !documentIsCurrent(document)) return;
  cardDeliveryStatus.set(result.status);
  if (result.status === 'synced') {
    cardLoadWarning.set(null);
    openedDocument.set({ ...document, saveMode: 'update',
      editBase: { ...document.editBase, base: { kind: 'present', revision: null }, baseSource: getCardDocumentSource(document) } });
    const current = get(cardStore);
    const currentSource = serializeMarkdownDocument(current);
    const savedSource = document.result.status === 'success' ? serializeMarkdownDocument(document.result.document.card) : null;
    const hasUnsubmittedEdits = currentSource.status !== 'success' || savedSource?.status !== 'success'
      || currentSource.markdown !== savedSource.markdown;
    cardSaveError.set(null);
    cardSaveMessage.set(describeSyncStatus('synced') + (hasUnsubmittedEdits ? ' В редакторе есть новые несохранённые изменения.' : ''));
  } else if (result.status !== 'pending') cardSaveError.set(describeSyncStatus(result.status));
}

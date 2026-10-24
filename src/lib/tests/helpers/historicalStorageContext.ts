export const historicalDescriptor = {
  id: 'previous',
  label: 'Прежнее подключение',
  provider: 'yandex',
  contextId: `ctx-v1-${'f'.repeat(64)}`,
  capabilities: { revisions: false, conditionalCreate: true }
};
export const historicalLocalId = `local:${historicalDescriptor.contextId}`;

export async function historicalContextDatabase() {
  await (
    await import('../../services/storageSession')
  ).rememberStorageContexts([historicalDescriptor]);
  return (await import('../../services/localStorageContexts')).createContextDatabase(
    historicalDescriptor.contextId
  );
}

export async function saveRepositoryPrototype() {
  return (await import('../../adapters/indexedDb/cardSaveRepository')).IndexedDbCardSaveRepository.prototype;
}

// Shared by ordinary delivery, manual copying and recovery, across all tabs.
export async function withSyncOwnership(task: () => Promise<void>): Promise<boolean | null> {
  if (!navigator.locks) return null;
  return navigator.locks.request(
    'markdown-cards-sync',
    { ifAvailable: true, mode: 'exclusive' },
    async lock => {
      if (!lock) return false;
      await task();
      return true;
    }
  );
}

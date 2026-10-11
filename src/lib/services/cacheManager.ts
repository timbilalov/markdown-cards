import { dbService } from './dbService';
import { cloudService } from './cloudService';
import { performanceMonitor } from './performanceMonitor';
import { getCardSync } from './cardSyncRuntime';
import { parseCloudModifiedTime } from '../utils/cloudMetadata';
import type { Card } from '../domain/types';
import type { CloudFile } from '../types/cloud';

// Cache validation with conservative retention of local data.
export class CacheManager {
  private isValidationRunning: boolean = false;

  // Validate cached cards against cloud data
  async validateCache(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    if (this.isValidationRunning) {
      console.warn('Cache validation is already running');
      return;
    }

    this.isValidationRunning = true;
    const startTime = performanceMonitor.start('cache_validation');
    let success = true;

    try {
      // Get all cached cards
      const cachedCards = await dbService.getAllCards();
      if (signal?.aborted) return;
      // The downloaded document may identify a different Card than its filename.
      // Capture every projection before network I/O, never look it up afterwards.
      const expectedCards = new Map(cachedCards.map(card => [card.meta.id, card]));

      // Get cloud file list
      let cloudFilesResponse;
      try {
        cloudFilesResponse = await cloudService.listFiles(signal);
      } catch (error) {
        console.error('Failed to list cloud files:', error);
        // If we can't list cloud files, we can't validate the cache
        success = false;
        return;
      }

      if (signal?.aborted) return;
      // The common transport rejects malformed lists before any cache changes.
      const cloudFiles = cloudFilesResponse._embedded.items;

      // Create a map of cloud files by name for quick lookup
      const cloudFileMap = new Map<string, CloudFile>();
      cloudFiles.forEach(file => {
        cloudFileMap.set(file.name, file);
      });

      // Check each cached card
      for (const card of cachedCards) {
        if (signal?.aborted) return;
        const fileName = `${card.filename ?? card.meta.id}.md`;
        const cloudFile = cloudFileMap.get(fileName);

        // A missing filename cannot establish that this local Card is
        // disposable: its path may differ, or it may contain unsent work.
        if (!cloudFile) {
          continue;
        }

        // An unknown hint cannot establish that the local cache is current.
        const cloudModified = parseCloudModifiedTime(cloudFile.modified);
        if (cloudModified === undefined || cloudModified > card.meta.modified) {
          // Download updated version from cloud
          try {
            success = await this.refreshCloudFile(cloudFile.name, expectedCards, signal) && success;
          } catch (error) {
            success = false;
            console.error(`Failed to update card from cloud: ${card.meta.id}`, error);
          }
        }

        // Remove from map to track files that exist only in cloud
        cloudFileMap.delete(fileName);
      }

      // Handle files that exist only in cloud (new files)
      for (const [fileName, cloudFile] of cloudFileMap) {
        if (signal?.aborted) return;
        try {
          success = await this.refreshCloudFile(cloudFile.name, expectedCards, signal) && success;
        } catch (error) {
          success = false;
          console.error(`Failed to cache new card from cloud: ${fileName}`, error);
        }
      }

    } catch (error) {
      console.error('Cache validation failed:', error);
      success = false;
    } finally {
      this.isValidationRunning = false;
      if (!signal?.aborted) performanceMonitor.end('cache_validation', startTime, success);
    }
  }

  private async refreshCloudFile(fileName: string, expectedCards: ReadonlyMap<string, Card>, signal?: AbortSignal): Promise<boolean> {
    const result = await (await getCardSync()).load(fileName, { projectCard: true, listed: true,
      expectedCards: [...expectedCards.values()], signal, checkIsCurrent: () => !signal?.aborted });
    // Retaining local work or a concurrently changed cache is intentional.
    // A failed provider/storage read does not count as successful validation.
    return result.status === 'synced' || result.status === 'pending' || result.status === 'legacy'
      || ('source' in result && result.saveId !== undefined);
  }

}

export const cacheManager = new CacheManager();

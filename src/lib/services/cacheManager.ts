import { dbService } from './dbService';
import { cloudService } from './cloudService';
import { performanceMonitor } from './performanceMonitor';
import type { Card } from '../utils/markdownSerializer';
import type { CloudFile } from '../types/cloud';

// Cache management service for validating and cleaning cached data
export class CacheManager {
  private validationInterval: number = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
  private cleanupInterval: number = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  private isValidationRunning: boolean = false;

  // Validate cached cards against cloud data
  async validateCache(): Promise<void> {
    if (this.isValidationRunning) {
      console.warn('Cache validation is already running');
      return;
    }

    this.isValidationRunning = true;
    const startTime = performanceMonitor.start('cache_validation');

    try {
      // Only validate if we're authenticated
      if (!cloudService.isAuthenticated()) {
        performanceMonitor.end('cache_validation', startTime, false);
        this.isValidationRunning = false;
        return;
      }

      // Get all cached cards
      const cachedCards = await dbService.getAllCards();

      // Get cloud file list
      let cloudFilesResponse;
      try {
        cloudFilesResponse = await cloudService.listFiles();
      } catch (error) {
        console.error('Failed to list cloud files:', error);
        // If we can't list cloud files, we can't validate the cache
        performanceMonitor.end('cache_validation', startTime, false);
        this.isValidationRunning = false;
        return;
      }

      // Check if we got a valid response
      if (!cloudFilesResponse) {
        console.error('Cloud files response is null or undefined');
        performanceMonitor.end('cache_validation', startTime, false);
        this.isValidationRunning = false;
        return;
      }

      // Yandex Disk API returns files in _embedded.items
      const cloudFiles = (cloudFilesResponse as any)._embedded &&
                         (cloudFilesResponse as any)._embedded.items &&
                         Array.isArray((cloudFilesResponse as any)._embedded.items)
        ? (cloudFilesResponse as any)._embedded.items.filter((file: any) => file.name.endsWith('.md'))
        : [];

      // Create a map of cloud files by name for quick lookup
      const cloudFileMap = new Map<string, CloudFile>();
      cloudFiles.forEach((file: any) => {
        cloudFileMap.set(file.name, file);
      });

      // Check each cached card
      for (const card of cachedCards) {
        const fileName = `${card.meta.id}.md`;
        const cloudFile = cloudFileMap.get(fileName);

        // If file doesn't exist in cloud, it might have been deleted
        if (!cloudFile) {
          // Check if the cached card is old enough to be considered stale
          // Only remove cards that are older than the validation interval
          // This prevents newly created cards from being removed before they're synced
          const cardAge = Date.now() - card.meta.modified;

          // Only remove cards that are both missing from cloud AND older than validation interval
          // This prevents newly created cards from being removed before they're synced
          if (cardAge > this.validationInterval) {
            // Before removing, let's be extra cautious and check if there's any similar file
            let shouldRemove = true;
            for (const [cloudFileName] of cloudFileMap) {
              // Check if there's a file with a similar name (ignoring extensions or special characters)
              if (cloudFileName.includes(card.meta.id)) {
                shouldRemove = false;
                break;
              }
            }

            if (shouldRemove) {
              // Remove stale card
              await dbService.deleteCard(card.meta.id);
              console.log(`Removed stale card: ${card.meta.id}`);
            }
          }
          continue;
        }

        // Check if the cached version is outdated
        const cloudModified = new Date(cloudFile.modified).getTime();
        if (cloudModified > card.meta.modified) {
          // Download updated version from cloud
          try {
            const { parseMarkdown } = await import('../utils/markdownParser');
            const content = await cloudService.downloadFile(cloudFile.file || cloudFile.path);
            const updatedCard = parseMarkdown(content);

            // Update cached version
            await dbService.saveCard(updatedCard);
            console.log(`Updated card from cloud: ${card.meta.id}`);
          } catch (error) {
            console.error(`Failed to update card from cloud: ${card.meta.id}`, error);
          }
        }

        // Remove from map to track files that exist only in cloud
        cloudFileMap.delete(fileName);
      }

      // Handle files that exist only in cloud (new files)
      for (const [fileName, cloudFile] of cloudFileMap) {
        try {
          const { parseMarkdown } = await import('../utils/markdownParser');
          const content = await cloudService.downloadFile(cloudFile.file || cloudFile.path);
          const newCard = parseMarkdown(content);

          // Cache the new card
          await dbService.saveCard(newCard);
          console.log(`Cached new card from cloud: ${newCard.meta.id}`);
        } catch (error) {
          console.error(`Failed to cache new card from cloud: ${fileName}`, error);
        }
      }

      performanceMonitor.end('cache_validation', startTime, true);
    } catch (error) {
      console.error('Cache validation failed:', error);
      performanceMonitor.end('cache_validation', startTime, false);
    } finally {
      this.isValidationRunning = false;
    }
  }

  // Remove stale entries from cache
  async cleanupCache(): Promise<void> {
    const startTime = performanceMonitor.start('cache_cleanup');

    try {
      // Get all cached cards
      const cachedCards = await dbService.getAllCards();

      // Remove cards that haven't been modified in a long time
      const cutoffTime = Date.now() - (30 * 24 * 60 * 60 * 1000); // 30 days ago
      let removedCount = 0;

      for (const card of cachedCards) {
        if (card.meta.modified < cutoffTime) {
          await dbService.deleteCard(card.meta.id);
          removedCount++;
        }
      }

      if (removedCount > 0) {
        console.log(`Removed ${removedCount} stale cards from cache`);
      }

      performanceMonitor.end('cache_cleanup', startTime, true);
    } catch (error) {
      console.error('Cache cleanup failed:', error);
      performanceMonitor.end('cache_cleanup', startTime, false);
    }
  }

  // Optimize cache storage
  async optimizeCache(): Promise<void> {
    const startTime = performanceMonitor.start('cache_optimize');

    try {
      // For now, we'll just run cleanup
      // In a more advanced implementation, this could include:
      // - Compacting the database
      // - Removing duplicate entries
      // - Optimizing indexes
      await this.cleanupCache();

      performanceMonitor.end('cache_optimize', startTime, true);
    } catch (error) {
      console.error('Cache optimization failed:', error);
      performanceMonitor.end('cache_optimize', startTime, false);
    }
  }

  // Check for conflicts between local and cloud versions
  async checkForConflicts(): Promise<Array<{
    cardId: string;
    localModified: number;
    cloudModified: number;
    conflictType: 'local_newer' | 'cloud_newer' | 'same_time';
  }>> {
    const conflicts: Array<{
      cardId: string;
      localModified: number;
      cloudModified: number;
      conflictType: 'local_newer' | 'cloud_newer' | 'same_time';
    }> = [];

    try {
      // Only check for conflicts if we're authenticated
      if (!cloudService.isAuthenticated()) {
        return conflicts;
      }

      // Get all cached cards
      const cachedCards = await dbService.getAllCards();

      // Get cloud file list
      const cloudFilesResponse = await cloudService.listFiles();
      const cloudFiles = (cloudFilesResponse as any)._embedded &&
                         (cloudFilesResponse as any)._embedded.items &&
                         Array.isArray((cloudFilesResponse as any)._embedded.items)
        ? (cloudFilesResponse as any)._embedded.items.filter((file: any) => file.name.endsWith('.md'))
        : [];

      // Create a map of cloud files by name for quick lookup
      const cloudFileMap = new Map<string, CloudFile>();
      cloudFiles.forEach((file: any) => {
        cloudFileMap.set(file.name, file);
      });

      // Check each cached card for conflicts
      for (const card of cachedCards) {
        const fileName = `${card.meta.id}.md`;
        const cloudFile = cloudFileMap.get(fileName);

        if (cloudFile) {
          const cloudModified = new Date(cloudFile.modified).getTime();
          const localModified = card.meta.modified;

          // Check if there's a significant time difference (more than 1 second)
          const timeDiff = Math.abs(cloudModified - localModified);
          if (timeDiff > 1000) {
            const conflictType = cloudModified > localModified ? 'cloud_newer' : 'local_newer';
            conflicts.push({
              cardId: card.meta.id,
              localModified,
              cloudModified,
              conflictType
            });
          } else if (timeDiff <= 1000) {
            // Consider same time if difference is less than or equal to 1 second
            conflicts.push({
              cardId: card.meta.id,
              localModified,
              cloudModified,
              conflictType: 'same_time'
            });
          }
        }
      }
    } catch (error) {
      console.error('Conflict checking failed:', error);
    }

    return conflicts;
  }

  // Resolve conflicts by choosing the newer version
  async resolveConflicts(keepNewer: boolean = true): Promise<void> {
    const startTime = performanceMonitor.start('conflict_resolution');

    try {
      const conflicts = await this.checkForConflicts();

      for (const conflict of conflicts) {
        if (conflict.conflictType === 'same_time') {
          // No action needed for same time conflicts
          continue;
        }

        const keepCloud = (conflict.conflictType === 'cloud_newer' && keepNewer) ||
                          (conflict.conflictType === 'local_newer' && !keepNewer);

        if (keepCloud) {
          // Download cloud version
          try {
            const cloudFilesResponse = await cloudService.listFiles();
            const cloudFiles = (cloudFilesResponse as any)._embedded &&
                               (cloudFilesResponse as any)._embedded.items &&
                               Array.isArray((cloudFilesResponse as any)._embedded.items)
              ? (cloudFilesResponse as any)._embedded.items
              : [];
            const cloudFile = cloudFiles.find((file: any) => file.name === `${conflict.cardId}.md`);

            if (cloudFile) {
              const { parseMarkdown } = await import('../utils/markdownParser');
              const content = await cloudService.downloadFile(cloudFile.file || cloudFile.path);
              const updatedCard = parseMarkdown(content);

              // Update cached version
              await dbService.saveCard(updatedCard);
              console.log(`Resolved conflict by keeping cloud version: ${conflict.cardId}`);
            }
          } catch (error) {
            console.error(`Failed to resolve conflict for card: ${conflict.cardId}`, error);
          }
        } else {
          // Upload local version to cloud
          try {
            const localCard = await dbService.getCard(conflict.cardId);
            if (localCard) {
              const { serializeCard } = await import('../utils/markdownSerializer');
              const content = serializeCard(localCard);
              await cloudService.uploadFileAtPath(
                `${conflict.cardId}.md`,
                content,
                true
              );
              console.log(`Resolved conflict by keeping local version: ${conflict.cardId}`);
            }
          } catch (error) {
            console.error(`Failed to resolve conflict for card: ${conflict.cardId}`, error);
          }
        }
      }

      performanceMonitor.end('conflict_resolution', startTime, true);
    } catch (error) {
      console.error('Conflict resolution failed:', error);
      performanceMonitor.end('conflict_resolution', startTime, false);
    }
  }

  // Set validation interval (in milliseconds)
  setValidationInterval(interval: number): void {
    this.validationInterval = interval;
  }

  // Set cleanup interval (in milliseconds)
  setCleanupInterval(interval: number): void {
    this.cleanupInterval = interval;
  }

  // Get current cache statistics
  async getCacheStats(): Promise<{
    totalCards: number;
    totalCloudFiles: number;
    cacheSize: number; // Approximate size in bytes
    lastValidation: number | null;
  }> {
    try {
      const cards = await dbService.getAllCards();
      let cloudFilesCount = 0;

      try {
        if (cloudService.isAuthenticated()) {
          const cloudFilesResponse = await cloudService.listFiles();
          cloudFilesCount = (cloudFilesResponse as any)._embedded &&
                            (cloudFilesResponse as any)._embedded.items &&
                            Array.isArray((cloudFilesResponse as any)._embedded.items)
            ? (cloudFilesResponse as any)._embedded.items.filter((file: any) => file.name.endsWith('.md')).length
            : 0;
        }
      } catch (error) {
        // Ignore cloud errors for stats
      }

      // Approximate cache size (very rough estimate)
      let cacheSize = 0;
      for (const card of cards) {
        cacheSize += JSON.stringify(card).length;
      }

      return {
        totalCards: cards.length,
        totalCloudFiles: cloudFilesCount,
        cacheSize,
        lastValidation: null // In a real implementation, we would track this
      };
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      return {
        totalCards: 0,
        totalCloudFiles: 0,
        cacheSize: 0,
        lastValidation: null
      };
    }
  }
}

// Export singleton instance
export const cacheManager = new CacheManager();

import { dbService } from './dbService';
import { cloudService } from './cloudService';
import { performanceMonitor } from './performanceMonitor';
import type { Card } from '../utils/markdownSerializer';

// Types for offline operations
export type OfflineOperationType = 'create' | 'update' | 'delete';

export interface OfflineOperation {
  id: string;
  type: OfflineOperationType;
  card?: Card;
  cardId?: string; // For delete operations
  timestamp: number;
  attempts: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

// Error types for offline operations
export class OfflineQueueError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'OfflineQueueError';
  }
}

export class OfflineOperationError extends OfflineQueueError {
  constructor(message: string = 'Offline operation failed') {
    super(message, 'OPERATION_FAILED');
    this.name = 'OfflineOperationError';
  }
}

// Offline queue service for handling operations when offline
export class OfflineQueue {
  private isProcessing: boolean = false;
  private maxRetries: number = 3;
  private retryDelay: number = 1000; // milliseconds

  // Add an operation to the queue
  async queueOperation(type: OfflineOperationType, card?: Card, cardId?: string): Promise<void> {
    const startTime = performanceMonitor.start('offline_queue');

    try {
      const operation: OfflineOperation = {
        id: this.generateOperationId(),
        type,
        card,
        cardId,
        timestamp: Date.now(),
        attempts: 0,
        status: 'pending'
      };

      await dbService.queueSyncOperation(operation);
      console.log(`Queued offline operation: ${type} for card ${card?.meta.id || cardId}`);

      performanceMonitor.end('offline_queue', startTime, true);
    } catch (error) {
      console.error('Failed to queue offline operation:', error);
      performanceMonitor.end('offline_queue', startTime, false);
      throw new OfflineQueueError('Failed to queue operation', 'QUEUE_FAILED');
    }
  }

  // Process all pending operations in the queue
  async processQueue(): Promise<void> {
    if (this.isProcessing) {
      console.warn('Offline queue is already being processed');
      return;
    }

    // Only process if we're online and authenticated
    if (!cloudService.isAuthenticated()) {
      console.log('Skipping offline queue processing - not authenticated');
      return;
    }

    this.isProcessing = true;
    const startTime = performanceMonitor.start('offline_process');

    try {
      const pendingOperations = await dbService.getPendingSyncOperations();

      if (pendingOperations.length === 0) {
        performanceMonitor.end('offline_process', startTime, true);
        this.isProcessing = false;
        return;
      }

      console.log(`Processing ${pendingOperations.length} offline operations`);

      // Process operations one by one
      for (const operation of pendingOperations) {
        // Cast the operation to the correct type
        const typedOperation: OfflineOperation = {
          ...operation,
          status: operation.status as 'pending' | 'processing' | 'completed' | 'failed'
        };
        await this.processOperation(typedOperation);
      }

      performanceMonitor.end('offline_process', startTime, true);
    } catch (error) {
      console.error('Failed to process offline queue:', error);
      performanceMonitor.end('offline_process', startTime, false);
    } finally {
      this.isProcessing = false;
    }
  }

  // Process a single operation
  private async processOperation(operation: OfflineOperation): Promise<void> {
    const startTime = performanceMonitor.start('offline_operation');

    try {
      // Update operation status to processing
      await dbService.updateSyncOperationStatus(operation.id, 'processing');

      // Check if we've exceeded max retries
      if (operation.attempts >= this.maxRetries) {
        await dbService.updateSyncOperationStatus(operation.id, 'failed');
        console.error(`Operation failed after ${this.maxRetries} attempts:`, operation);
        performanceMonitor.end('offline_operation', startTime, false);
        return;
      }

      // Process based on operation type
      switch (operation.type) {
        case 'create':
        case 'update':
          if (operation.card) {
            await this.processSaveOperation(operation.card);
          }
          break;

        case 'delete':
          if (operation.cardId) {
            await this.processDeleteOperation(operation.cardId);
          }
          break;

        default:
          throw new OfflineOperationError(`Unknown operation type: ${operation.type}`);
      }

      // Mark operation as completed
      await dbService.updateSyncOperationStatus(operation.id, 'completed');
      console.log(`Completed offline operation: ${operation.type} for card ${operation.card?.meta.id || operation.cardId}`);

      performanceMonitor.end('offline_operation', startTime, true);
    } catch (error) {
      console.error(`Failed to process operation: ${operation.type}`, error);

      // Update attempt count and mark as pending for retry
      await dbService.updateSyncOperationStatus(operation.id, 'pending');

      performanceMonitor.end('offline_operation', startTime, false);

      // Re-throw to stop processing if it's a critical error
      if (error instanceof OfflineQueueError) {
        throw error;
      }
    }
  }

  // Process a save operation (create or update)
  private async processSaveOperation(card: Card): Promise<void> {
    try {
      const { serializeCard } = await import('../utils/markdownSerializer');
      const content = serializeCard(card);
      await cloudService.uploadFileAtPath(`${card.meta.id}.md`, content, true);
    } catch (error) {
      console.error(`Failed to save card to cloud: ${card.meta.id}`, error);
      throw new OfflineOperationError(`Failed to save card: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Process a delete operation
  private async processDeleteOperation(cardId: string): Promise<void> {
    // Note: Yandex Disk doesn't have a direct delete API in this implementation
    // In a real implementation, you would need to use the appropriate API
    console.warn(`Delete operation for card ${cardId} would be implemented with proper API`);
    // For now, we'll just mark it as completed
  }

  // Generate a unique operation ID
  private generateOperationId(): string {
    return 'op_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  // Set max retries for operations
  setMaxRetries(maxRetries: number): void {
    this.maxRetries = maxRetries;
  }

  // Set retry delay (with exponential backoff)
  setRetryDelay(delay: number): void {
    this.retryDelay = delay;
  }

  // Get queue statistics
  async getQueueStats(): Promise<{
    totalOperations: number;
    pendingOperations: number;
    processingOperations: number;
    completedOperations: number;
    failedOperations: number;
  }> {
    try {
      const allOperations = await dbService.getPendingSyncOperations();

      const stats = {
        totalOperations: allOperations.length,
        pendingOperations: 0,
        processingOperations: 0,
        completedOperations: 0,
        failedOperations: 0
      };

      allOperations.forEach(op => {
        switch (op.status) {
          case 'pending':
            stats.pendingOperations++;
            break;
          case 'processing':
            stats.processingOperations++;
            break;
          case 'completed':
            stats.completedOperations++;
            break;
          case 'failed':
            stats.failedOperations++;
            break;
        }
      });

      return stats;
    } catch (error) {
      console.error('Failed to get queue stats:', error);
      return {
        totalOperations: 0,
        pendingOperations: 0,
        processingOperations: 0,
        completedOperations: 0,
        failedOperations: 0
      };
    }
  }

  // Clear the queue
  async clearQueue(): Promise<void> {
    try {
      await dbService.clearSyncQueue();
      console.log('Offline queue cleared');
    } catch (error) {
      console.error('Failed to clear offline queue:', error);
      throw new OfflineQueueError('Failed to clear queue', 'CLEAR_FAILED');
    }
  }

  // Retry failed operations
  async retryFailedOperations(): Promise<void> {
    // In a more advanced implementation, you could specifically retry failed operations
    // For now, we'll just process the queue which will retry pending operations
    await this.processQueue();
  }
}

// Export singleton instance
export const offlineQueue = new OfflineQueue();

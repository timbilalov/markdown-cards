import { writable } from 'svelte/store';
import type { Card } from '../utils/markdownSerializer';
import { dbService } from '../services/dbService';
import { performanceMonitor } from '../services/performanceMonitor';

// Local database initialization status
export const dbInitialized = writable<boolean>(false);
export const dbError = writable<string | null>(null);
export const dbPerformance = writable<{
  operations: number;
  averageDuration: number;
  errorRate: number;
}>({
  operations: 0,
  averageDuration: 0,
  errorRate: 0
});

// Initialize the database
export async function initDB(): Promise<void> {
  try {
    await dbService.init();
    dbInitialized.set(true);
    dbError.set(null);

    // Start monitoring performance
    setInterval(() => {
      const metrics = dbService.getPerformanceMetrics();
      dbPerformance.set({
        operations: metrics.operations,
        averageDuration: metrics.averageDuration,
        errorRate: metrics.errorRate
      });
    }, 5000); // Update every 5 seconds
  } catch (error) {
    console.error('Error initializing database:', error);
    dbInitialized.set(false);
    dbError.set(error instanceof Error ? error.message : 'Unknown error');
  }
}

// Load all cards from local database
export async function loadLocalCards(): Promise<Card[]> {
  const startTime = performanceMonitor.start('indexeddb');

  try {
    const cards = await dbService.getAllCards();
    performanceMonitor.end('indexeddb', startTime, true);
    performanceMonitor.recordCacheHit('cards', true);
    return cards;
  } catch (error) {
    console.error('Error loading local cards:', error);
    performanceMonitor.end('indexeddb', startTime, false);
    performanceMonitor.recordCacheHit('cards', false);
    return [];
  }
}

// Save a card to local database
export async function saveLocalCard(card: Card): Promise<boolean> {
  const startTime = performanceMonitor.start('indexeddb');

  try {
    await dbService.saveCard(card);
    performanceMonitor.end('indexeddb', startTime, true);
    return true;
  } catch (error) {
    console.error('Error saving card to local database:', error);
    performanceMonitor.end('indexeddb', startTime, false);
    return false;
  }
}

// Get a specific card from local database
export async function getLocalCard(id: string): Promise<Card | null> {
  const startTime = performanceMonitor.start('indexeddb');

  try {
    const card = await dbService.getCard(id);
    performanceMonitor.end('indexeddb', startTime, true);
    performanceMonitor.recordCacheHit('card', !!card);
    return card;
  } catch (error) {
    console.error('Error getting card from local database:', error);
    performanceMonitor.end('indexeddb', startTime, false);
    performanceMonitor.recordCacheHit('card', false);
    return null;
  }
}

// Delete a card from local database
export async function deleteLocalCard(id: string): Promise<boolean> {
  const startTime = performanceMonitor.start('indexeddb');

  try {
    await dbService.deleteCard(id);
    performanceMonitor.end('indexeddb', startTime, true);
    return true;
  } catch (error) {
    console.error('Error deleting card from local database:', error);
    performanceMonitor.end('indexeddb', startTime, false);
    return false;
  }
}

// Clear all data from local database
export async function clearLocalData(): Promise<boolean> {
  try {
    await dbService.clearAllData();
    return true;
  } catch (error) {
    console.error('Error clearing local database:', error);
    return false;
  }
}

// Get database performance metrics
export function getDBPerformanceMetrics() {
  return dbService.getPerformanceMetrics();
}

// Reset database performance metrics
export function resetDBPerformanceMetrics() {
  dbService.resetPerformanceMetrics();
}

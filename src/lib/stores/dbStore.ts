import { stateField } from './appState';
import type { BoardLocalEntry } from '../domain/types';
import { dbService } from '../services/dbService';
import { performanceMonitor } from '../services/performanceMonitor';

export const dbInitialized = stateField('dbInitialized');
export const dbError = stateField('dbError');

// Initialize the database
export async function initDB(): Promise<void> {
  try {
    await dbService.init();
    dbInitialized.set(true);
    dbError.set(null);

  } catch (error) {
    console.error('Error initializing database:', error);
    dbInitialized.set(false);
    dbError.set(error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

// Load all cards from local database
export async function loadLocalCards(): Promise<BoardLocalEntry[]> {
  const startTime = performanceMonitor.start('indexeddb');

  try {
    const cards = await dbService.getBoardCards();
    performanceMonitor.end('indexeddb', startTime, true);
    performanceMonitor.recordCacheHit('cards', true);
    return cards;
  } catch (error) {
    console.error('Error loading local cards:', error);
    performanceMonitor.end('indexeddb', startTime, false);
    performanceMonitor.recordCacheHit('cards', false);
    throw error;
  }
}

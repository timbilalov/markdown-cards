import { writable } from 'svelte/store';
import type { Card } from '../types';
import { dbService } from '../services/dbService';

// Local database initialization status
export const dbInitialized = writable<boolean>(false);

// Initialize the database
export async function initDB(): Promise<void> {
  try {
    await dbService.init();
    dbInitialized.set(true);
  } catch (error) {
    console.error('Error initializing database:', error);
    dbInitialized.set(false);
  }
}

// Load all cards from local database
export async function loadLocalCards(): Promise<Card[]> {
  try {
    return await dbService.getAllCards();
  } catch (error) {
    console.error('Error loading local cards:', error);
    return [];
  }
}

// Save a card to local database
export async function saveLocalCard(card: Card): Promise<boolean> {
  try {
    await dbService.saveCard(card);
    return true;
  } catch (error) {
    console.error('Error saving card to local database:', error);
    return false;
  }
}

// Get a specific card from local database
export async function getLocalCard(id: string): Promise<Card | null> {
  try {
    return await dbService.getCard(id);
  } catch (error) {
    console.error('Error getting card from local database:', error);
    return null;
  }
}

// Delete a card from local database
export async function deleteLocalCard(id: string): Promise<boolean> {
  try {
    await dbService.deleteCard(id);
    return true;
  } catch (error) {
    console.error('Error deleting card from local database:', error);
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

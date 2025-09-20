import { cloudService } from '../services/cloudService';
import { dbService } from '../services/dbService';
import { parseMarkdown } from './markdownParser';
import { serializeCard } from './markdownSerializer';
import type { Card } from '../types';

/**
 * Test function to verify cloud integration
 * This function can be called from the browser console for testing
 */
export async function testCloudIntegration(): Promise<void> {
  try {
    console.log('Testing cloud integration...');

    // Initialize database
    await dbService.init();
    console.log('Database initialized');

    // Check if cloud service is authenticated
    if (!cloudService.isAuthenticated()) {
      throw new Error('Cloud service not authenticated. Please set VITE_YANDEX_DISK_TOKEN in your .env file.');
    }

    cloudService.setBasePath('md-cards');
    console.log('Cloud service configured');

    // Test file listing
    console.log('Fetching file list...');
    const fileList = await cloudService.listFiles();
    console.log(`Found ${fileList._embedded.items.length} files`);

    // Test downloading a file (if any exist)
    if (fileList._embedded.items.length > 0) {
      const firstFile = fileList._embedded.items[0];
      if (firstFile.file) {
        console.log(`Downloading file: ${firstFile.name}`);
        const content = await cloudService.downloadFile(firstFile.file);
        console.log(`Downloaded ${content.length} characters`);

        // Parse and cache the card
        const card = parseMarkdown(content);
        await dbService.saveCard(card);
        console.log(`Cached card with ID: ${card.meta.id}`);
      }
    }

    // Test creating and uploading a new card
    console.log('Creating test card...');
    const testCard: Card = {
      title: 'Test Card',
      meta: {
        id: 'test-card-' + Date.now(),
        created: Date.now(),
        modified: Date.now()
      },
      description: 'This is a test card created by the cloud integration test.',
      sections: [
        {
          heading: 'Test Section',
          type: 'unordered',
          items: [
            { text: 'Test item 1', checked: false },
            { text: 'Test item 2', checked: true }
          ]
        }
      ]
    };

    // Serialize and upload
    const markdown = serializeCard(testCard);
    const filename = `${testCard.meta.id}.md`;

    console.log(`Uploading test card as ${filename}`);
    await cloudService.uploadFileAtPath(filename, markdown);
    console.log('Test card uploaded successfully');

    // Verify upload by listing files again
    console.log('Verifying upload...');
    const updatedFileList = await cloudService.listFiles();
    const uploadedFile = updatedFileList._embedded.items.find(
      item => item.name === filename
    );

    if (uploadedFile) {
      console.log('Upload verified successfully');
    } else {
      console.warn('Could not verify upload - file not found in list');
    }

    console.log('Cloud integration test completed successfully');
  } catch (error) {
    console.error('Cloud integration test failed:', error);
    throw error;
  }
}

/**
 * Test function to verify local database operations
 */
export async function testLocalDatabase(): Promise<void> {
  try {
    console.log('Testing local database...');

    // Initialize database
    await dbService.init();
    console.log('Database initialized');

    // Create a test card
    const testCard: Card = {
      title: 'DB Test Card',
      meta: {
        id: 'db-test-' + Date.now(),
        created: Date.now(),
        modified: Date.now()
      },
      description: 'This is a test card for database operations.',
      sections: []
    };

    // Save to database
    console.log('Saving test card to database');
    await dbService.saveCard(testCard);
    console.log('Test card saved');

    // Retrieve from database
    console.log('Retrieving test card from database');
    const retrievedCard = await dbService.getCard(testCard.meta.id);
    if (retrievedCard) {
      console.log('Test card retrieved successfully');
      console.log('Title:', retrievedCard.title);
    } else {
      console.warn('Could not retrieve test card');
    }

    // Get all cards
    console.log('Retrieving all cards');
    const allCards = await dbService.getAllCards();
    console.log(`Found ${allCards.length} cards in database`);

    console.log('Local database test completed successfully');
  } catch (error) {
    console.error('Local database test failed:', error);
    throw error;
  }
}

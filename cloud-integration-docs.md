# Cloud Integration Documentation

This document explains how to use the cloud integration features of the Markdown Card Editor application.

## Overview

The application now supports cloud storage integration with Yandex Disk, allowing users to store and sync their markdown cards across devices. The implementation provides dual persistence with local IndexedDB caching for offline access and cloud storage for synchronization.

## Architecture

The cloud integration is built on the following components:

1. **Cloud Service** (`src/lib/services/cloudService.ts`) - Handles all Yandex Disk API interactions
2. **Database Service** (`src/lib/services/dbService.ts`) - Manages local IndexedDB storage
3. **Cloud Store** (`src/lib/stores/cloudStore.ts`) - Svelte store for cloud state management
4. **DB Store** (`src/lib/stores/dbStore.ts`) - Svelte store for local database state
5. **API Endpoints** (`src/routes/api/cloud/*`) - Server-side cloud API endpoints

## Setup

### 1. Obtain Yandex Disk OAuth Token

To use the cloud integration, you need a Yandex Disk OAuth token:

1. Visit the [Yandex OAuth page](https://oauth.yandex.ru/)
2. Create a new application or use an existing one
3. Request the `disk:read` and `disk:write` permissions
4. Generate an OAuth token for your application

### 2. Configure the Application

Provide the OAuth token via environment variable:

- Set `VITE_YANDEX_DISK_TOKEN` in your `.env` file

## Usage

The application will automatically sync your files from the `md-cards` folder in your Yandex Disk if the `VITE_YANDEX_DISK_TOKEN` environment variable is configured.

### File Management

- **Viewing Files**: All `.md` files in your `md-cards` Yandex Disk folder will appear on the main page
- **Creating New Cards**: Click the "+ New Card" button to create a new card
- **Editing Cards**: Click on any card to open it in the editor
- **Saving Cards**: Click the "Save" button to save changes to both local cache and cloud storage

### Offline Support

The application automatically caches all files locally in IndexedDB:

- When online, files are fetched from Yandex Disk and cached locally
- When offline, files are served from the local cache
- Changes made offline are synced when the connection is restored

## API Endpoints

### Cloud File Listing

```
GET /api/cloud/files
```

Returns a list of files in the `md-cards` folder.

### Cloud File Download

```
GET /api/cloud/download?path=FILE_PATH
```

Downloads a specific file from Yandex Disk.

### Cloud File Upload

```
POST /api/cloud/upload
Content-Type: multipart/form-data

FormData:
  path: filename.md
  content: file content
  overwrite: true
```

Uploads a file to Yandex Disk.

## Data Structure

Files are stored in Yandex Disk in a folder named `md-cards`. Each markdown file follows the existing card structure:

```markdown
# Card Title

## Data

Card description.

### Section Heading

- List item 1
- [x] Checklist item 2
- [ ] Checklist item 3

## Meta

### ID

card-identifier

### Created

2025-01-01

### Modified

2025-01-02
```

## Error Handling

The application handles various error scenarios:

- **Network Errors**: Automatically retries failed operations
- **Authentication Errors**: Notifies users of configuration issues
- **File Conflicts**: Preserves both versions of conflicting files
- **Storage Limits**: Notifies users when storage limits are approached

## Sync Process

The synchronization process works as follows:

1. On application start, fetch file list from cloud
2. Compare with local cache timestamps
3. Download updated files from cloud
4. Upload local changes to cloud
5. Handle conflicts appropriately

## Local Storage

All data is cached locally in IndexedDB:

- **Cards Store**: Stores parsed card objects
- **Files Store**: Stores cloud file metadata

The local cache is automatically updated during sync operations.

## Security

- OAuth tokens are configured via environment variables (server-side only)
- All API requests use HTTPS
- File content is not stored in logs or error messages
- Tokens are not transmitted in URLs

## Troubleshooting

### Common Issues

1. **Authentication Failed**: Verify your OAuth token has the correct permissions and is properly configured in the environment variables
2. **Files Not Syncing**: Check your internet connection and Yandex Disk quota
3. **Offline Access Not Working**: Ensure the application has loaded at least once while online

### Debugging

You can inspect the local cache using browser developer tools:

1. Open Developer Tools (F12)
2. Go to the "Application" tab
3. Select "IndexedDB" in the left sidebar
4. Explore the `MarkdownCardsDB` database

## Future Improvements

Planned enhancements include:

- Conflict resolution UI
- Selective sync options
- File versioning
- Shared folder support
- Real-time collaboration features

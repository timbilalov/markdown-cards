# Cloud-Based Markdown Card Editor with Yandex Disk Integration

## Architecture Overview

```mermaid
graph TD
    A[Browser Client] --> B[Frontend Svelte App]
    B --> C[IndexedDB Local Storage]
    B --> D[Yandex Disk API]
    D --> E[Cloud Storage]
    C --> F[Local Cache]
    F --> B
    E --> D
    D --> B
```

## Component Structure

```mermaid
graph TD
    A[App.svelte] --> B[Main Page +page.svelte]
    A --> C[Card Editor CardEditor.svelte]
    C --> D[List Manager ListManager.svelte]
    C --> E[Markdown Preview MarkdownPreview.svelte]
    F[Stores] --> G[Card Store cardStore.ts]
    F --> H[Cloud Store cloudStore.ts]
    F --> I[DB Store dbStore.ts]
    J[Utils] --> K[Markdown Parser markdownParser.ts]
    J --> L[Markdown Serializer markdownSerializer.ts]
    J --> M[Cloud Service cloudService.ts]
    J --> N[DB Service dbService.ts]
```

## Data Flow

```mermaid
sequenceDiagram
    participant U as User
    participant C as Client
    participant I as IndexedDB
    participant Y as Yandex Disk API

    U->>C: Open App
    C->>Y: Fetch File List
    Y-->>C: File List Response
    C->>I: Store File List
    C->>U: Display File Links

    U->>C: Click File Link
    C->>I: Check Local Cache
    alt File in Cache
        I-->>C: Return Cached Content
    else File not in Cache
        C->>Y: Download File
        Y-->>C: File Content
        C->>I: Store in Cache
    end
    C-->>U: Display in Editor

    U->>C: Edit & Save
    C->>I: Update Local Cache
    C->>Y: Get Upload URL
    Y-->>C: Upload URL
    C->>Y: Upload File Content
    Y-->>C: Confirmation
    C-->>U: Save Confirmation
```

## Implementation Steps

### 1. Core Infrastructure
- Create IndexedDB service for local storage
- Create Yandex Disk API service for cloud operations
- Implement authentication mechanism for Yandex OAuth

### 2. Data Management
- Enhance existing stores to work with both local and cloud storage
- Implement synchronization logic between local and cloud storage
- Add offline capability with automatic sync when online

### 3. UI Components
- Modify main page to show cloud files
- Enhance editor to handle cloud save operations
- Add cloud status indicators (sync status, online/offline)

### 4. API Integration
- Implement file listing from Yandex Disk
- Implement file download from Yandex Disk
- Implement file upload to Yandex Disk

## File Modifications Needed

1. **src/lib/stores/cardStore.ts** - Enhance with cloud integration
2. **src/routes/+page.server.ts** - Modify to fetch from cloud instead of local files
3. **src/routes/+page.svelte** - Update to display cloud files
4. **src/lib/components/CardEditor.svelte** - Add cloud save functionality
5. **src/routes/api/files/+server.ts** - Replace with cloud integration
6. **src/routes/api/save/+server.ts** - Replace with cloud integration
7. **src/routes/markdown/[filename]/+server.ts** - Replace with cloud integration

## New Files to be Created

1. **src/lib/services/cloudService.ts** - Yandex Disk API integration
2. **src/lib/services/dbService.ts** - IndexedDB service
3. **src/lib/stores/cloudStore.ts** - Cloud state management
4. **src/lib/stores/dbStore.ts** - Local database state management
5. **src/lib/types/cloud.ts** - Cloud-related type definitions
6. **src/routes/api/cloud/[operation]/+server.ts** - Cloud API endpoints

## Detailed Implementation Plan

### Phase 1: Infrastructure Setup
1. Create IndexedDB service for local caching
2. Create Yandex Disk API service
3. Implement authentication handling
4. Set up cloud and database stores

### Phase 2: Data Management
1. Enhance card store with cloud integration
2. Implement synchronization logic
3. Add offline support
4. Create data consistency checks

### Phase 3: UI Integration
1. Modify main page to show cloud files
2. Enhance editor with cloud save
3. Add status indicators
4. Implement error handling UI

### Phase 4: API Integration
1. Replace file listing with cloud version
2. Replace file download with cloud version
3. Replace file upload with cloud version
4. Add error handling and retry logic

### Phase 5: Testing & Refinement
1. Test offline functionality
2. Test synchronization
3. Verify data consistency
4. Optimize performance

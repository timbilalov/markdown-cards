import type { CloudFileListResponse, CloudUploadUrlResponse } from '../types/cloud';
import { dbService } from './dbService';

// Error types for better error handling
export class CloudError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'CloudError';
  }
}

export class CloudAuthError extends CloudError {
  constructor(message: string = 'Cloud authentication failed') {
    super(message, 'AUTH_FAILED');
    this.name = 'CloudAuthError';
  }
}

export class CloudNetworkError extends CloudError {
  constructor(message: string = 'Network error') {
    super(message, 'NETWORK_ERROR');
    this.name = 'CloudNetworkError';
  }
}

export class CloudService {
  private readonly API_BASE = 'https://cloud-api.yandex.net/v1/disk';
  private accessToken: string | null = null;
  private basePath: string = 'md-cards';

  constructor() {
    // Initialize with the token from environment variables
    if (typeof window !== 'undefined') {
      // Client-side: get from Vite environment variables
      this.accessToken = import.meta.env.VITE_YANDEX_DISK_TOKEN || null;
    } else {
      // Server-side: get from process.env
      this.accessToken = process.env.VITE_YANDEX_DISK_TOKEN || null;
    }
  }

  // This method is kept for backward compatibility but will only work on the client side
  setAccessToken(token: string | null): void {
    if (typeof window !== 'undefined') {
      this.accessToken = token;
    }
  }

  setBasePath(path: string): void {
    this.basePath = path;
  }

  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      'Accept': 'application/json',
    };

    if (this.accessToken) {
      headers['Authorization'] = `OAuth ${this.accessToken}`;
    }

    return headers;
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      // Handle specific error cases
      if (response.status === 401 || response.status === 403) {
        throw new CloudAuthError('Authentication failed');
      }

      if (response.status >= 500) {
        throw new CloudNetworkError(`Server error: ${response.status}`);
      }

      throw new CloudError(`HTTP error! status: ${response.status}`, `HTTP_${response.status}`);
    }
    return await response.json();
  }

  // Utility function to handle network operations with retry logic
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    delay: number = 1000
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        // Don't retry for authentication errors
        if (error instanceof CloudAuthError) {
          throw error;
        }

        // If this is the last attempt, throw the error
        if (attempt === maxRetries) {
          throw error;
        }

        // Wait before retrying with exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, attempt)));
      }
    }

    throw lastError;
  }

  // Fetch list of files from Yandex Disk
  async listFiles(): Promise<CloudFileListResponse> {
    if (!this.accessToken) {
      throw new CloudAuthError('Access token not set');
    }

    return await this.executeWithRetry(async () => {
      const url = `${this.API_BASE}/resources?path=${encodeURIComponent(this.basePath)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      });

      const data = await this.handleResponse<CloudFileListResponse>(response);

      // Cache the file list in IndexedDB
      if (data._embedded && data._embedded.items && Array.isArray(data._embedded.items)) {
        for (const file of data._embedded.items) {
          await dbService.saveCloudFile(file);
        }
      }

      return data;
    });
  }

  // Download file content from Yandex Disk
  async downloadFile(fileUrl: string): Promise<string> {
    if (!this.accessToken) {
      throw new CloudAuthError('Access token not set');
    }

    return await this.executeWithRetry(async () => {
      const response = await fetch(fileUrl, {
        method: 'GET',
        headers: this.getHeaders()
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new CloudAuthError('Authentication failed');
        }

        if (response.status >= 500) {
          throw new CloudNetworkError(`Server error: ${response.status}`);
        }

        throw new CloudError(`HTTP error! status: ${response.status}`, `HTTP_${response.status}`);
      }

      return await response.text();
    });
  }

  // Get upload URL from Yandex Disk
  async getUploadUrl(filePath: string, overwrite: boolean = true): Promise<CloudUploadUrlResponse> {
    if (!this.accessToken) {
      throw new CloudAuthError('Access token not set');
    }

    return await this.executeWithRetry(async () => {
      const fullPath = `${this.basePath}/${filePath}`;
      const url = `${this.API_BASE}/resources/upload?path=${encodeURIComponent(fullPath)}&overwrite=${overwrite}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      });

      return await this.handleResponse<CloudUploadUrlResponse>(response);
    });
  }

  // Upload file content to Yandex Disk
  async uploadFile(uploadUrl: string, fileContent: string): Promise<void> {
    if (!this.accessToken) {
      throw new CloudAuthError('Access token not set');
    }

    return await this.executeWithRetry(async () => {
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `OAuth ${this.accessToken}`,
          'Content-Type': 'text/plain'
        },
        body: fileContent
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new CloudAuthError('Authentication failed');
        }

        if (response.status >= 500) {
          throw new CloudNetworkError(`Server error: ${response.status}`);
        }

        throw new CloudError(`HTTP error! status: ${response.status}`, `HTTP_${response.status}`);
      }
    });
  }

  // Upload a file in one step (get URL + upload)
  async uploadFileAtPath(filePath: string, fileContent: string, overwrite: boolean = true): Promise<void> {
    const uploadInfo = await this.getUploadUrl(filePath, overwrite);
    await this.uploadFile(uploadInfo.href, fileContent);
  }

  // Check if we're authenticated
  isAuthenticated(): boolean {
    return !!this.accessToken;
  }
}

// Export singleton instance
export const cloudService = new CloudService();

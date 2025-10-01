import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import {
  isAuthenticated,
  setAuthenticationStatus,
  logout,
  checkAuthStatus
} from '../stores/cloudStore';

// Mock browser environment
vi.mock('$app/environment', () => ({
  browser: true
}));

// Mock fetch for API calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('CloudStore Authentication', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Reset the isAuthenticated store
    setAuthenticationStatus(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isAuthenticated Store', () => {
    it('should initialize with false value', () => {
      expect(get(isAuthenticated)).toBe(false);
    });

    it('should update when setAuthenticationStatus is called', () => {
      setAuthenticationStatus(true);
      expect(get(isAuthenticated)).toBe(true);

      setAuthenticationStatus(false);
      expect(get(isAuthenticated)).toBe(false);
    });
  });

  describe('setAuthenticationStatus Function', () => {
    it('should update the isAuthenticated store value', () => {
      expect(get(isAuthenticated)).toBe(false);

      setAuthenticationStatus(true);
      expect(get(isAuthenticated)).toBe(true);

      setAuthenticationStatus(false);
      expect(get(isAuthenticated)).toBe(false);
    });
  });

  describe('checkAuthStatus Function', () => {
    it('should set isAuthenticated to true when API returns authenticated', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          authenticated: true,
          username: 'testuser'
        })
      });

      const result = await checkAuthStatus();

      expect(result).toBe(true);
      expect(get(isAuthenticated)).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/status');
    });

    it('should set isAuthenticated to false when API returns not authenticated', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          authenticated: false,
          username: null
        })
      });

      const result = await checkAuthStatus();

      expect(result).toBe(false);
      expect(get(isAuthenticated)).toBe(false);
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/status');
    });

    it('should set isAuthenticated to false when API call fails', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await checkAuthStatus();

      expect(result).toBe(false);
      expect(get(isAuthenticated)).toBe(false);
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/status');
    });
  });

  describe('logout Function', () => {
    it('should call logout API and update isAuthenticated store', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          message: 'Logout successful'
        })
      });

      // Set authenticated state first
      setAuthenticationStatus(true);
      expect(get(isAuthenticated)).toBe(true);

      await logout();

      expect(get(isAuthenticated)).toBe(false);
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      });
    });

    it('should handle logout API errors gracefully', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: vi.fn().mockResolvedValue({
          message: 'Logout failed'
        })
      });

      // Set authenticated state first
      setAuthenticationStatus(true);
      expect(get(isAuthenticated)).toBe(true);

      await logout();

      // Authentication status should remain true when API fails
      expect(get(isAuthenticated)).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      });
    });

    it('should handle network errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      // Set authenticated state first
      setAuthenticationStatus(true);
      expect(get(isAuthenticated)).toBe(true);

      await logout();

      // Authentication status should remain true when API fails
      expect(get(isAuthenticated)).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      });
    });
  });
});

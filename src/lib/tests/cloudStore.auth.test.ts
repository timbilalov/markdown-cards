import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import {
  isAuthenticated,
  setAuthenticationStatus,
  logout,
  checkIsSessionAuthenticated
} from '../stores/cloudStore';

// Mock browser environment
vi.mock('$app/environment', () => ({
  browser: true
}));

// Mock fetch for API calls
const mockFetch = vi.fn();

describe('CloudStore Authentication', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', mockFetch);

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

  describe('checkIsSessionAuthenticated Function', () => {
    it('does not cancel delivery when the same authenticated session is confirmed again', async () => {
      setAuthenticationStatus(true);
      const session = await import('../stores/sessionState');
      const signal = session.sessionDeliverySignal(); const generation = session.sessionGeneration();
      mockFetch.mockResolvedValue(Response.json({ authenticated: true }));
      expect(await checkIsSessionAuthenticated()).toBe(true);
      expect(signal.aborted).toBe(false);
      expect(session.sessionDeliverySignal()).toBe(signal);
      expect(session.sessionGeneration()).toBe(generation);
    });

    it('does not restore a session from a status response received after logout', async () => {
      const pending = Promise.withResolvers<Response>();
      mockFetch.mockReturnValueOnce(pending.promise);
      setAuthenticationStatus(true);
      const checking = checkIsSessionAuthenticated();
      mockFetch.mockResolvedValueOnce(Response.json({ success: true }));
      await logout();
      pending.resolve(Response.json({ authenticated: true }));
      expect(await checking).toBe(false);
      expect(get(isAuthenticated)).toBe(false);
    });

    it.each([Response.json({ authenticated: 'true' }), Response.json({ authenticated: true }, { status: 503 })])(
      'requires a successful response with a boolean session confirmation', async response => {
        mockFetch.mockResolvedValue(response);
        expect(await checkIsSessionAuthenticated()).toBe(false);
        expect(get(isAuthenticated)).toBe(false);
      }
    );
    it('should set isAuthenticated to true when API returns authenticated', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          authenticated: true,
          username: 'testuser'
        })
      });

      const result = await checkIsSessionAuthenticated();

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

      const result = await checkIsSessionAuthenticated();

      expect(result).toBe(false);
      expect(get(isAuthenticated)).toBe(false);
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/status');
    });

    it('should set isAuthenticated to false when API call fails', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await checkIsSessionAuthenticated();

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

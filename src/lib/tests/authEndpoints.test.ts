import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST as loginPOST } from '../../routes/api/auth/login/+server';
import { GET as statusGET } from '../../routes/api/auth/status/+server';
import { POST as logoutPOST } from '../../routes/api/auth/logout/+server';
import { GET as userGET } from '../../routes/api/auth/user/+server';
import * as auth from '../../lib/server/auth';
import type { RequestEvent } from '@sveltejs/kit';

// Mock the auth module
vi.mock('../../lib/server/auth', () => {
  return {
    validateCredentials: vi.fn()
  };
});

// Mock logger
vi.mock('../../lib/utils/logger', () => {
  return {
    default: {
      info: vi.fn(),
      error: vi.fn()
    }
  };
});

describe('Authentication Endpoints', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Login Endpoint', () => {
    it('should return 400 for missing username or password', async () => {
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: 'testuser'
          // Missing password
        })
      });

      const event = {
        request,
        cookies: {
          set: vi.fn()
        }
      } as unknown as RequestEvent;

      const response = await loginPOST(event);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.message).toBe('Username and password are required.');
    });

    it('should return 401 for invalid credentials', async () => {
      // Mock invalid credentials
      vi.mocked(auth.validateCredentials).mockResolvedValue(false);

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: 'testuser',
          password: 'wrongpassword'
        })
      });

      const event = {
        request,
        cookies: {
          set: vi.fn()
        }
      } as unknown as RequestEvent;

      const response = await loginPOST(event);
      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.message).toBe('Invalid username or password.');
    });

    it('should return 200 and set cookies for valid credentials', async () => {
      // Mock valid credentials
      vi.mocked(auth.validateCredentials).mockResolvedValue(true);

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: 'testuser',
          password: 'correctpassword',
          rememberMe: true
        })
      });

      const cookiesSet = vi.fn();
      const event = {
        request,
        cookies: {
          set: cookiesSet
        }
      } as unknown as RequestEvent;

      const response = await loginPOST(event);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.message).toBe('Login successful');
      expect(data.user.username).toBe('testuser');

      // Check that cookies were set
      expect(cookiesSet).toHaveBeenCalledTimes(2);
      expect(cookiesSet).toHaveBeenCalledWith('auth_token', 'testuser', expect.any(Object));
      expect(cookiesSet).toHaveBeenCalledWith('csrf_token', expect.any(String), expect.any(Object));
    });

    it('should return 500 for unexpected errors', async () => {
      // Mock an unexpected error
      vi.mocked(auth.validateCredentials).mockRejectedValue(new Error('Database error'));

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: 'testuser',
          password: 'anypassword'
        })
      });

      const event = {
        request,
        cookies: {
          set: vi.fn()
        }
      } as unknown as RequestEvent;

      const response = await loginPOST(event);
      expect(response.status).toBe(500);

      const data = await response.json();
      expect(data.message).toBe('An unexpected error occurred during login.');
    });
  });

  describe('Status Endpoint', () => {
    it('should return authenticated false when no auth token cookie', async () => {
      const event = {
        cookies: {
          get: vi.fn().mockReturnValue(undefined)
        }
      } as unknown as RequestEvent;

      const response = await statusGET(event);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.authenticated).toBe(false);
      expect(data.username).toBeNull();
    });

    it('should return authenticated true when auth token cookie exists', async () => {
      const event = {
        cookies: {
          get: vi.fn().mockReturnValue('testuser')
        }
      } as unknown as RequestEvent;

      const response = await statusGET(event);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.authenticated).toBe(true);
      expect(data.username).toBe('testuser');
    });
  });

  describe('Logout Endpoint', () => {
    it('should delete auth and csrf cookies and return success', async () => {
      const cookiesDelete = vi.fn();
      const event = {
        cookies: {
          get: vi.fn().mockReturnValue('testuser'),
          delete: cookiesDelete
        },
        request: new Request('http://localhost/api/auth/logout', {
          method: 'POST'
        })
      } as unknown as RequestEvent;

      const response = await logoutPOST(event);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.message).toBe('Logout successful');

      // Check that cookies were deleted
      expect(cookiesDelete).toHaveBeenCalledTimes(2);
      expect(cookiesDelete).toHaveBeenCalledWith('auth_token', expect.any(Object));
      expect(cookiesDelete).toHaveBeenCalledWith('csrf_token', expect.any(Object));
    });

    it('should handle logout errors gracefully', async () => {
      const cookiesDelete = vi.fn().mockImplementation(() => {
        throw new Error('Cookie error');
      });
      const event = {
        cookies: {
          get: vi.fn().mockReturnValue('testuser'),
          delete: cookiesDelete
        },
        request: new Request('http://localhost/api/auth/logout', {
          method: 'POST'
        })
      } as unknown as RequestEvent;

      const response = await logoutPOST(event);
      expect(response.status).toBe(500);

      const data = await response.json();
      expect(data.message).toBe('An unexpected error occurred during logout.');
    });
  });

  describe('User Endpoint', () => {
    it('should return 401 when no auth token cookie', async () => {
      const event = {
        cookies: {
          get: vi.fn().mockReturnValue(undefined)
        }
      } as unknown as RequestEvent;

      const response = await userGET(event);
      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error).toBe('Not authenticated');
    });

    it('should return user data when auth token cookie exists', async () => {
      const event = {
        cookies: {
          get: vi.fn().mockReturnValue('testuser')
        }
      } as unknown as RequestEvent;

      const response = await userGET(event);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.username).toBe('testuser');
    });

    it('should handle user data errors gracefully', async () => {
      const event = {
        cookies: {
          get: vi.fn().mockImplementation(() => {
            throw new Error('Cookie parse error');
          })
        }
      } as unknown as RequestEvent;

      const response = await userGET(event);
      expect(response.status).toBe(500);

      const data = await response.json();
      expect(data.error).toBe('Internal server error');
    });
  });
});

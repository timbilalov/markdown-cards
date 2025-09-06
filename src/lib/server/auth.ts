import bcrypt from 'bcryptjs';
import { ADMIN_USERNAME, ADMIN_PASSWORD_HASH } from '$lib/utils/envLoader';
import logger from '$lib/utils/logger';

/**
 * Validates user credentials
 * @param username - The username to validate
 * @param password - The password to validate
 * @returns True if credentials are valid, false otherwise
 */
export async function validateCredentials(username: string, password: string): Promise<boolean> {
	// Validate credentials
	if (!ADMIN_USERNAME || !ADMIN_PASSWORD_HASH) {
		logger.error('Admin credentials not configured');
		return false;
	}

	const isUsernameValid = username === ADMIN_USERNAME;

	try {
		const isPasswordValid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
		return isUsernameValid && isPasswordValid;
	} catch (error) {
		logger.error('Error during password validation', { error });
		return false;
	}
}

/**
 * Hashes a password using bcrypt
 * @param password - The plain text password to hash
 * @param saltRounds - The number of salt rounds (default: 12)
 * @returns The hashed password
 */
export async function hashPassword(password: string, saltRounds: number = 12): Promise<string> {
	return await bcrypt.hash(password, saltRounds);
}

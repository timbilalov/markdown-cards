import bcrypt from 'bcryptjs';
import { env } from '$env/dynamic/private';
import logger from '$lib/utils/logger';

/**
 * Validates user credentials
 * @param username - The username to validate
 * @param password - The password to validate
 * @returns True if credentials are valid, false otherwise
 */
export async function validateCredentials(username: string, password: string): Promise<boolean> {
	const { ADMIN_USERNAME, ADMIN_PASSWORD_HASH } = env;
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

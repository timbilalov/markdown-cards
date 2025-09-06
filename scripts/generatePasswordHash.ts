import { hashPassword } from '../src/lib/server/auth';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

// Load environment variables
dotenv.config();

// Generate a random password
function generateRandomPassword(length: number): string {
	const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()';
	let password = '';
	for (let i = 0; i < length; i++) {
		const randomIndex = Math.floor(Math.random() * charset.length);
		password += charset[randomIndex];
	}
	return password;
}

async function generatePasswordHash() {
	// Get password from command line arguments or generate a random one
	const password = process.argv[2] || generateRandomPassword(16);

	// Hash the password
	const hashedPassword = await hashPassword(password);

	// Output the results
	console.log('Password:', password);
	console.log('Hashed Password:', hashedPassword);

	// Create or update .env file with the hashed password
	const envContent = `ADMIN_USERNAME=admin\nADMIN_PASSWORD_HASH=${hashedPassword}\n`;

	// Check if .env file exists
	if (fs.existsSync('.env')) {
		// Append to existing file
		fs.appendFileSync('.env', `\n${envContent}`);
		console.log('.env file updated with admin credentials');
	} else {
		// Create new .env file
		fs.writeFileSync('.env', envContent);
		console.log('.env file created with admin credentials');
	}

	console.log('\nTo use these credentials:');
	console.log('1. Username: admin');
	console.log('2. Password:', password);
	console.log('3. The hashed password has been saved to your .env file');
}

generatePasswordHash().catch(console.error);

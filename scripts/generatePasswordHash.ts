import { randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';

// Print configuration for the operator to install locally or in deployment env.
// Never load or mutate an existing .env, and never accept a password in shell history.
const password = randomBytes(24).toString('base64url');
const passwordHash = await hash(password, 12);
console.log(`Password: ${password}`);
console.log('ADMIN_USERNAME=admin');
console.log(`ADMIN_PASSWORD_HASH=${passwordHash}`);
// Vite expands $NAME in .env values; deployment environment values stay raw.
console.log(`Local .env: ADMIN_PASSWORD_HASH=${passwordHash.replaceAll('$', '\\$')}`);

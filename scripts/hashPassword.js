import bcrypt from 'bcryptjs';

async function hashPassword(password, saltRounds = 12) {
  return await bcrypt.hash(password, saltRounds);
}

// Generate a random password
function generateRandomPassword(length) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()';
  let password = '';
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * charset.length);
    password += charset[randomIndex];
  }
  return password;
}

async function main() {
  // Get password from command line arguments or generate a random one
  const password = process.argv[2] || generateRandomPassword(16);

  // Hash the password
  const hashedPassword = await hashPassword(password);

  // Output the results
  console.log('Password:', password);
  console.log('Hashed Password:', hashedPassword);
}

main().catch(console.error);

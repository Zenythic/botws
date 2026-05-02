import 'dotenv/config';
import { createEsmeraldaClient } from './index.js';

async function main() {
  const username = process.argv[2];
  const newPassword = process.argv[3];
  const logoutAllArg = process.argv[4] || '0';

  if (!username || !newPassword) {
    throw new Error(
      'Uso: npm run esmeralda:change-password -- <username> <newPassword> [logoutAll]',
    );
  }

  const logoutAll = ['1', 'true', 'si', 'yes'].includes(
    String(logoutAllArg).trim().toLowerCase(),
  );

  const client = createEsmeraldaClient();
  const result = await client.changePassword({
    username,
    newPassword,
    logoutAll,
  });

  console.log('Password cambiada OK');
  console.log(`username: ${result.username}`);
  console.log(`destinationId: ${result.destinationId}`);
  console.log(`status: ${result.status}`);
  console.log(`logoutAll: ${result.logoutAll ? '1' : '0'}`);
}

main().catch((error) => {
  console.error('Fallo cambiando password en Esmeralda');
  console.error(error);
  process.exit(1);
});

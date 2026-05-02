import 'dotenv/config';
import { createEsmeraldaClient, getEsmeraldaDbPath } from './index.js';

async function main() {
  const username = process.argv[2];
  const reason = process.argv[3] || '';

  if (!username) {
    throw new Error('Uso: npm run esmeralda:lock-user -- <username> [reason]');
  }

  const client = createEsmeraldaClient();
  const result = await client.lockUser({ username, reason });

  console.log('Usuario bloqueado OK');
  console.log(`username: ${result.username}`);
  console.log(`destinationId: ${result.destinationId}`);
  console.log(`status: ${result.status}`);
  console.log(`reason: ${result.reason || 'sin-motivo'}`);
  console.log(`dbPath: ${getEsmeraldaDbPath()}`);
}

main().catch((error) => {
  console.error('Fallo bloqueando usuario en Esmeralda');
  console.error(error);
  process.exit(1);
});

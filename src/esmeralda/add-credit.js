import 'dotenv/config';
import { createEsmeraldaClient, getEsmeraldaDbPath } from './index.js';

async function main() {
  const username = process.argv[2];
  const amount = process.argv[3];

  if (!username || !amount) {
    throw new Error('Uso: npm run esmeralda:add-credit -- <username> <amount>');
  }

  const client = createEsmeraldaClient();
  const result = await client.addCredit({ username, amount });

  console.log('Saldo agregado OK');
  console.log(`username: ${result.username}`);
  console.log(`destinationId: ${result.destinationId}`);
  console.log(`amount: ${result.amount}`);
  console.log(`status: ${result.status}`);
  console.log(`balanceText: ${result.updatedUser?.balance_text || 'desconocido'}`);
  console.log(`dbPath: ${getEsmeraldaDbPath()}`);
}

main().catch((error) => {
  console.error('Fallo agregando saldo en Esmeralda');
  console.error(error);
  process.exit(1);
});

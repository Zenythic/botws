import 'dotenv/config';
import { createEsmeraldaClient, getEsmeraldaDbPath } from './index.js';

async function main() {
  const username = process.argv[2];
  const password = process.argv[3];

  if (!username || !password) {
    throw new Error('Uso: npm run esmeralda:create-user -- <username> <password>');
  }

  const client = createEsmeraldaClient();
  const result = await client.createUser({ username, password });

  console.log('Usuario creado OK');
  console.log(`username: ${result.username}`);
  console.log(`status: ${result.status}`);
  console.log(`dbPath: ${getEsmeraldaDbPath()}`);
  console.log(`remoteUserId: ${result.createdUser?.remote_user_id || 'no-encontrado'}`);
}

main().catch((error) => {
  console.error('Fallo creando usuario en Esmeralda');
  console.error(error);
  process.exit(1);
});

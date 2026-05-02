import 'dotenv/config';
import { createEsmeraldaClient, getEsmeraldaDbPath } from './index.js';

async function main() {
  const client = createEsmeraldaClient();
  const authResult = await client.ensureActiveSession();
  const syncResult = await client.syncUsersToDatabase();

  console.log('Usuarios sincronizados OK');
  console.log(`reusedSession: ${Boolean(authResult.reused)}`);
  if (authResult.loginStatus) {
    console.log(`loginStatus: ${authResult.loginStatus}`);
  }
  if (authResult.usersStatus) {
    console.log(`usersStatus: ${authResult.usersStatus}`);
  }
  console.log(`pagesFetched: ${syncResult.pagesFetched}`);
  console.log(`totalUsers: ${syncResult.totalUsers}`);
  console.log(`dbPath: ${getEsmeraldaDbPath()}`);
}

main().catch((error) => {
  console.error('Fallo sincronizando usuarios de Esmeralda');
  console.error(error);
  process.exit(1);
});

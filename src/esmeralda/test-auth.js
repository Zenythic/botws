import 'dotenv/config';
import { createEsmeraldaClient } from './index.js';

function maskValue(value, visible = 6) {
  if (!value) {
    return value;
  }

  if (value.length <= visible * 2) {
    return value;
  }

  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

async function main() {
  const client = createEsmeraldaClient();
  const result = await client.ensureActiveSession();

  console.log('Autenticacion OK');
  console.log(`reusedSession: ${Boolean(result.reused)}`);
  if (result.loginStatus) {
    console.log(`loginStatus: ${result.loginStatus}`);
  }
  if (result.usersStatus) {
    console.log(`usersStatus: ${result.usersStatus}`);
  }
  console.log(`phpSessionId: ${maskValue(result.phpSessionId)}`);
  if (result.loginToken) {
    console.log(`loginToken: ${maskValue(result.loginToken)}`);
  }
  console.log(`sessionToken: ${maskValue(result.sessionToken)}`);
  console.log(`roomId: ${result.roomId}`);
}

main().catch((error) => {
  console.error('Fallo autenticando con Esmeralda');
  console.error(error);
  process.exit(1);
});

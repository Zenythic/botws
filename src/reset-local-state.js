import 'dotenv/config';
import { runLocalStateReset } from './reset-state.js';

const args = new Set(process.argv.slice(2));
const includeAuth = args.has('--with-auth');

async function main() {
  const result = await runLocalStateReset({ includeAuth });

  console.log('Reset local completado.');
  for (const line of result.results) {
    console.log(`- ${line}`);
  }

  if (!includeAuth) {
    console.log('- La sesion de WhatsApp se conservo.');
    console.log('  Si tambien quieres desvincular y arrancar totalmente de cero, usa: npm run state:reset:all');
  }
}

main().catch((error) => {
  console.error('Fallo reseteando el estado local');
  console.error(error);
  process.exitCode = 1;
});

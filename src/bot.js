import { pathToFileURL } from 'node:url';
import { startBot } from './whatsapp/index.js';

export { startBot } from './whatsapp/index.js';

async function main() {
  await startBot();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

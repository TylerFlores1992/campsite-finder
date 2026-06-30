import ngrok from '@ngrok/ngrok';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Read NEXT_PUBLIC_APP_URL from .env.local so we can update it
const envPath = resolve(process.cwd(), '.env.local');
let envContent = readFileSync(envPath, 'utf8');

const authtoken = '3FroWghlLFg347futU7RCsPjJWB_4CEJodWx9ZEuqy26HDrvT';

console.log('Starting ngrok tunnel on port 3000...');

const listener = await ngrok.forward({
  addr: 3000,
  authtoken,
});

const url = listener.url();
console.log(`\n✅ Tunnel URL: ${url}`);
console.log(`\nWebhook endpoint: ${url}/api/webhooks/campflare`);

// Update NEXT_PUBLIC_APP_URL in .env.local
if (envContent.includes('NEXT_PUBLIC_APP_URL=')) {
  envContent = envContent.replace(/NEXT_PUBLIC_APP_URL=.*/, `NEXT_PUBLIC_APP_URL=${url}`);
} else {
  envContent += `\nNEXT_PUBLIC_APP_URL=${url}\n`;
}
const { writeFileSync } = await import('fs');
writeFileSync(envPath, envContent);
console.log(`\n✅ .env.local updated with NEXT_PUBLIC_APP_URL=${url}`);
console.log('\nKeep this running while testing webhooks. Ctrl+C to stop.\n');

// Keep alive
process.on('SIGINT', async () => {
  console.log('\nClosing tunnel...');
  await ngrok.disconnect();
  process.exit(0);
});

import { fileURLToPath } from 'node:url';
import { RpcClient, type RpcClientOptions } from '@earendil-works/pi-coding-agent';

const options: RpcClientOptions = {
  cwd: process.cwd(),
  cliPath: fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')).replace(/index\.js$/, 'cli.js'),
  args: ['--no-extensions'],
} as RpcClientOptions;

const client = new RpcClient(options);
client.onEvent((event: any) => {
  if (event?.type === 'message_update') {
    const inner = event.assistantMessageEvent;
    if (inner?.type === 'text_delta') {
      console.log(JSON.stringify({ delta: inner.delta, len: inner.delta?.length }));
    } else if (inner?.type) {
      console.log('EVENT', inner.type);
    }
  }
});

await client.start();
const state = await client.getState();
console.log('STATE', state?.sessionId, state?.sessionFile);
await client.prompt('只回复两个字：你好');
// wait for settle
await new Promise<void>((resolve) => {
  const off = client.onEvent((event: any) => {
    if (event?.type === 'agent_settled') {
      off();
      resolve();
    }
  });
  setTimeout(resolve, 120_000);
});
console.log('SETTLED, closing');
await client.stop();
process.exit(0);

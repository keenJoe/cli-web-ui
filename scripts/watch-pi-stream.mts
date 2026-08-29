import { WebSocket } from 'ws';

const SESSION_ID = process.argv[2];
if (!SESSION_ID) {
  console.error('usage: tsx watch-pi.mts <app-session-id>');
  process.exit(1);
}

const token = process.argv[3];
const ws = new WebSocket(`ws://localhost:3002/ws?token=${encodeURIComponent(token)}`);

const streamDeltas: string[] = [];
let thinkingCount = 0;

ws.on('open', () => {
  console.log('OPEN');
  ws.send(JSON.stringify({
    type: 'chat.subscribe',
    sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }],
  }));
});

ws.on('message', (raw: Buffer) => {
  let msg: any;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.kind === 'stream_delta') {
    streamDeltas.push(String(msg.content || ''));
  } else if (msg.kind === 'thinking') {
    thinkingCount += 1;
  }
  if (msg.kind === 'complete') {
    console.log('COMPLETE');
    console.log('DELTA COUNT:', streamDeltas.length);
    console.log('DELTAS JSON:', JSON.stringify(streamDeltas));
    console.log('THINKING COUNT:', thinkingCount);
    process.exit(0);
  }
});

setTimeout(() => {
  console.log('TIMEOUT');
  console.log('DELTA COUNT:', streamDeltas.length);
  console.log('DELTAS JSON:', JSON.stringify(streamDeltas));
  process.exit(1);
}, 180_000);

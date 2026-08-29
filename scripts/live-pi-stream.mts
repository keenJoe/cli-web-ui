import { WebSocket } from 'ws';

const SESSION_ID = '01a04cd6-7191-7faf-9169-9a989adbaddb';
const token = process.argv[2];
const ws = new WebSocket(`ws://localhost:3002/ws?token=${encodeURIComponent(token)}`);

const streamDeltas: string[] = [];
const kinds: string[] = [];

ws.on('open', () => {
  console.log('OPEN');
  ws.send(JSON.stringify({
    type: 'chat.subscribe',
    sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }],
  }));
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      provider: 'pi',
      message: '只回复两个字：你好',
    }));
    console.log('SENT');
  }, 500);
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
  } else {
    kinds.push(msg.kind || msg.type);
  }
  if (msg.kind === 'complete') {
    console.log('COMPLETE');
    console.log('DELTA COUNT:', streamDeltas.length);
    console.log('DELTAS:', JSON.stringify(streamDeltas));
    console.log('KINDS:', kinds.join(','));
    process.exit(0);
  }
});

setTimeout(() => {
  console.log('TIMEOUT');
  console.log('DELTA COUNT:', streamDeltas.length);
  console.log('DELTAS:', JSON.stringify(streamDeltas));
  console.log('KINDS:', kinds.join(','));
  process.exit(1);
}, 180_000);

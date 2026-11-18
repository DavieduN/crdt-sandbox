const http = require('http');
const WebSocket = require('ws');
const { setupWSConnection } = require('y-websocket/bin/utils');

const PORT = process.env.PORT || 1234;
const HOST = process.env.HOST || '0.0.0.0';

// Servidor HTTP mínimo apenas para o handshake de upgrade do WebSocket e healthcheck
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('CRDT Sandbox - Yjs WebSocket Signaling/Relay Server Online\n');
});

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
  // Retransmite exclusivamente os vetores de estado binários do Yjs em memória,
  // sem banco de dados e sem fazer parse de JSON.
  setupWSConnection(ws, req, { gc: true });
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[CRDT Relay] Servidor y-websocket escutando em ws://${HOST}:${PORT}`);
});

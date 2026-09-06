#!/usr/bin/env node
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { initDb } from './lib/db.mjs';
import { tools, handleTool } from './lib/mcp-tools.mjs';

const DB_PATH = process.env.COREAD_DB || path.join(process.cwd(), 'data', 'coread.db');
const PORT = parseInt(process.env.COREAD_MCP_PORT || '3001');
const HOST = process.env.COREAD_MCP_HOST || '127.0.0.1';
initDb(DB_PATH);

const sessions = new Map();

function handleJsonRpc(msg) {
  if (msg.method === 'initialize') {
    return { jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'coread', version: '0.1.0' },
    }};
  } else if (msg.method === 'notifications/initialized') {
    return null;
  } else if (msg.method === 'tools/list') {
    return { jsonrpc: '2.0', id: msg.id, result: { tools } };
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    try {
      const result = handleTool(name, args || {});
      return { jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }};
    } catch (e) {
      return { jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: `Error: ${e.message}` }],
        isError: true,
      }};
    }
  } else if (msg.id !== undefined) {
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
  }
  return null;
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // SSE endpoint
  if (req.method === 'GET' && url.pathname === '/sse') {
    const sessionId = crypto.randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    });

    sessions.set(sessionId, res);
    res.on('close', () => sessions.delete(sessionId));

    res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
    return;
  }

  // Message endpoint
  if (req.method === 'POST' && url.pathname === '/messages') {
    const sessionId = url.searchParams.get('sessionId');
    const sseRes = sessions.get(sessionId);
    if (!sseRes) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired session' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        const response = handleJsonRpc(msg);
        res.writeHead(202);
        res.end();
        if (response) {
          sseWrite(sseRes, 'message', response);
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Streamable HTTP endpoint (POST /mcp)
  if (req.method === 'POST' && url.pathname === '/mcp') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        const response = handleJsonRpc(msg);
        if (response) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } else {
          res.writeHead(202);
          res.end();
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`\n  📚 coread MCP server (SSE + Streamable HTTP)`);
  console.log(`  🔗 SSE:              http://${HOST}:${PORT}/sse`);
  console.log(`  🔗 Streamable HTTP:  http://${HOST}:${PORT}/mcp`);
  console.log(`  📂 Database: ${DB_PATH}\n`);
});

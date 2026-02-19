import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import { TunnelRegistry } from './registry';
import { setupWebSocketHandler } from './wsHandler';
import { createProxyMiddleware, createPathBasedProxy } from './proxy';

// ─── Configuration ────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8080', 10);
const DOMAIN = process.env.DOMAIN || 'localhosted-tunnel-server-production.up.railway.app';
const NODE_ENV = process.env.NODE_ENV || 'development';

// ─── Initialise ───────────────────────────────────────────────
const registry = new TunnelRegistry();
const app = express();

// ─── Security & CORS ──────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false, // Tunnelled content is user-generated
    crossOriginEmbedderPolicy: false,
}));
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: '*',
    exposedHeaders: ['X-Powered-By', 'X-Tunnel-Subdomain'],
}));

// ─── Health & Stats Endpoints ─────────────────────────────────
// These fire BEFORE the proxy middleware so they always respond
// even when the request arrives on the root domain.

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        domain: DOMAIN,
        env: NODE_ENV,
        timestamp: new Date().toISOString(),
    });
});

app.get('/stats', (_req, res) => {
    const stats = registry.getStats();
    res.json({
        ...stats,
        domain: DOMAIN,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
    });
});

// Landing page for the root domain
app.get('/', (req, res, next) => {
    const host = req.headers.host || '';
    const hostWithoutPort = host.split(':')[0];

    // If this is a subdomain request, pass through to the proxy
    if (hostWithoutPort !== DOMAIN && hostWithoutPort !== 'localhost' && hostWithoutPort !== '127.0.0.1') {
        next();
        return;
    }

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LocalHosted — Tunnel Relay</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
            color: #fff;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
        }
        .container { max-width: 600px; padding: 2rem; }
        h1 { font-size: 2.8rem; margin-bottom: 0.5rem; }
        .highlight { color: #7c3aed; }
        p { color: #a5b4c8; font-size: 1.1rem; line-height: 1.6; margin-top: 1rem; }
        .badge {
            display: inline-block;
            background: rgba(124, 58, 237, 0.2);
            border: 1px solid rgba(124, 58, 237, 0.5);
            padding: 0.25rem 0.75rem;
            border-radius: 999px;
            font-size: 0.85rem;
            color: #c4b5fd;
            margin-top: 1.5rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Local<span class="highlight">Hosted</span></h1>
        <p>This is the tunnel relay server for <strong>LocalHosted</strong>.</p>
        <p>Expose your localhost to the internet with a single click from VS Code.</p>
        <div class="badge">Tunnel Relay Online ✓</div>
    </div>
</body>
</html>
    `.trim());
});

// ─── Proxy Middleware ─────────────────────────────────────────
// Path-based routing: /t/<subdomain>/... — works with Railway SSL
// This is the primary mode when using Railway's *.up.railway.app domain
app.all('/t/:subdomain/*path', createPathBasedProxy(registry));
app.all('/t/:subdomain', createPathBasedProxy(registry));

// Subdomain-based routing: <subdomain>.localhosted.live/...
// This kicks in when using a custom domain with wildcard DNS
app.use(createProxyMiddleware(registry, DOMAIN));

// ─── 404 Fallback ─────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({
        error: 'Not Found',
        message: 'This endpoint does not exist on the tunnel relay server.',
        domain: DOMAIN,
    });
});

// ─── Create HTTP + WebSocket Server ───────────────────────────
const server = http.createServer(app);

const wss = new WebSocketServer({
    server,
    path: '/tunnel',     // VS Code extension connects to wss://localhosted.live/tunnel
    maxPayload: 50 * 1024 * 1024,  // 50 MB max payload (large file uploads)
});

setupWebSocketHandler(wss, registry, DOMAIN);

// ─── Start Listening ──────────────────────────────────────────
server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║        🚀 LocalHosted Tunnel Relay           ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Domain:   ${DOMAIN.padEnd(33)}║`);
    console.log(`║  Port:     ${String(PORT).padEnd(33)}║`);
    console.log(`║  Env:      ${NODE_ENV.padEnd(33)}║`);
    console.log(`║  WS Path:  /tunnel${' '.repeat(26)}║`);
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log(`Health:  http://localhost:${PORT}/health`);
    console.log(`Stats:   http://localhost:${PORT}/stats`);
    console.log('');
});

// ─── Graceful Shutdown ────────────────────────────────────────
function shutdown(signal: string) {
    console.log(`\n[Server] Received ${signal}, shutting down gracefully...`);

    // Close all WebSocket connections
    wss.clients.forEach((ws) => {
        ws.close(1001, 'Server shutting down');
    });

    server.close(() => {
        console.log('[Server] HTTP server closed.');
        process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
        console.error('[Server] Forced shutdown after timeout.');
        process.exit(1);
    }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Unhandled Errors ─────────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('[Server] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('[Server] Unhandled rejection:', reason);
});

export default server;

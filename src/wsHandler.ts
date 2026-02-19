import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { TunnelRegistry, WSMessage } from './registry';

const PING_INTERVAL = 30000; // 30 seconds

/**
 * Handles WebSocket connections from VS Code extension clients.
 * Each connection represents one tunnel user.
 */
export function setupWebSocketHandler(wss: WebSocket.Server, registry: TunnelRegistry, domain: string): void {
    wss.on('connection', (ws: WebSocket, req) => {
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        console.log(`[WS] New connection from ${clientIp}`);

        // Extract subdomain hint from headers
        const requestedSubdomain = req.headers['x-subdomain'] as string | undefined;
        const localPort = parseInt(req.headers['x-local-port'] as string) || 3000;

        let registeredSubdomain: string | null = null;

        // Ping/pong to keep connection alive
        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, PING_INTERVAL);

        ws.on('message', (data: WebSocket.Data) => {
            try {
                const message: WSMessage = JSON.parse(data.toString());
                handleMessage(ws, message, requestedSubdomain, localPort);
            } catch (err) {
                console.error('[WS] Failed to parse message:', err);
                sendError(ws, 'Invalid message format');
            }
        });

        ws.on('close', (code, reason) => {
            console.log(`[WS] Connection closed: code=${code}, reason=${reason?.toString()}`);
            clearInterval(pingInterval);
            registry.removeByWs(ws);
        });

        ws.on('error', (err) => {
            console.error('[WS] WebSocket error:', err.message);
            clearInterval(pingInterval);
            registry.removeByWs(ws);
        });

        // Handle pong from client
        ws.on('pong', () => {
            // Connection is alive
        });
    });

    function handleMessage(
        ws: WebSocket,
        message: WSMessage,
        requestedSubdomain: string | undefined,
        localPort: number
    ): void {
        switch (message.type) {
            case 'register': {
                const subdomain = sanitizeSubdomain(
                    (message.subdomain as string) || requestedSubdomain || generateSubdomain()
                );

                const client = registry.register(subdomain, localPort, ws);

                const tunnelUrl = `https://${subdomain}.${domain}`;

                // Send tunnel-ready message to the client
                ws.send(JSON.stringify({
                    type: 'tunnel-ready',
                    url: tunnelUrl,
                    subdomain,
                    id: client.id,
                }));

                console.log(`[WS] Tunnel ready: ${tunnelUrl} → localhost:${localPort}`);
                break;
            }

            case 'response': {
                // Client is sending back a response for a proxied HTTP request
                const responseData = message.data as {
                    id: string;
                    statusCode: number;
                    headers: Record<string, string>;
                    body?: string;
                };

                if (responseData && responseData.id) {
                    registry.handleResponse(ws, responseData);
                }
                break;
            }

            case 'pong': {
                // Client responded to our ping — connection is alive
                break;
            }

            default:
                console.warn(`[WS] Unknown message type: ${message.type}`);
        }
    }
}

/**
 * Sanitize a subdomain to be URL-safe.
 */
function sanitizeSubdomain(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 63); // DNS label max 63 chars
}

/**
 * Generate a random human-readable subdomain.
 */
function generateSubdomain(): string {
    const adjectives = ['swift', 'bold', 'calm', 'dark', 'epic', 'fair', 'glad', 'keen', 'live', 'neat', 'pure', 'warm'];
    const nouns = ['app', 'code', 'dev', 'hub', 'lab', 'net', 'pro', 'run', 'web', 'api', 'bit', 'box'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const id = uuidv4().substring(0, 4);
    return `${adj}-${noun}-${id}`;
}

/**
 * Send an error message to a WebSocket client.
 */
function sendError(ws: WebSocket, message: string): void {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message }));
    }
}

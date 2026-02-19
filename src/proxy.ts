import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { TunnelRegistry, TunnelRequest } from './registry';

/**
 * Path-based proxy handler for /t/<subdomain>/...
 * Works with Railway's SSL cert since no wildcard subdomains are needed.
 * URL format: https://server.up.railway.app/t/swift-app-x8k2/api/hello
 */
export function createPathBasedProxy(registry: TunnelRegistry) {
    return async (req: Request, res: Response): Promise<void> => {
        const rawSubdomain = req.params.subdomain;
        const subdomain = Array.isArray(rawSubdomain) ? rawSubdomain[0] : rawSubdomain;

        if (!subdomain) {
            res.status(400).json({ error: 'Missing subdomain parameter' });
            return;
        }

        const client = registry.get(subdomain);
        if (!client) {
            res.status(502).json({
                error: 'Tunnel Not Found',
                message: `No active tunnel for "${subdomain}". The developer may have disconnected.`,
                subdomain,
            });
            return;
        }

        // Strip the /t/<subdomain> prefix to get the actual path
        const actualPath = req.params[0] ? `/${req.params[0]}` : '/';
        const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';

        const tunnelRequest: TunnelRequest = {
            id: uuidv4(),
            method: req.method,
            path: actualPath + queryString,
            headers: flattenHeaders(req.headers),
            body: await readBody(req),
        };

        console.log(`[Proxy] ${req.method} /t/${subdomain}${actualPath} → tunnel ${client.id}`);

        try {
            const tunnelResponse = await registry.forwardRequest(subdomain, tunnelRequest);

            for (const [key, value] of Object.entries(tunnelResponse.headers)) {
                if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
                    res.setHeader(key, value);
                }
            }

            res.setHeader('X-Powered-By', 'LocalHosted');
            res.setHeader('X-Tunnel-Subdomain', subdomain);

            res.status(tunnelResponse.statusCode);

            if (tunnelResponse.body) {
                const bodyBuffer = Buffer.from(tunnelResponse.body, 'base64');
                res.end(bodyBuffer);
            } else {
                res.end();
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            console.error(`[Proxy] Error forwarding to ${subdomain}:`, message);

            if (message.includes('timed out')) {
                res.status(504).json({ error: 'Gateway Timeout', message: 'Local server did not respond in time.', subdomain });
            } else if (message.includes('disconnected') || message.includes('not open')) {
                res.status(502).json({ error: 'Bad Gateway', message: 'Tunnel connection was lost.', subdomain });
            } else {
                res.status(502).json({ error: 'Bad Gateway', message: `Failed to proxy: ${message}`, subdomain });
            }
        }
    };
}

/**
 * Express middleware that intercepts HTTP requests on subdomains
 * and forwards them through the corresponding tunnel.
 *
 * How it works:
 * 1. Extract subdomain from the Host header (e.g., "swift-app-x8k2.localhosted.live")
 * 2. Look up the tunnel client registered for that subdomain
 * 3. Forward the request through the WebSocket tunnel
 * 4. Wait for the response from the user's localhost
 * 5. Send the response back to the original HTTP caller
 */
export function createProxyMiddleware(registry: TunnelRegistry, domain: string) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const host = req.headers.host || '';

        // Extract subdomain from host
        // e.g., "swift-app-x8k2.localhosted.live" → "swift-app-x8k2"
        const subdomain = extractSubdomain(host, domain);

        if (!subdomain) {
            // Not a subdomain request — pass through to normal routes
            next();
            return;
        }

        // Check if a tunnel exists for this subdomain
        const client = registry.get(subdomain);
        if (!client) {
            res.status(502).json({
                error: 'Tunnel Not Found',
                message: `No active tunnel for "${subdomain}.${domain}". The developer may have disconnected.`,
                subdomain,
            });
            return;
        }

        // Build the tunnel request
        const tunnelRequest: TunnelRequest = {
            id: uuidv4(),
            method: req.method,
            path: req.originalUrl || req.url,
            headers: flattenHeaders(req.headers),
            body: await readBody(req),
        };

        console.log(`[Proxy] ${req.method} ${subdomain}.${domain}${req.url} → tunnel ${client.id}`);

        try {
            // Forward through the tunnel and wait for response
            const tunnelResponse = await registry.forwardRequest(subdomain, tunnelRequest);

            // Set response headers
            for (const [key, value] of Object.entries(tunnelResponse.headers)) {
                // Skip hop-by-hop headers
                if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
                    res.setHeader(key, value);
                }
            }

            // Add CORS headers for convenience
            res.setHeader('X-Powered-By', 'LocalHosted');
            res.setHeader('X-Tunnel-Subdomain', subdomain);

            // Send the response
            res.status(tunnelResponse.statusCode);

            if (tunnelResponse.body) {
                const bodyBuffer = Buffer.from(tunnelResponse.body, 'base64');
                res.end(bodyBuffer);
            } else {
                res.end();
            }

        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            console.error(`[Proxy] Error forwarding to ${subdomain}:`, message);

            if (message.includes('timed out')) {
                res.status(504).json({
                    error: 'Gateway Timeout',
                    message: 'The developer\'s local server did not respond in time.',
                    subdomain,
                });
            } else if (message.includes('disconnected') || message.includes('not open')) {
                res.status(502).json({
                    error: 'Bad Gateway',
                    message: 'The tunnel connection was lost. The developer may have disconnected.',
                    subdomain,
                });
            } else {
                res.status(502).json({
                    error: 'Bad Gateway',
                    message: `Failed to proxy request: ${message}`,
                    subdomain,
                });
            }
        }
    };
}

/**
 * Extract subdomain from a host header.
 * "swift-app-x8k2.localhosted.live" → "swift-app-x8k2"
 * "localhosted.live" → null (no subdomain)
 */
function extractSubdomain(host: string, domain: string): string | null {
    // Remove port if present
    const hostWithoutPort = host.split(':')[0];

    // Check if this host is a subdomain of our domain
    if (!hostWithoutPort.endsWith(`.${domain}`)) {
        return null;
    }

    // Extract the subdomain part
    const subdomain = hostWithoutPort.slice(0, -(domain.length + 1));

    // Validate: must be non-empty and not contain dots (no nested subdomains)
    if (!subdomain || subdomain.includes('.')) {
        return null;
    }

    return subdomain;
}

/**
 * Read the request body as a base64 string.
 */
function readBody(req: Request): Promise<string | undefined> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];

        req.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (chunks.length === 0) {
                resolve(undefined);
            } else {
                resolve(Buffer.concat(chunks).toString('base64'));
            }
        });

        req.on('error', () => {
            resolve(undefined);
        });
    });
}

/**
 * Flatten Express headers (which can be string | string[]) to Record<string, string>.
 */
function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value) {
            result[key] = Array.isArray(value) ? value.join(', ') : value;
        }
    }
    return result;
}

/**
 * Hop-by-hop headers that should not be forwarded.
 */
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

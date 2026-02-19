import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';

/**
 * Represents a connected tunnel client (a VS Code extension user).
 */
export interface TunnelClient {
    /** Unique ID for this tunnel */
    id: string;
    /** The subdomain assigned (e.g., "swift-app-x8k2") */
    subdomain: string;
    /** The local port the user is tunneling */
    localPort: number;
    /** The WebSocket connection to the VS Code extension */
    ws: WebSocket;
    /** When the tunnel was created */
    connectedAt: Date;
    /** Number of requests proxied through this tunnel */
    requestCount: number;
    /** Pending HTTP requests waiting for responses from the client */
    pendingRequests: Map<string, {
        resolve: (response: TunnelResponse) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
    }>;
}

/**
 * A request to be forwarded through the tunnel to the client's localhost.
 */
export interface TunnelRequest {
    id: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: string; // base64-encoded
}

/**
 * A response from the client's localhost, forwarded back through the tunnel.
 */
export interface TunnelResponse {
    id: string;
    statusCode: number;
    headers: Record<string, string>;
    body?: string; // base64-encoded
}

/**
 * WebSocket message types.
 */
export interface WSMessage {
    type: 'register' | 'response' | 'pong' | 'error';
    [key: string]: unknown;
}

/**
 * Manages all active tunnel connections.
 * Maps subdomains → tunnel clients for fast lookup on incoming HTTP requests.
 */
export class TunnelRegistry {
    /** subdomain → TunnelClient */
    private tunnels: Map<string, TunnelClient> = new Map();

    /**
     * Register a new tunnel client.
     */
    register(subdomain: string, localPort: number, ws: WebSocket): TunnelClient {
        // If subdomain is already taken, disconnect the old one
        const existing = this.tunnels.get(subdomain);
        if (existing) {
            console.log(`[Registry] Subdomain "${subdomain}" already taken. Replacing.`);
            this.remove(subdomain);
        }

        const client: TunnelClient = {
            id: uuidv4(),
            subdomain,
            localPort,
            ws,
            connectedAt: new Date(),
            requestCount: 0,
            pendingRequests: new Map(),
        };

        this.tunnels.set(subdomain, client);
        console.log(`[Registry] Tunnel registered: ${subdomain} (id=${client.id})`);
        return client;
    }

    /**
     * Look up a tunnel client by subdomain.
     */
    get(subdomain: string): TunnelClient | undefined {
        return this.tunnels.get(subdomain);
    }

    /**
     * Remove a tunnel by subdomain.
     */
    remove(subdomain: string): void {
        const client = this.tunnels.get(subdomain);
        if (client) {
            // Reject all pending requests
            for (const [reqId, pending] of client.pendingRequests) {
                clearTimeout(pending.timeout);
                pending.reject(new Error('Tunnel disconnected'));
            }
            client.pendingRequests.clear();

            // Close WebSocket if still open
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.close(1000, 'Tunnel removed');
            }

            this.tunnels.delete(subdomain);
            console.log(`[Registry] Tunnel removed: ${subdomain}`);
        }
    }

    /**
     * Remove a tunnel by WebSocket reference (when connection drops).
     */
    removeByWs(ws: WebSocket): void {
        for (const [subdomain, client] of this.tunnels) {
            if (client.ws === ws) {
                this.remove(subdomain);
                return;
            }
        }
    }

    /**
     * Forward an HTTP request through a tunnel and wait for the response.
     */
    async forwardRequest(subdomain: string, request: TunnelRequest, timeoutMs: number = 30000): Promise<TunnelResponse> {
        const client = this.tunnels.get(subdomain);
        if (!client) {
            throw new Error(`No tunnel found for subdomain: ${subdomain}`);
        }

        if (client.ws.readyState !== WebSocket.OPEN) {
            this.remove(subdomain);
            throw new Error('Tunnel connection is not open');
        }

        return new Promise((resolve, reject) => {
            // Set up timeout
            const timeout = setTimeout(() => {
                client.pendingRequests.delete(request.id);
                reject(new Error('Request timed out — local server did not respond'));
            }, timeoutMs);

            // Store the pending request
            client.pendingRequests.set(request.id, { resolve, reject, timeout });

            // Send the request through the tunnel
            client.ws.send(JSON.stringify({
                type: 'request',
                data: request,
            }));

            client.requestCount++;
        });
    }

    /**
     * Handle a response coming back from a tunnel client.
     */
    handleResponse(ws: WebSocket, response: TunnelResponse): void {
        // Find which client this ws belongs to
        for (const [, client] of this.tunnels) {
            if (client.ws === ws) {
                const pending = client.pendingRequests.get(response.id);
                if (pending) {
                    clearTimeout(pending.timeout);
                    client.pendingRequests.delete(response.id);
                    pending.resolve(response);
                }
                return;
            }
        }
    }

    /**
     * Get stats about all active tunnels.
     */
    getStats(): {
        activeTunnels: number;
        tunnels: Array<{
            subdomain: string;
            localPort: number;
            connectedAt: Date;
            requestCount: number;
            pendingRequests: number;
        }>;
    } {
        const tunnels = Array.from(this.tunnels.values()).map(t => ({
            subdomain: t.subdomain,
            localPort: t.localPort,
            connectedAt: t.connectedAt,
            requestCount: t.requestCount,
            pendingRequests: t.pendingRequests.size,
        }));

        return {
            activeTunnels: this.tunnels.size,
            tunnels,
        };
    }
}

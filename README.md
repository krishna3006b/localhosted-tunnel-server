# LocalHosted — Tunnel Relay Server

The backend relay server that bridges HTTP requests on `*.localhosted.live` subdomains to developers' localhost through WebSocket tunnels.

## Architecture

```
Browser → https://abc-xyz.localhosted.live/api/hello
   ↓
Railway (this server)
   ↓ extracts subdomain "abc-xyz"
   ↓ finds WebSocket client for "abc-xyz"
   ↓ sends request through WebSocket
VS Code Extension (developer's machine)
   ↓ HttpProxy forwards to localhost:3000/api/hello
   ↓ sends response back through WebSocket
Railway
   ↓
Browser ← response
```

## Local Development

```bash
npm install
npm run dev        # Starts with ts-node
```

The server will start on `http://localhost:3000`. You can test it with:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/stats
```

## Build

```bash
npm run build      # Compiles TypeScript → dist/
npm start          # Runs compiled JS
```

## Environment Variables

| Variable   | Default             | Description                            |
|------------|---------------------|----------------------------------------|
| `PORT`     | `3000`              | Port to listen on (Railway sets this)  |
| `DOMAIN`   | `localhosted.live`  | Root domain for subdomain extraction   |
| `NODE_ENV` | `development`       | `production` in Railway                |

## Deploy to Railway

1. **Push this folder** to a GitHub repo (or use Railway CLI)
2. **Create a new Railway project** → Deploy from GitHub
3. **Set environment variables**:
   - `DOMAIN=localhosted.live`
   - `NODE_ENV=production`
4. Railway auto-detects the Dockerfile and deploys
5. **Add a custom domain** in Railway settings:
   - `localhosted.live` (root domain)
   - `*.localhosted.live` (wildcard — for tunnelled subdomains)

## DNS Configuration (Cloudflare or any DNS provider)

Point your domain's DNS to Railway:

| Type   | Name | Content                              | Proxy |
|--------|------|--------------------------------------|-------|
| CNAME  | `@`  | `<your-service>.up.railway.app`      | ✅ On  |
| CNAME  | `*`  | `<your-service>.up.railway.app`      | ✅ On  |

> **Important**: The wildcard `*` CNAME is essential — without it, subdomain tunnels won't resolve.

If using **Cloudflare**, make sure:
- SSL/TLS is set to **Full (strict)**
- The wildcard record has the **orange cloud** (proxied) enabled

## Endpoints

| Path      | Method | Description                 |
|-----------|--------|-----------------------------|
| `/`       | GET    | Landing page                |
| `/health` | GET    | Health check (for Railway)  |
| `/stats`  | GET    | Active tunnels & metrics    |
| `/tunnel` | WS     | WebSocket endpoint for tunnels |

## WebSocket Protocol

### Client → Server Messages

**Register:**
```json
{ "type": "register", "subdomain": "my-app" }
```

**Response (to forwarded request):**
```json
{
  "type": "response",
  "id": "<request-uuid>",
  "statusCode": 200,
  "headers": { "content-type": "application/json" },
  "body": "<base64-encoded-body>"
}
```

### Server → Client Messages

**Registered:**
```json
{
  "type": "registered",
  "subdomain": "my-app-x8k2",
  "url": "https://my-app-x8k2.localhosted.live"
}
```

**Request (forwarded from HTTP):**
```json
{
  "type": "request",
  "id": "<request-uuid>",
  "method": "GET",
  "path": "/api/hello",
  "headers": { ... },
  "body": "<base64-encoded-body>"
}
```

**Error:**
```json
{
  "type": "error",
  "message": "Subdomain already in use"
}
```

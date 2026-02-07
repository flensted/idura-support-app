# Idura Support API

A Claude-powered support agent that answers questions about Idura/Criipto products using RAG (Retrieval-Augmented Generation) from the official documentation.

## Features

- **REST API** for asking product questions
- **RAG-powered answers** using embeddings from [criipto/docs](https://github.com/criipto/docs)
- **Slack bot integration** for @mentions and DMs
- **Rate limiting** (20 requests/minute per IP)
- **Auto-rebuild** knowledge base via GitHub webhook

## API Endpoints

### Ask a Question

```bash
POST /api/ask
Content-Type: application/json

{
  "question": "How do I integrate Swedish BankID?"
}
```

**Response:**
```json
{
  "answer": "To integrate Swedish BankID...",
  "sources": [
    "https://docs.criipto.com/verify/e-ids/swedish-bankid"
  ]
}
```

### Health Check

```bash
GET /health
```

Returns server status and knowledge base info:
```json
{
  "status": "ok",
  "kb": {
    "initialized": true,
    "chunkCount": 540,
    "lastInitTime": "2026-02-07T10:00:00.000Z"
  },
  "slack": {
    "configured": true
  }
}
```

### Knowledge Base Stats

```bash
GET /api/kb/stats
```

### Manual KB Rebuild

```bash
POST /api/kb/rebuild
X-Admin-Key: your-admin-key
```

### GitHub Webhook (Auto-rebuild)

```bash
POST /api/webhook/github
```

Triggers KB rebuild when `criipto/docs` pushes to main.

### Slack Events

```bash
POST /api/slack/events
```

Handles Slack app_mention and message.im events.

## Local Development

### Prerequisites

- Node.js 20+
- npm

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/flensted/idura-support-app.git
   cd idura-support-app
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create environment variables:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   export VOYAGE_API_KEY=pa-...
   # Optional for Slack integration:
   export SLACK_BOT_TOKEN=xoxb-...
   export SLACK_SIGNING_SECRET=...
   # Optional for admin endpoints:
   export ADMIN_API_KEY=...
   export GITHUB_WEBHOOK_SECRET=...
   ```

4. Build and run:
   ```bash
   npm run build
   npm start
   ```

The server starts on port 3000 (or `PORT` env var).

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `VOYAGE_API_KEY` | Yes | Voyage AI API key for embeddings |
| `SLACK_BOT_TOKEN` | No | Slack bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | No | Slack app signing secret |
| `ADMIN_API_KEY` | No | Protect `/api/kb/rebuild` endpoint |
| `GITHUB_WEBHOOK_SECRET` | No | Verify GitHub webhook signatures |
| `PORT` | No | Server port (default: 3000) |

## Deploy to Railway

1. Push code to a GitHub repository

2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**

3. Select your repository

4. Add environment variables in the **Variables** tab:
   - `ANTHROPIC_API_KEY` (required)
   - `VOYAGE_API_KEY` (required)
   - `SLACK_BOT_TOKEN` (if using Slack)
   - `SLACK_SIGNING_SECRET` (if using Slack)

5. Railway auto-detects Node.js and runs:
   ```bash
   npm install
   npm run build
   npm start
   ```

6. Go to **Settings** → **Networking** → **Generate Domain** to get your public URL

## Slack Bot Setup

### 1. Create a Slack App

1. Go to https://api.slack.com/apps
2. Click **Create New App** → **From scratch**
3. Name it `Idura Support` and select your workspace

### 2. Add OAuth Scopes

1. Go to **OAuth & Permissions**
2. Under **Bot Token Scopes**, add:
   - `app_mentions:read`
   - `chat:write`
   - `im:history`
   - `im:read`
   - `im:write`

### 3. Enable Event Subscriptions

1. Go to **Event Subscriptions**
2. Toggle **Enable Events** to ON
3. Set Request URL:
   ```
   https://your-app.up.railway.app/api/slack/events
   ```
4. Under **Subscribe to bot events**, add:
   - `app_mention`
   - `message.im`
5. Click **Save Changes**

### 4. Install to Workspace

1. Go to **Install App**
2. Click **Install to Workspace**
3. Copy the **Bot User OAuth Token** (`xoxb-...`)

### 5. Get Signing Secret

1. Go to **Basic Information**
2. Copy the **Signing Secret**

### 6. Configure Railway

Add both tokens to Railway environment variables:
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`

### 7. Test

In Slack:
- Mention the bot: `@Idura Support How do I set up MitID?`
- Or DM the bot directly

## GitHub Webhook (Auto-rebuild KB)

To auto-rebuild the knowledge base when docs change:

1. Go to https://github.com/criipto/docs/settings/hooks (requires admin access)
2. Click **Add webhook**
3. Set:
   - **Payload URL:** `https://your-app.up.railway.app/api/webhook/github`
   - **Content type:** `application/json`
   - **Secret:** Generate a secret and add as `GITHUB_WEBHOOK_SECRET` in Railway
   - **Events:** Just the push event
4. Click **Add webhook**

The KB will rebuild automatically when docs are pushed to main/master.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Slack     │────▶│   Railway   │────▶│   Claude    │
│   Users     │◀────│   (Express) │◀────│   API       │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──────┐  ┌──▼───┐  ┌─────▼─────┐
       │  Vector     │  │ RAG  │  │  Voyage   │
       │  Store      │◀─│      │─▶│  AI API   │
       │  (In-mem)   │  └──────┘  │(Embeddings│
       └──────┬──────┘            └───────────┘
              │
       ┌──────▼──────┐
       │   GitHub    │
       │ criipto/docs│
       └─────────────┘
```

**Data flow:**
1. Docs fetched from GitHub → parsed into chunks
2. Chunks sent to Voyage AI → semantic embeddings (voyage-2, 1024 dims)
3. Embeddings stored in-memory for fast similarity search
4. User queries → Voyage AI embedding → cosine similarity → top matches
5. Matched chunks + query → Claude API → answer

## License

ISC

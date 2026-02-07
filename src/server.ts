import express, { Request, Response } from "express";
import crypto from "crypto";
import { ClaudeService } from "./services/claude.js";
import { checkRateLimit, getClientId } from "./services/rate-limiter.js";
import { ensureKBInitialized, rebuildKB, getKBStats } from "./services/knowledge-base.js";
import {
  verifySlackSignature,
  extractQuestion,
  formatSlackResponse,
  postSlackMessage,
  SlackEvent,
} from "./services/slack.js";

const app = express();

// Raw body parsing for Slack signature verification
app.use(
  express.json({
    verify: (req: Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

interface AskRequest {
  question: string;
}

interface AskResponse {
  answer: string;
  sources?: string[];
}

interface ErrorResponse {
  error: string;
  code: string;
}

let claudeService: ClaudeService | null = null;

function getClaudeService(): ClaudeService {
  if (!claudeService) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    }
    claudeService = new ClaudeService(apiKey);
  }
  return claudeService;
}

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  const kbStats = getKBStats();
  res.json({
    status: "ok",
    kb: {
      initialized: kbStats.initialized,
      chunkCount: kbStats.chunkCount,
      lastInitTime: kbStats.lastInitTime ? new Date(kbStats.lastInitTime).toISOString() : null,
    },
    slack: {
      configured: !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET),
    },
  });
});

// KB stats endpoint
app.get("/api/kb/stats", (_req: Request, res: Response) => {
  const stats = getKBStats();
  res.json({
    initialized: stats.initialized,
    chunkCount: stats.chunkCount,
    lastInitTime: stats.lastInitTime ? new Date(stats.lastInitTime).toISOString() : null,
  });
});

// Manual KB rebuild endpoint (protected by admin key)
app.post("/api/kb/rebuild", (req: Request, res: Response) => {
  const adminKey = process.env.ADMIN_API_KEY;
  const providedKey = req.headers["x-api-key"];

  if (adminKey && providedKey !== adminKey) {
    res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" } satisfies ErrorResponse);
    return;
  }

  // Fire and forget - respond immediately, rebuild in background
  console.log("Manual KB rebuild triggered");
  rebuildKB().catch((err) => console.error("Background KB rebuild failed:", err));

  res.json({
    success: true,
    message: "KB rebuild triggered. Check /api/kb/stats for progress.",
  });
});

// GitHub webhook for auto-rebuild
app.post("/api/webhook/github", async (req: Request, res: Response) => {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  // Verify webhook signature if secret is configured
  if (webhookSecret) {
    const signature = req.headers["x-hub-signature-256"] as string;
    if (!signature) {
      res.status(401).json({ error: "Missing signature", code: "MISSING_SIGNATURE" } satisfies ErrorResponse);
      return;
    }

    const body = JSON.stringify(req.body);
    const expectedSignature = "sha256=" + crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      res.status(401).json({ error: "Invalid signature", code: "INVALID_SIGNATURE" } satisfies ErrorResponse);
      return;
    }
  }

  const event = req.headers["x-github-event"];

  // Only rebuild on push events to the docs repo
  if (event === "push") {
    const payload = req.body;
    const ref = payload.ref || "";

    // Only rebuild on pushes to main/master
    if (ref === "refs/heads/main" || ref === "refs/heads/master") {
      console.log("GitHub push to main branch detected, rebuilding KB...");

      // Rebuild asynchronously, don't wait
      rebuildKB().catch((err) => console.error("Background KB rebuild failed:", err));

      res.json({ success: true, message: "KB rebuild triggered" });
      return;
    }
  }

  res.json({ success: true, message: "Event received but no action taken" });
});

// Slack Events API endpoint
app.post("/api/slack/events", async (req: Request & { rawBody?: string }, res: Response) => {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const botToken = process.env.SLACK_BOT_TOKEN;

  // Verify Slack signature
  if (signingSecret) {
    const signature = req.headers["x-slack-signature"] as string;
    const timestamp = req.headers["x-slack-request-timestamp"] as string;

    if (!signature || !timestamp || !req.rawBody) {
      res.status(401).json({ error: "Missing signature headers" });
      return;
    }

    if (!verifySlackSignature(signingSecret, signature, timestamp, req.rawBody)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
  }

  const event: SlackEvent = req.body;

  // Handle URL verification challenge
  if (event.type === "url_verification") {
    res.json({ challenge: event.challenge });
    return;
  }

  // Acknowledge receipt immediately (Slack expects response within 3 seconds)
  res.status(200).send();

  // Process event asynchronously
  if (event.type === "event_callback" && event.event) {
    const slackEvent = event.event;

    // Handle app mentions and direct messages
    if (
      (slackEvent.type === "app_mention" || slackEvent.type === "message") &&
      slackEvent.text &&
      slackEvent.channel
    ) {
      // Skip bot's own messages
      if (slackEvent.user === undefined) return;

      const question = extractQuestion(slackEvent.text);
      if (!question) return;

      console.log(`Slack question from ${slackEvent.user}: ${question}`);

      try {
        const claude = getClaudeService();
        const result = await claude.ask(question);
        const blocks = formatSlackResponse(result.answer, result.sources);

        if (botToken) {
          await postSlackMessage(
            botToken,
            slackEvent.channel,
            blocks,
            slackEvent.thread_ts || slackEvent.ts // Reply in thread if in thread
          );
        }
      } catch (error) {
        console.error("Error processing Slack message:", error);

        if (botToken) {
          await postSlackMessage(
            botToken,
            slackEvent.channel,
            [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "Sorry, I encountered an error processing your question. Please try again.",
                },
              },
            ],
            slackEvent.thread_ts || slackEvent.ts
          );
        }
      }
    }
  }
});

// Main ask endpoint
app.post("/api/ask", async (req: Request, res: Response) => {
  // Rate limiting
  const clientId = getClientId(req);
  const rateLimit = checkRateLimit(clientId);

  res.setHeader("X-RateLimit-Limit", "20");
  res.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(rateLimit.resetAt / 1000)));

  if (!rateLimit.allowed) {
    res.setHeader("Retry-After", String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)));
    res.status(429).json({
      error: "Rate limit exceeded. Max 20 requests per minute.",
      code: "RATE_LIMITED",
    } satisfies ErrorResponse);
    return;
  }

  const body = req.body as AskRequest;

  if (!body.question || typeof body.question !== "string") {
    res.status(400).json({
      error: "Missing or invalid 'question' field",
      code: "INVALID_REQUEST",
    } satisfies ErrorResponse);
    return;
  }

  const question = body.question.trim();

  if (question.length === 0) {
    res.status(400).json({
      error: "Question cannot be empty",
      code: "EMPTY_QUESTION",
    } satisfies ErrorResponse);
    return;
  }

  if (question.length > 10000) {
    res.status(400).json({
      error: "Question too long (max 10000 characters)",
      code: "QUESTION_TOO_LONG",
    } satisfies ErrorResponse);
    return;
  }

  try {
    const claude = getClaudeService();
    const result = await claude.ask(question);

    const response: AskResponse = {
      answer: result.answer,
      sources: result.sources,
    };

    res.json(response);
  } catch (error) {
    console.error("Error calling Claude API:", error);

    if (error instanceof Error && error.message.includes("ANTHROPIC_API_KEY")) {
      res.status(500).json({
        error: "Service configuration error",
        code: "CONFIG_ERROR",
      } satisfies ErrorResponse);
      return;
    }

    res.status(500).json({
      error: "Failed to process question",
      code: "INTERNAL_ERROR",
    } satisfies ErrorResponse);
  }
});

const PORT = process.env.PORT || 3000;

// Initialize KB on startup (non-blocking)
ensureKBInitialized().catch((err) => console.error("Initial KB load failed:", err));

app.listen(PORT, () => {
  console.log(`Idura Support API listening on port ${PORT}`);
});

import express, { Request, Response } from "express";
import crypto from "crypto";
import { ClaudeService } from "./services/claude.js";
import { checkRateLimit, getClientId } from "./services/rate-limiter.js";
import { ensureKBInitialized, rebuildKB, getKBStats } from "./services/knowledge-base.js";

const app = express();
app.use(express.json());

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
app.post("/api/kb/rebuild", async (req: Request, res: Response) => {
  const adminKey = process.env.ADMIN_API_KEY;
  const providedKey = req.headers["x-admin-key"];

  if (adminKey && providedKey !== adminKey) {
    res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" } satisfies ErrorResponse);
    return;
  }

  try {
    await rebuildKB();
    const stats = getKBStats();
    res.json({
      success: true,
      chunkCount: stats.chunkCount,
      lastInitTime: new Date(stats.lastInitTime).toISOString(),
    });
  } catch (error) {
    console.error("KB rebuild failed:", error);
    res.status(500).json({ error: "Failed to rebuild KB", code: "KB_REBUILD_FAILED" } satisfies ErrorResponse);
  }
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

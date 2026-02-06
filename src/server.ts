import express, { Request, Response } from "express";
import { ClaudeService } from "./services/claude.js";
import { checkRateLimit, getClientId } from "./services/rate-limiter.js";

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
  res.json({ status: "ok" });
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

app.listen(PORT, () => {
  console.log(`Idura Support API listening on port ${PORT}`);
});

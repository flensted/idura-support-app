import crypto from "crypto";
import https from "https";

interface SlackEvent {
  type: string;
  event?: {
    type: string;
    text?: string;
    user?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
  };
  challenge?: string;
}

interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
  };
  elements?: Array<{
    type: string;
    text?: string;
    url?: string;
  }>;
}

export function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  body: string
): boolean {
  // Check timestamp is within 5 minutes
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp) < fiveMinutesAgo) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = "v0=" + crypto.createHmac("sha256", signingSecret).update(sigBasestring).digest("hex");

  return crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
}

export function extractQuestion(text: string): string {
  // Remove bot mention (e.g., <@U12345>)
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

export function formatSlackResponse(answer: string, sources: string[]): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  // Main answer as markdown
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: convertToSlackMarkdown(answer),
    },
  });

  // Sources section
  if (sources.length > 0) {
    const sourceLinks = sources.map((url) => `<${url}|${extractDocTitle(url)}>`).join(" • ");

    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `📚 *Sources:* ${sourceLinks}`,
        },
      ],
    });
  }

  return blocks;
}

function convertToSlackMarkdown(text: string): string {
  // Convert standard markdown to Slack's mrkdwn format
  let result = text;

  // Convert headers (## Header -> *Header*)
  result = result.replace(/^###\s+(.+)$/gm, "*$1*");
  result = result.replace(/^##\s+(.+)$/gm, "*$1*");
  result = result.replace(/^#\s+(.+)$/gm, "*$1*");

  // Convert bold (**text** -> *text*)
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Convert inline code (`code` stays the same)
  // Already compatible

  // Convert code blocks (```lang\ncode\n``` -> ```code```)
  result = result.replace(/```\w*\n([\s\S]*?)```/g, "```$1```");

  // Convert links [text](url) -> <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Truncate if too long (Slack has 3000 char limit per block)
  if (result.length > 2900) {
    result = result.slice(0, 2900) + "...\n\n_Response truncated. See sources for more details._";
  }

  return result;
}

function extractDocTitle(url: string): string {
  // Extract readable title from URL path
  const path = url.replace(/https?:\/\/[^/]+/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return "Documentation";

  const last = parts[parts.length - 1];
  return last
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function postSlackMessage(
  token: string,
  channel: string,
  blocks: SlackBlock[],
  threadTs?: string
): Promise<void> {
  const payload = JSON.stringify({
    channel,
    blocks,
    thread_ts: threadTs,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "slack.com",
        path: "/api/chat.postMessage",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const response = JSON.parse(data);
          if (!response.ok) {
            reject(new Error(`Slack API error: ${response.error}`));
          } else {
            resolve();
          }
        });
      }
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export type { SlackEvent, SlackBlock };

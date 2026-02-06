import Anthropic from "@anthropic-ai/sdk";

const SYSTEM_PROMPT = `You are a helpful support assistant for Idura, a digital identity and authentication solutions company. You help users understand Idura's products and technical documentation.

Key products include:
- Criipto Verify: eID authentication (MitID, BankID, etc.)
- Criipto Signatures: Digital signing solutions

Guidelines:
- Be concise and accurate
- Include relevant documentation links when available (use https://docs.idura.eu as the base URL)
- If you're unsure about something, say so rather than guessing
- Format code examples with proper syntax highlighting
- Focus on practical, actionable answers`;

export class ClaudeService {
  private client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required");
    }
    this.client = new Anthropic({ apiKey });
  }

  async ask(question: string): Promise<{ answer: string; sources: string[] }> {
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: question,
        },
      ],
    });

    const textContent = response.content.find((block) => block.type === "text");
    if (!textContent || textContent.type !== "text") {
      throw new Error("No text response from Claude");
    }

    // Extract any docs.idura.eu links from the response as sources
    const sources = extractDocLinks(textContent.text);

    return {
      answer: textContent.text,
      sources,
    };
  }
}

function extractDocLinks(text: string): string[] {
  const linkRegex = /https:\/\/docs\.idura\.eu[^\s)>\]"]*/g;
  const matches = text.match(linkRegex);
  return matches ? [...new Set(matches)] : [];
}

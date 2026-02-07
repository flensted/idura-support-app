import Anthropic from "@anthropic-ai/sdk";
import { searchKB, KBSearchResult } from "./knowledge-base.js";

const SYSTEM_PROMPT = `You are a helpful support assistant for Idura (formerly Criipto), a digital identity and authentication solutions company. You help users understand Idura's products and technical documentation.

Key products include:
- Verify: eID authentication (MitID, BankID, itsme, iDIN, etc.)
- Signatures: Digital signing solutions
- Age verification
- Caller identification: Identify using eID when calling a call center

Guidelines:
- Be concise and accurate
- Base your answers on the provided documentation context when available
- At the begining of your anwser, include relevant documentation links from the context
- If the context doesn't contain enough information, say so and provide general guidance
- Format code examples with proper syntax highlighting
- Focus on practical, actionable answers`;

function buildContextPrompt(question: string, context: KBSearchResult[]): string {
  if (context.length === 0) {
    return question;
  }

  const contextText = context
    .map((r, i) => `[${i + 1}] ${r.title} - ${r.heading}\nURL: ${r.url}\n${r.content}`)
    .join("\n\n---\n\n");

  return `I have a question about Idura products.

Here is relevant documentation context:

${contextText}

---

Question: ${question}

Please answer based on the documentation context above. Include relevant URLs as sources.`;
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export class ClaudeService {
  private client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required");
    }
    this.client = new Anthropic({ apiKey });
  }

  async ask(
    question: string,
    conversationHistory: ConversationMessage[] = []
  ): Promise<{ answer: string; sources: string[] }> {
    // Search knowledge base for relevant context
    let context: KBSearchResult[] = [];
    try {
      context = await searchKB(question, 5);
    } catch (error) {
      console.error("KB search failed, proceeding without context:", error);
    }

    const prompt = buildContextPrompt(question, context);

    // Build messages array with conversation history
    const messages: ConversationMessage[] = [
      ...conversationHistory,
      { role: "user", content: prompt },
    ];

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages,
    });

    const textContent = response.content.find((block) => block.type === "text");
    if (!textContent || textContent.type !== "text") {
      throw new Error("No text response from Claude");
    }

    // Collect sources from context and any additional links in response
    const contextUrls = context.map((r) => r.url);
    const responseUrls = extractDocLinks(textContent.text);
    const allSources = [...new Set([...contextUrls, ...responseUrls])];

    return {
      answer: textContent.text,
      sources: allSources,
    };
  }
}

function extractDocLinks(text: string): string[] {
  const linkRegex = /https:\/\/docs\.(criipto\.com|idura\.eu)[^\s)>\]"]*/g;
  const matches = text.match(linkRegex);
  return matches ? [...new Set(matches)] : [];
}

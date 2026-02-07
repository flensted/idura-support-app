// In-memory conversation history store
// Tracks message exchanges by thread ID (Slack thread_ts or channel+user for DMs)

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface Conversation {
  messages: Message[];
  lastActivity: number;
}

const MAX_MESSAGES_PER_CONVERSATION = 10; // Keep last N exchanges
const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Cleanup every 5 minutes

class ConversationStore {
  private conversations: Map<string, Conversation> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanup();
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, conversation] of this.conversations) {
      if (now - conversation.lastActivity > CONVERSATION_TTL_MS) {
        this.conversations.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} expired conversations`);
    }
  }

  /**
   * Get conversation ID from Slack event context
   * Uses thread_ts if in a thread, otherwise channel+user for DM continuity
   */
  getConversationId(channel: string, user: string, threadTs?: string): string {
    if (threadTs) {
      return `thread:${channel}:${threadTs}`;
    }
    return `dm:${channel}:${user}`;
  }

  /**
   * Add a user message to the conversation
   */
  addUserMessage(conversationId: string, content: string): void {
    this.addMessage(conversationId, { role: "user", content, timestamp: Date.now() });
  }

  /**
   * Add an assistant message to the conversation
   */
  addAssistantMessage(conversationId: string, content: string): void {
    this.addMessage(conversationId, { role: "assistant", content, timestamp: Date.now() });
  }

  private addMessage(conversationId: string, message: Message): void {
    let conversation = this.conversations.get(conversationId);

    if (!conversation) {
      conversation = { messages: [], lastActivity: Date.now() };
      this.conversations.set(conversationId, conversation);
    }

    conversation.messages.push(message);
    conversation.lastActivity = Date.now();

    // Trim to max messages (keep pairs to maintain context)
    while (conversation.messages.length > MAX_MESSAGES_PER_CONVERSATION * 2) {
      conversation.messages.shift();
    }
  }

  /**
   * Get conversation history for Claude API
   * Returns messages in Claude's expected format
   */
  getHistory(conversationId: string): Array<{ role: "user" | "assistant"; content: string }> {
    const conversation = this.conversations.get(conversationId);

    if (!conversation) {
      return [];
    }

    // Return all but the most recent message (which is the current query)
    // Format for Claude API
    return conversation.messages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  /**
   * Get stats for debugging
   */
  getStats(): { activeConversations: number; totalMessages: number } {
    let totalMessages = 0;
    for (const conversation of this.conversations.values()) {
      totalMessages += conversation.messages.length;
    }
    return {
      activeConversations: this.conversations.size,
      totalMessages,
    };
  }
}

export const conversationStore = new ConversationStore();
export type { Message };

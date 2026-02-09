/**
 * Slack Export Parser
 *
 * Parses Slack export ZIP files to extract Q&A pairs where:
 * - Customer asks a question
 * - Idura staff member responds
 *
 * Supports both directory-based parsing (for scripts) and
 * in-memory ZIP parsing (for API uploads).
 */

import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";

// Idura staff user IDs (from @criipto.com and @idura.eu emails)
const STAFF_IDS = new Set([
  "U03KQSTKK7U",
  "U05UQK99W6N",
  "U0726BRR4E8",
  "U07FWRPQKR6",
  "U07GR7TBS84",
  "U07KPR5PSB0",
  "U07KYT36V28",
  "U093VPVABA6",
  "U09C67WJ1E0",
  "U09GK2Z9UAY",
  "U09RYPRKF1Q",
  "U0A4GP62VLL",
  "U0A6ZNDKQ22",
  "U0A75N40G0L",
  "U0A9RGP1QQ0",
  "U03KAAJ0REK",
  "U03KN05BW1K",
  "U03Q92A3LKT",
  "U03T071R0KX",
  "U048QLU89EK",
  "U04FX9XARA9",
  "U04KVDBNLB1",
  "U063XDTHWBB",
  "U06HJ0TJH7F",
  "U06SBGUC7U7",
  "U08NJT4DV1P",
  "U0979RRFAEB",
  "U09HG8TV3EF",
]);

// Channels to process
const TARGET_CHANNELS = ["support", "signatures-api", "general"];

interface SlackMessage {
  type: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  parent_user_id?: string;
  subtype?: string;
  bot_id?: string;
}

export interface QAPair {
  question: string;
  answer: string;
  channel: string;
  date: string;
  topic: string;
}

interface UserInfo {
  id: string;
  name: string;
  realName: string;
  isStaff: boolean;
}

interface SlackUser {
  id: string;
  name?: string;
  profile?: {
    real_name?: string;
    email?: string;
  };
}

// Anonymize text - remove user mentions and potential PII
function anonymizeText(text: string, users: Map<string, UserInfo>): string {
  // Replace user mentions <@UXXXX> with "a user" or "support"
  let result = text.replace(/<@([A-Z0-9]+)>/g, (_match, userId) => {
    const user = users.get(userId);
    if (user?.isStaff) {
      return "support";
    }
    return "a user";
  });

  // Remove email addresses
  result = result.replace(/[\w.-]+@[\w.-]+\.\w+/g, "[email]");

  // Remove URLs that aren't docs links
  result = result.replace(
    /https?:\/\/(?!docs\.(criipto|idura))[^\s<>]+/g,
    "[link]"
  );

  // Remove potential phone numbers
  result = result.replace(/\+?\d{8,}/g, "[phone]");

  return result.trim();
}

// Extract topic from question
function extractTopic(question: string): string {
  const lowerQ = question.toLowerCase();

  if (lowerQ.includes("bankid") || lowerQ.includes("bank id")) {
    if (lowerQ.includes("norwegian") || lowerQ.includes("norsk")) {
      return "Norwegian BankID";
    }
    if (lowerQ.includes("swedish") || lowerQ.includes("svensk")) {
      return "Swedish BankID";
    }
    return "BankID";
  }
  if (lowerQ.includes("mitid")) return "MitID";
  if (
    lowerQ.includes("signature") ||
    lowerQ.includes("signing") ||
    lowerQ.includes("signatur")
  ) {
    return "Signatures";
  }
  if (
    lowerQ.includes("verify") ||
    lowerQ.includes("authentication") ||
    lowerQ.includes("autentisering")
  ) {
    return "Verify/Authentication";
  }
  if (lowerQ.includes("webhook")) return "Webhooks";
  if (lowerQ.includes("graphql") || lowerQ.includes("api")) return "API";
  if (lowerQ.includes("token")) return "Tokens";
  if (
    lowerQ.includes("error") ||
    lowerQ.includes("feil") ||
    lowerQ.includes("fejl")
  ) {
    return "Troubleshooting";
  }
  if (lowerQ.includes("preapprov")) return "Preapproval";
  if (
    lowerQ.includes("document") ||
    lowerQ.includes("pdf") ||
    lowerQ.includes("dokument")
  ) {
    return "Documents";
  }

  return "General";
}

// Build user map from users.json content
function buildUserMap(usersJson: SlackUser[]): Map<string, UserInfo> {
  const userMap = new Map<string, UserInfo>();

  for (const user of usersJson) {
    const email = user.profile?.email || "";
    const isStaffByEmail =
      email.includes("@criipto.com") || email.includes("@idura.eu");
    const isStaffById = STAFF_IDS.has(user.id);

    userMap.set(user.id, {
      id: user.id,
      name: user.name || "",
      realName: user.profile?.real_name || "",
      isStaff: isStaffById || isStaffByEmail,
    });
  }

  return userMap;
}

// Process messages from a channel to extract Q&A pairs
function processChannelMessages(
  channelName: string,
  messageFiles: Map<string, SlackMessage[]>,
  users: Map<string, UserInfo>
): QAPair[] {
  const pairs: QAPair[] = [];

  // Group messages by thread
  const threads = new Map<string, SlackMessage[]>();
  const topLevelMessages = new Map<string, SlackMessage>();

  for (const messages of messageFiles.values()) {
    for (const msg of messages) {
      if (msg.type !== "message" || msg.subtype || msg.bot_id || !msg.text) {
        continue;
      }

      if (msg.thread_ts && msg.thread_ts !== msg.ts) {
        // This is a reply in a thread
        const thread = threads.get(msg.thread_ts) || [];
        thread.push(msg);
        threads.set(msg.thread_ts, thread);
      } else {
        // Top-level message (potential thread starter)
        topLevelMessages.set(msg.ts, msg);
      }
    }
  }

  // Process threads to find Q&A pairs
  for (const [threadTs, replies] of threads) {
    const parentMsg = topLevelMessages.get(threadTs);
    if (!parentMsg || !parentMsg.text || !parentMsg.user) continue;

    const parentUser = users.get(parentMsg.user);

    // Skip if parent is from staff (we want customer questions)
    if (parentUser?.isStaff) continue;

    // Find first staff reply
    const staffReply = replies.find((r) => {
      const user = users.get(r.user || "");
      return user?.isStaff && r.text && r.text.length > 50;
    });

    if (!staffReply || !staffReply.text) continue;

    // Skip very short questions or answers
    if (parentMsg.text.length < 20 || staffReply.text.length < 50) continue;

    const question = anonymizeText(parentMsg.text, users);
    const answer = anonymizeText(staffReply.text, users);

    // Skip if anonymization removed too much content
    if (question.length < 15 || answer.length < 40) continue;

    const date = new Date(parseFloat(threadTs) * 1000)
      .toISOString()
      .split("T")[0];

    pairs.push({
      question,
      answer,
      channel: channelName,
      date,
      topic: extractTopic(question),
    });
  }

  return pairs;
}

export interface ParseResult {
  pairs: QAPair[];
  stats: {
    totalUsers: number;
    staffUsers: number;
    channelsProcessed: string[];
    pairsByTopic: Record<string, number>;
  };
}

/**
 * Parse a Slack export ZIP file from a Buffer
 */
export async function parseSlackExportZip(
  zipBuffer: Buffer
): Promise<ParseResult> {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  // Find the export root (might be in a subdirectory)
  let exportRoot = "";
  for (const entry of entries) {
    if (entry.entryName.endsWith("/users.json")) {
      exportRoot = entry.entryName.replace("users.json", "");
      break;
    }
    if (entry.entryName === "users.json") {
      exportRoot = "";
      break;
    }
  }

  // Load users.json
  const usersEntry = entries.find(
    (e: { entryName: string }) => e.entryName === exportRoot + "users.json"
  );
  if (!usersEntry) {
    throw new Error("users.json not found in ZIP file");
  }

  const usersJson: SlackUser[] = JSON.parse(
    usersEntry.getData().toString("utf-8")
  );
  const users = buildUserMap(usersJson);

  const allPairs: QAPair[] = [];
  const processedChannels: string[] = [];

  // Process each target channel
  for (const channelName of TARGET_CHANNELS) {
    const channelPrefix = exportRoot + channelName + "/";
    const channelEntries = entries.filter(
      (e: { entryName: string }) =>
        e.entryName.startsWith(channelPrefix) && e.entryName.endsWith(".json")
    );

    if (channelEntries.length === 0) {
      continue;
    }

    const messageFiles = new Map<string, SlackMessage[]>();
    for (const entry of channelEntries) {
      const content = entry.getData().toString("utf-8");
      const messages: SlackMessage[] = JSON.parse(content);
      messageFiles.set(entry.entryName, messages);
    }

    const pairs = processChannelMessages(channelName, messageFiles, users);
    allPairs.push(...pairs);
    processedChannels.push(channelName);
  }

  // Sort by date
  allPairs.sort((a, b) => a.date.localeCompare(b.date));

  // Calculate stats
  const pairsByTopic: Record<string, number> = {};
  for (const pair of allPairs) {
    pairsByTopic[pair.topic] = (pairsByTopic[pair.topic] || 0) + 1;
  }

  const staffCount = [...users.values()].filter((u) => u.isStaff).length;

  return {
    pairs: allPairs,
    stats: {
      totalUsers: users.size,
      staffUsers: staffCount,
      channelsProcessed: processedChannels,
      pairsByTopic,
    },
  };
}

/**
 * Save Q&A pairs to the data directory
 */
export function saveQAPairs(pairs: QAPair[]): string {
  const outputPath = path.join(process.cwd(), "data/slack-qa.json");
  const dataDir = path.dirname(outputPath);

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(pairs, null, 2));
  return outputPath;
}

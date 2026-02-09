/**
 * Slack Q&A Loader
 *
 * Loads pre-processed Q&A pairs from Slack export and converts them
 * to ParsedDoc format for inclusion in the knowledge base.
 */

import fs from "fs";
import path from "path";
import { ParsedDoc, DocSection } from "./docs-parser.js";

interface QAPair {
  question: string;
  answer: string;
  channel: string;
  date: string;
  topic: string;
}

/**
 * Load Slack Q&A pairs and convert to ParsedDoc format
 */
export function loadSlackQA(): ParsedDoc[] {
  // Use process.cwd() since we're in dist after compilation
  const qaPath = path.join(process.cwd(), "data/slack-qa.json");

  if (!fs.existsSync(qaPath)) {
    console.log("Slack Q&A file not found, skipping");
    return [];
  }

  const pairs: QAPair[] = JSON.parse(fs.readFileSync(qaPath, "utf-8"));
  console.log(`Loading ${pairs.length} Slack Q&A pairs...`);

  // Group by topic for better organization
  const byTopic = new Map<string, QAPair[]>();
  for (const pair of pairs) {
    const topicPairs = byTopic.get(pair.topic) || [];
    topicPairs.push(pair);
    byTopic.set(pair.topic, topicPairs);
  }

  const docs: ParsedDoc[] = [];

  for (const [topic, topicPairs] of byTopic) {
    // Create sections from Q&A pairs
    const sections: DocSection[] = topicPairs.map((pair, idx) => ({
      heading: `Q: ${pair.question.slice(0, 100)}${pair.question.length > 100 ? "..." : ""}`,
      content: `**Question:** ${pair.question}\n\n**Answer:** ${pair.answer}`,
      level: 2,
    }));

    // Create a ParsedDoc for this topic
    const doc: ParsedDoc = {
      metadata: {
        title: `${topic} - Community Q&A`,
        path: `/slack-qa/${topic.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        category: "Community Support",
        product: topic.includes("Signature") ? "signatures" : "verify",
        sort: 1000, // Low priority compared to official docs
      },
      sections,
      content: sections.map((s) => s.content).join("\n\n---\n\n"),
    };

    docs.push(doc);
  }

  console.log(`Created ${docs.length} Q&A topic documents`);
  return docs;
}

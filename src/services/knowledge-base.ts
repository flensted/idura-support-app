import { fetchAllDocs, ParsedDoc } from "./docs-parser.js";
import { vectorStore, SearchResult } from "./vector-store.js";
import { loadSlackQA } from "./slack-qa-loader.js";

const DOCS_BASE_URL = "https://docs.criipto.com";

interface KBSearchResult {
  title: string;
  heading: string;
  content: string;
  url: string;
  score: number;
}

let initPromise: Promise<void> | null = null;
let lastInitTime: number = 0;
const REINIT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function initializeKB(): Promise<void> {
  console.log("Initializing knowledge base...");
  const startTime = Date.now();

  try {
    // Load documentation from GitHub
    const docs = await fetchAllDocs();

    // Load Slack Q&A pairs
    const slackQA = loadSlackQA();

    // Combine all sources
    const allDocs = [...docs, ...slackQA];

    vectorStore.clear();
    await vectorStore.addDocs(allDocs);
    lastInitTime = Date.now();
    console.log(
      `Knowledge base initialized in ${Date.now() - startTime}ms (${docs.length} docs + ${slackQA.length} Q&A topics)`
    );
  } catch (error) {
    console.error("Failed to initialize knowledge base:", error);
    throw error;
  }
}

export async function ensureKBInitialized(): Promise<void> {
  const now = Date.now();

  // Check if we need to reinitialize
  if (vectorStore.isInitialized() && now - lastInitTime < REINIT_INTERVAL_MS) {
    return;
  }

  // Only one initialization at a time
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = initializeKB();
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

function pathToUrl(docPath: string): string {
  // Slack Q&A doesn't have external URLs
  if (docPath.startsWith("/slack-qa/")) {
    return "Community Support Q&A";
  }
  // Convert /verify/getting-started/overview.mdx to https://docs.criipto.com/verify/getting-started/overview
  let url = docPath.replace(/\.mdx$/, "").replace(/\/index$/, "");
  return `${DOCS_BASE_URL}${url}`;
}

export async function searchKB(query: string, topK: number = 5): Promise<KBSearchResult[]> {
  await ensureKBInitialized();

  const results = await vectorStore.search(query, topK);

  return results.map((r) => ({
    title: r.chunk.title,
    heading: r.chunk.heading,
    content: r.chunk.content,
    url: pathToUrl(r.chunk.docPath),
    score: r.score,
  }));
}

export function getKBStats(): { initialized: boolean; chunkCount: number; lastInitTime: number } {
  return {
    initialized: vectorStore.isInitialized(),
    chunkCount: vectorStore.chunkCount(),
    lastInitTime,
  };
}

export async function rebuildKB(): Promise<void> {
  lastInitTime = 0; // Force reinit
  await ensureKBInitialized();
}

export type { KBSearchResult };

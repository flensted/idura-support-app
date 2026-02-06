import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required for embeddings");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

// Use Voyage AI embeddings via Anthropic's partnership
// For simplicity, we'll use a hash-based approach initially and can upgrade later
// This provides a working system without additional API dependencies

const EMBEDDING_DIM = 384;

// Simple hash-based embedding for MVP - can be replaced with real embeddings later
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
}

// Generate a deterministic pseudo-embedding from text
// This is a placeholder - replace with real embeddings API for better quality
export function generateEmbedding(text: string): number[] {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const words = normalized.split(" ");
  const embedding = new Array(EMBEDDING_DIM).fill(0);

  // Bag of words with position weighting
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const hash = simpleHash(word);
    const idx = Math.abs(hash) % EMBEDDING_DIM;
    const positionWeight = 1 / (1 + Math.log(i + 1));
    embedding[idx] += positionWeight;

    // Also add bigrams
    if (i < words.length - 1) {
      const bigram = word + " " + words[i + 1];
      const bigramHash = simpleHash(bigram);
      const bigramIdx = Math.abs(bigramHash) % EMBEDDING_DIM;
      embedding[bigramIdx] += positionWeight * 0.5;
    }
  }

  // Normalize to unit vector
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= magnitude;
    }
  }

  return embedding;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have same length");
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

export { EMBEDDING_DIM };

import https from "https";

const EMBEDDING_DIM = 1024; // Voyage AI voyage-2 dimension
const VOYAGE_MODEL = "voyage-2";

interface VoyageResponse {
  object: string;
  data: Array<{
    object: string;
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    total_tokens: number;
  };
}

function getVoyageApiKey(): string {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY environment variable is not set");
  }
  return apiKey;
}

async function callVoyageApi(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
  const apiKey = getVoyageApiKey();

  const payload = JSON.stringify({
    model: VOYAGE_MODEL,
    input: texts,
    input_type: inputType,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.voyageai.com",
        path: "/v1/embeddings",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Voyage API error ${res.statusCode}: ${data}`));
            return;
          }
          try {
            const response: VoyageResponse = JSON.parse(data);
            const embeddings = response.data
              .sort((a, b) => a.index - b.index)
              .map((d) => d.embedding);
            resolve(embeddings);
          } catch (e) {
            reject(new Error(`Failed to parse Voyage response: ${e}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Cache for document embeddings (computed once at startup)
const embeddingCache = new Map<string, number[]>();

export async function generateEmbedding(text: string, inputType: "document" | "query" = "document"): Promise<number[]> {
  // Check cache for documents
  if (inputType === "document") {
    const cached = embeddingCache.get(text);
    if (cached) return cached;
  }

  const embeddings = await callVoyageApi([text], inputType);
  const embedding = embeddings[0];

  // Cache document embeddings
  if (inputType === "document") {
    embeddingCache.set(text, embedding);
  }

  return embedding;
}

export async function generateEmbeddings(texts: string[], inputType: "document" | "query" = "document"): Promise<number[][]> {
  // Voyage API supports batching up to 128 texts
  const BATCH_SIZE = 128;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await callVoyageApi(batch, inputType);
    results.push(...embeddings);

    // Small delay between batches to avoid rate limits
    if (i + BATCH_SIZE < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return results;
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

export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}

export { EMBEDDING_DIM };

import { generateEmbedding, generateEmbeddings, cosineSimilarity } from "./embeddings.js";
import { ParsedDoc, DocSection } from "./docs-parser.js";

interface DocChunk {
  id: string;
  docPath: string;
  title: string;
  category: string;
  product: string;
  heading: string;
  content: string;
  embedding: number[];
}

interface SearchResult {
  chunk: DocChunk;
  score: number;
}

// Pending chunk without embedding (used during batch processing)
interface PendingChunk {
  id: string;
  docPath: string;
  title: string;
  category: string;
  product: string;
  heading: string;
  content: string;
  textForEmbedding: string;
}

class VectorStore {
  private chunks: DocChunk[] = [];
  private initialized = false;

  isInitialized(): boolean {
    return this.initialized;
  }

  chunkCount(): number {
    return this.chunks.length;
  }

  async addDocs(docs: ParsedDoc[]): Promise<void> {
    // Collect all chunks first without embeddings
    const pendingChunks: PendingChunk[] = [];

    for (const doc of docs) {
      const { metadata, sections, content } = doc;

      // If no sections, treat whole doc as one chunk
      if (sections.length === 0) {
        pendingChunks.push({
          id: `${metadata.path}#main`,
          docPath: metadata.path,
          title: metadata.title,
          category: metadata.category,
          product: metadata.product,
          heading: metadata.title,
          content: content.slice(0, 2000),
          textForEmbedding: `${metadata.title} ${content}`.slice(0, 8000),
        });
        continue;
      }

      // Create a chunk for each section
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const chunkText = `${section.heading}\n${section.content}`.slice(0, 2000);

        if (chunkText.trim().length < 50) {
          continue; // Skip very short sections
        }

        pendingChunks.push({
          id: `${metadata.path}#section-${i}`,
          docPath: metadata.path,
          title: metadata.title,
          category: metadata.category,
          product: metadata.product,
          heading: section.heading,
          content: section.content.slice(0, 1500),
          textForEmbedding: `${metadata.title} ${section.heading} ${section.content}`.slice(0, 8000),
        });
      }
    }

    // Generate embeddings in batches
    console.log(`Generating embeddings for ${pendingChunks.length} chunks...`);
    const texts = pendingChunks.map((c) => c.textForEmbedding);
    const embeddings = await generateEmbeddings(texts, "document");

    // Combine chunks with their embeddings
    for (let i = 0; i < pendingChunks.length; i++) {
      const pending = pendingChunks[i];
      this.chunks.push({
        id: pending.id,
        docPath: pending.docPath,
        title: pending.title,
        category: pending.category,
        product: pending.product,
        heading: pending.heading,
        content: pending.content,
        embedding: embeddings[i],
      });
    }

    this.initialized = true;
    console.log(`Vector store initialized with ${this.chunks.length} chunks from ${docs.length} docs`);
  }

  async search(query: string, topK: number = 5): Promise<SearchResult[]> {
    if (this.chunks.length === 0) {
      return [];
    }

    // Use "query" input type for search queries
    const queryEmbedding = await generateEmbedding(query, "query");
    const results: SearchResult[] = [];

    for (const chunk of this.chunks) {
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      results.push({ chunk, score });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Return top K
    return results.slice(0, topK);
  }

  clear(): void {
    this.chunks = [];
    this.initialized = false;
  }
}

// Singleton instance
const vectorStore = new VectorStore();

export { vectorStore, VectorStore, DocChunk, SearchResult };

import { generateEmbedding, cosineSimilarity } from "./embeddings.js";
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

class VectorStore {
  private chunks: DocChunk[] = [];
  private initialized = false;

  isInitialized(): boolean {
    return this.initialized;
  }

  chunkCount(): number {
    return this.chunks.length;
  }

  addDoc(doc: ParsedDoc): void {
    const { metadata, sections, content } = doc;

    // If no sections, treat whole doc as one chunk
    if (sections.length === 0) {
      const chunk: DocChunk = {
        id: `${metadata.path}#main`,
        docPath: metadata.path,
        title: metadata.title,
        category: metadata.category,
        product: metadata.product,
        heading: metadata.title,
        content: content.slice(0, 2000), // Limit chunk size
        embedding: generateEmbedding(`${metadata.title} ${content}`),
      };
      this.chunks.push(chunk);
      return;
    }

    // Create a chunk for each section
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const chunkText = `${section.heading}\n${section.content}`.slice(0, 2000);

      if (chunkText.trim().length < 50) {
        continue; // Skip very short sections
      }

      const chunk: DocChunk = {
        id: `${metadata.path}#section-${i}`,
        docPath: metadata.path,
        title: metadata.title,
        category: metadata.category,
        product: metadata.product,
        heading: section.heading,
        content: section.content.slice(0, 1500),
        embedding: generateEmbedding(`${metadata.title} ${section.heading} ${section.content}`),
      };
      this.chunks.push(chunk);
    }
  }

  addDocs(docs: ParsedDoc[]): void {
    for (const doc of docs) {
      this.addDoc(doc);
    }
    this.initialized = true;
    console.log(`Vector store initialized with ${this.chunks.length} chunks from ${docs.length} docs`);
  }

  search(query: string, topK: number = 5): SearchResult[] {
    if (this.chunks.length === 0) {
      return [];
    }

    const queryEmbedding = generateEmbedding(query);
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

import https from "https";

interface DocMetadata {
  product: string;
  category: string;
  sort: number;
  title: string;
  subtitle?: string;
  path: string;
}

interface ParsedDoc {
  metadata: DocMetadata;
  content: string;
  sections: DocSection[];
}

interface DocSection {
  heading: string;
  level: number;
  content: string;
}

const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/criipto/docs/master/src/pages";
const GITHUB_API_BASE = "https://api.github.com/repos/criipto/docs/contents/src/pages";

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "idura-support-api" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (location) {
          fetchUrl(location).then(resolve).catch(reject);
          return;
        }
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function parseFrontmatter(content: string): { metadata: Partial<DocMetadata>; body: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { metadata: {}, body: content };
  }

  const [, frontmatterStr, body] = frontmatterMatch;
  const metadata: Partial<DocMetadata> = {};

  for (const line of frontmatterStr.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      if (key === "sort") {
        metadata.sort = parseInt(value, 10);
      } else if (key === "product" || key === "category" || key === "title" || key === "subtitle") {
        metadata[key] = value.replace(/^["']|["']$/g, "");
      }
    }
  }

  return { metadata, body };
}

function stripJsxComponents(content: string): string {
  // Remove import statements
  content = content.replace(/^import\s+.*?;\s*$/gm, "");

  // Extract text content from simple JSX components like <Highlight>...</Highlight>
  content = content.replace(/<(\w+)[^>]*>([\s\S]*?)<\/\1>/g, (_, _tag, inner) => {
    return inner.trim();
  });

  // Remove self-closing JSX components
  content = content.replace(/<\w+[^/>]*\/>/g, "");

  // Remove remaining JSX-style tags
  content = content.replace(/<[^>]+>/g, "");

  return content.trim();
}

function extractSections(content: string): DocSection[] {
  const sections: DocSection[] = [];
  const lines = content.split("\n");
  let currentSection: DocSection | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      if (currentSection) {
        currentSection.content = currentContent.join("\n").trim();
        sections.push(currentSection);
      }
      currentSection = {
        heading: headingMatch[2],
        level: headingMatch[1].length,
        content: "",
      };
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentSection) {
    currentSection.content = currentContent.join("\n").trim();
    sections.push(currentSection);
  }

  return sections;
}

export async function parseDoc(filePath: string): Promise<ParsedDoc> {
  // filePath should be like /verify/index.mdx
  const url = `${GITHUB_RAW_BASE}${filePath}`;
  console.log(`Fetching: ${url}`);
  const raw = await fetchUrl(url);

  const { metadata, body } = parseFrontmatter(raw);
  const cleanedContent = stripJsxComponents(body);
  const sections = extractSections(cleanedContent);

  return {
    metadata: {
      product: metadata.product || "unknown",
      category: metadata.category || "General",
      sort: metadata.sort || 0,
      title: metadata.title || filePath,
      subtitle: metadata.subtitle,
      path: filePath,
    },
    content: cleanedContent,
    sections,
  };
}

interface GitHubTreeItem {
  name: string;
  path: string;
  type: string;
}

async function listMdxFiles(apiPath: string = ""): Promise<string[]> {
  const url = `${GITHUB_API_BASE}${apiPath}`;
  console.log(`Listing: ${url}`);
  const response = await fetchUrl(url);
  const items: GitHubTreeItem[] = JSON.parse(response);
  const files: string[] = [];

  for (const item of items) {
    if (item.type === "file" && item.name.endsWith(".mdx")) {
      // item.path is like "src/pages/verify/index.mdx"
      // We want "/verify/index.mdx"
      const relativePath = "/" + item.path.replace(/^src\/pages\//, "");
      files.push(relativePath);
    } else if (item.type === "dir") {
      // Recurse into subdirectory
      // apiPath for subdirs: /verify, /verify/guides, etc.
      const subApiPath = apiPath + "/" + item.name;
      const subFiles = await listMdxFiles(subApiPath);
      files.push(...subFiles);
    }
  }

  return files;
}

export async function fetchAllDocs(): Promise<ParsedDoc[]> {
  console.log("Fetching list of MDX files from GitHub...");
  const mdxFiles = await listMdxFiles();
  console.log(`Found ${mdxFiles.length} MDX files`);

  const docs: ParsedDoc[] = [];

  for (const file of mdxFiles) {
    try {
      const doc = await parseDoc(file);
      docs.push(doc);
      console.log(`Parsed: ${file} (${doc.sections.length} sections)`);
    } catch (error) {
      console.error(`Failed to parse ${file}:`, error instanceof Error ? error.message : error);
    }
  }

  console.log(`Successfully parsed ${docs.length} docs`);
  return docs;
}

export type { DocMetadata, ParsedDoc, DocSection };

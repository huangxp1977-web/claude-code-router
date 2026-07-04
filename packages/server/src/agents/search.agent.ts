import { IAgent, ITool } from "./type";

interface SearchResult {
  title: string;
  url: string;
  description: string;
  position: number;
}

async function searchDuckDuckGo(query: string, limit: number = 5): Promise<any> {
  try {
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`DuckDuckGo returned ${response.status}`);
    }

    const html = await response.text();

    // Parse DuckDuckGo HTML results
    const resultRegex = /<div class="result[^"]*">[\s\S]*?<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    let match;
    let position = 1;
    const results: SearchResult[] = [];
    while ((match = resultRegex.exec(html)) !== null && position <= limit) {
      let url = match[1];
      let title = match[2];
      let description = match[3];

      // Clean up title HTML (DuckDuckGo bolds search terms with <b> tags) + HTML entity decode
      title = title.replace(/<[^>]+>/g, '');
      title = title.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

      // Clean up description HTML
      description = description.replace(/<[^>]+>/g, '');
      description = description.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&apos;/g, "'");

      // Clean up URL (DuckDuckGo uses redirect URLs like /l/?uddg=...)
      if (url.startsWith('/l/?uddg=')) {
        const matchUrl = url.match(/uddg=([^&]+)/);
        if (matchUrl) {
          url = decodeURIComponent(matchUrl[1]);
        }
      } else if (url.startsWith('//')) {
        url = 'https:' + url;
      }

      results.push({
        title: title.trim(),
        url: url.trim(),
        description: description.trim(),
        position: position,
      });

      position++;
      if (position > limit) break;
    }

    return { success: true, data: { web: results } };
  } catch (error) {
    console.error("DuckDuckGo search error:", error);
    return { success: false, error: "Search failed" };
  }
}

export class SearchAgent implements IAgent {
  name = "search";
  tools: Map<string, ITool> = new Map();

  constructor() {
    this.tools = new Map();
    this.registerSearchTool();
  }

  shouldHandle(req: any, config: any): boolean {
    // Check if WebSearch is configured
    const webSearchConfig = config.WebSearch;
    if (!webSearchConfig?.enabled) {
      return false;
    }

    // Check if a search provider is configured
    const activeProvider = config.WebSearch?.activeProvider;
    if (!activeProvider) {
      return false;
    }

    // Check if the provider is properly configured
    if (activeProvider === "duckduckgo") {
      // DuckDuckGo always available (no API key needed)
      return true;
    }

    // Check if provider has required config
    const providerConfig = config.WebSearch?.providers?.[activeProvider];
    if (!providerConfig) {
      return false;
    }

    // For providers requiring API keys, check if key is set
    if (activeProvider === "tavily" && !providerConfig.apiKey) {
      return false;
    }
    if (activeProvider === "brave" && !providerConfig.apiKey) {
      return false;
    }

    return true;
  }

  reqHandler(req: any, config: any): void {
    // The search tool will be added by the agent system
    // No need to modify request here
  }

  private registerSearchTool() {
    this.tools.set("web_search", {
      name: "web_search",
      description: "Search the web for information. Returns a list of relevant results with titles, URLs, and descriptions.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to look up",
          },
          max_results: {
            type: "number",
            description: "Maximum number of results to return (default: 5)",
          },
        },
        required: ["query"],
      },
      handler: async (args: any, context: any) => {
        const query = args.query;
        const limit = args.max_results || 5;

        // Get the search config
        const webSearchConfig = context.config.WebSearch;
        if (!webSearchConfig?.enabled) {
          return "Web search is not enabled. Please enable it in settings.";
        }

        const activeProvider = context.config.WebSearch?.activeProvider;
        if (!activeProvider) {
          return "No search provider configured. Please configure a search provider in settings.";
        }

        // Get provider config
        const providerConfig = context.config.WebSearch?.providers?.[activeProvider] || {};

        try {
          let result;
          if (activeProvider === "duckduckgo") {
            result = await searchDuckDuckGo(args.query, args.max_results || 5);
          } else if (activeProvider === "tavily") {
            // TODO: Implement Tavily
            return "Tavily provider not yet implemented. Please select DuckDuckGo or configure Tavily API key.";
          } else if (activeProvider === "brave") {
            // TODO: Implement Brave
            return "Brave Search not yet implemented. Please select DuckDuckGo or configure Brave API key.";
          } else {
            return `Unknown search provider: ${activeProvider}`;
          }

          if (!result.success) {
            return `Search failed: ${result.error}`;
          }

          // Format results for display
          const results = result.data?.web || [];
          if (!results.length) {
            return `No results found for "${args.query}"`;
          }

          let output = `Search results for "${args.query}" (using ${activeProvider}):\n\n`;
          for (const result of results) {
            output += `**${result.position}. ${result.title}**\n`;
            output += `   URL: ${result.url}\n`;
            output += `   ${result.description}\n\n`;
          }

          return output;
        } catch (error) {
          console.error("Search error:", error);
          return `Search failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    });
  }
}

export const searchAgent = new SearchAgent();
import { get_encoding } from "tiktoken";
import { isModelFailed, getModelSpec } from "./cache";
import { getModelUsage } from "./dailyUsage";
import { readFile } from "fs/promises";
import { opendir, stat } from "fs/promises";
import { join } from "path";
import { CLAUDE_PROJECTS_DIR, HOME_DIR } from "@thxp/shared";
import { LRUCache } from "lru-cache";
import { ConfigService } from "../services/config";
import { TokenizerService } from "../services/tokenizer";

// Types from @anthropic-ai/sdk
interface Tool {
  name: string;
  description?: string;
  input_schema: object;
}

interface ContentBlockParam {
  type: string;
  [key: string]: any;
}

interface MessageParam {
  role: string;
  content: string | ContentBlockParam[];
}

interface MessageCreateParamsBase {
  messages?: MessageParam[];
  system?: string | any[];
  tools?: Tool[];
  [key: string]: any;
}

const enc = get_encoding("cl100k_base");

export const calculateTokenCount = (
  messages: MessageParam[],
  system: any,
  tools: Tool[]
) => {
  let tokenCount = 0;
  if (Array.isArray(messages)) {
    messages.forEach((message) => {
      if (typeof message.content === "string") {
        tokenCount += enc.encode(message.content).length;
      } else if (Array.isArray(message.content)) {
        message.content.forEach((contentPart: any) => {
          if (contentPart.type === "text") {
            tokenCount += enc.encode(contentPart.text).length;
          } else if (contentPart.type === "tool_use") {
            tokenCount += enc.encode(JSON.stringify(contentPart.input)).length;
          } else if (contentPart.type === "tool_result") {
            tokenCount += enc.encode(
              typeof contentPart.content === "string"
                ? contentPart.content
                : JSON.stringify(contentPart.content)
            ).length;
          }
        });
      }
    });
  }
  if (typeof system === "string") {
    tokenCount += enc.encode(system).length;
  } else if (Array.isArray(system)) {
    system.forEach((item: any) => {
      if (item.type !== "text") return;
      if (typeof item.text === "string") {
        tokenCount += enc.encode(item.text).length;
      } else if (Array.isArray(item.text)) {
        item.text.forEach((textPart: any) => {
          tokenCount += enc.encode(textPart || "").length;
        });
      }
    });
  }
  if (tools) {
    tools.forEach((tool: Tool) => {
      if (tool.description) {
        tokenCount += enc.encode(tool.name + tool.description).length;
      }
      if (tool.input_schema) {
        tokenCount += enc.encode(JSON.stringify(tool.input_schema)).length;
      }
    });
  }
  return tokenCount;
};

const getProjectSpecificRouter = async (
  req: any,
  configService: ConfigService
) => {
  // Check if there is project-specific configuration
  if (req.sessionId) {
    const project = await searchProjectBySession(req.sessionId);
    if (project) {
      const projectConfigPath = join(HOME_DIR, project, "config.json");
      const sessionConfigPath = join(
        HOME_DIR,
        project,
        `${req.sessionId}.json`
      );

      // First try to read sessionConfig file
      try {
        const sessionConfig = JSON.parse(await readFile(sessionConfigPath, "utf8"));
        if (sessionConfig && sessionConfig.Router) {
          return sessionConfig.Router;
        }
      } catch {}
      try {
        const projectConfig = JSON.parse(await readFile(projectConfigPath, "utf8"));
        if (projectConfig && projectConfig.Router) {
          return projectConfig.Router;
        }
      } catch {}
    }
  }
  return undefined; // Return undefined to use original configuration
};

const getUseModel = async (
  req: any,
  tokenCount: number,
  configService: ConfigService
): Promise<{ model: string; scenarioType: RouterScenarioType }> => {
  const projectSpecificRouter = await getProjectSpecificRouter(req, configService);
  const providers = configService.get<any[]>("providers") || [];
  const Router = projectSpecificRouter || configService.get("Router");

  // Log warning for bare model names in Router config (missing "Provider," prefix)
  const warnBareModelNames = (key: string, value: any) => {
    if (typeof value === "string" && !value.includes(",")) {
      req.log?.warn(
        `Router.${key} uses bare model name "${value}" without provider prefix. ` +
          `Consider using "ProviderName,${value}" format for deterministic routing.`
      );
    }
    if (Array.isArray(value)) {
      value.forEach((v) => {
        if (typeof v === "string" && !v.includes(",")) {
          req.log?.warn(`Router.${key} contains bare model name "${v}" without provider prefix.`);
        }
      });
    }
  };
  if (Router) {
    ["default", "background", "think", "webSearch", "image"].forEach((key) => {
      if (Router[key]) warnBareModelNames(key, Router[key]);
    });
  }

  if (req.body.model.includes(",")) {
    const [provider, model] = req.body.model.split(",");
    const finalProvider = providers.find(
      (p: any) => p.name.toLowerCase() === provider
    );
    const finalModel = finalProvider?.models?.find(
      (m: any) => m.toLowerCase() === model
    );
    if (finalProvider && finalModel) {
      return { model: `${finalProvider.name},${finalModel}`, scenarioType: 'default' };
    }
    return { model: req.body.model, scenarioType: 'default' };
  }

  // Check if a model has exceeded its daily token limit
  const isModelCapped = (provider: any, modelName: string): boolean => {
    if (provider.model_limits?.[modelName] !== undefined) {
      return getModelUsage(provider.name, modelName) >= provider.model_limits[modelName];
    }
    return false;
  };

  // Helper function to get a valid model from array or string
  const getValidModel = (modelConfig: string | string[] | undefined): string | null => {
    if (!modelConfig) return null;

    // If it's a string, check daily limit and failed status before returning
    if (typeof modelConfig === 'string') {
      let pName = "";
      let mName = "";
      if (modelConfig.includes(",")) {
        [pName, mName] = modelConfig.split(",");
      } else {
        mName = modelConfig;
        // No blind scan - bare model names without provider prefix are invalid
        // User must use "Provider,model" format in Router config
      }
      if (pName && mName) {
        const provider = providers.find((p: any) => p.name.toLowerCase() === pName.toLowerCase());
        if (provider && isModelFailed(getModelSpec(pName, mName))) return null;
        if (provider && isModelCapped(provider, mName)) return null;
      }
      return modelConfig;
    }

    // If it's an array, return the first valid model that is not in the failedModelsCache
    if (Array.isArray(modelConfig)) {
      for (const model of modelConfig) {
        if (typeof model === 'string' && model.trim()) {
          if (model.includes(',')) {
            const [providerName, modelName] = model.split(',');
            const provider = providers.find(p => p.name.toLowerCase() === providerName.toLowerCase());
            if (provider && provider.models.includes(modelName) && !isModelFailed(getModelSpec(providerName, modelName)) && !isModelCapped(provider, modelName)) {
              return model;
            }
          } else {
            // No blind scan - bare model names without provider prefix are invalid
            // User must use "Provider,model" format in Router config
            continue;
          }
        }
      }
    }

    return null;
  };

  if (
    req.body?.system?.length > 1 &&
    req.body?.system[1]?.text?.startsWith("<CCR-SUBAGENT-MODEL>")
  ) {
    const model = req.body?.system[1].text.match(
      /<CCR-SUBAGENT-MODEL>(.*?)<\/CCR-SUBAGENT-MODEL>/s
    );
    if (model) {
      req.body.system[1].text = req.body.system[1].text.replace(
        `<CCR-SUBAGENT-MODEL>${model[1]}</CCR-SUBAGENT-MODEL>`,
        ""
      );
      return { model: model[1], scenarioType: 'default' };
    }
  }
  // Use the background model for any Claude Haiku variant
  if (
    req.body.model?.includes("claude") &&
    req.body.model?.includes("haiku") &&
    Router?.background
  ) {
    req.log.info(`Using background model for ${req.body.model}`);
    const model = getValidModel(Router.background);
    if (model) {
      return { model, scenarioType: 'background' };
    }
  }
  // The priority of websearch must be higher than thinking.
  // Check if tools array has a web_search tool definition (CC initiating a search)
  const tools = Array.isArray(req.body.tools) ? req.body.tools : [];
  const hasWebSearchToolDef = tools.some((tool: any) => {
    return tool.type && tool.type.includes('web_search');
  });

  if (hasWebSearchToolDef && Router?.webSearch) {
    const model = getValidModel(Router.webSearch);
    if (model) {
      return { model, scenarioType: 'webSearch' };
    }
  }
  // if exits thinking, use the think model
  // Check if thinking has actual content (not empty object or empty string)
  const hasThinking = req.body.thinking === true ||
    (typeof req.body.thinking === 'object' && req.body.thinking !== null && req.body.thinking.type === 'enabled');
  if (hasThinking && Router?.think) {
    req.log.info(`Using think model for ${req.body.thinking}`);
    const model = getValidModel(Router.think);
    if (model) {
      return { model, scenarioType: 'think' };
    }
  }

  // Handle default case with array support
  const defaultModel = getValidModel(Router?.default);
  if (defaultModel) {
    return { model: defaultModel, scenarioType: 'default' };
  }

  // Fallback to original behavior if no valid model found
  const fallbackModel = Array.isArray(Router?.default) ? Router.default[0] : Router?.default;
  return { model: fallbackModel, scenarioType: 'default' };
};

export interface RouterContext {
  configService: ConfigService;
  tokenizerService?: TokenizerService;
  event?: any;
}

export type RouterScenarioType = 'default' | 'background' | 'think' | 'webSearch';

export interface RouterFallbackConfig {
  default?: string[];
  background?: string[];
  think?: string[];
  webSearch?: string[];
}

export const router = async (req: any, _res: any, context: RouterContext) => {
  const { configService, event } = context;
  // Normalize req.body.model if sent as an array
  if (req.body && Array.isArray(req.body.model)) {
    req.body.model = req.body.model[0];
  }
  // Parse sessionId from metadata.user_id
  if (req.body.metadata?.user_id) {
    try {
      // Try to parse as JSON string (Claude Code format)
      const userIdData = JSON.parse(req.body.metadata.user_id);
      if (userIdData.session_id) {
        req.sessionId = userIdData.session_id;
      }
    } catch {
      // Fallback: try legacy _session_ separator format
      const parts = req.body.metadata.user_id.split("_session_");
      if (parts.length > 1) {
        req.sessionId = parts[1];
      }
    }
  }
  const { messages, system = [], tools }: MessageCreateParamsBase = req.body;
  const rewritePrompt = configService.get("REWRITE_SYSTEM_PROMPT");
  if (
    rewritePrompt &&
    system.length > 1 &&
    system[1]?.text?.includes("<env>")
  ) {
    const prompt = await readFile(rewritePrompt, "utf-8");
    system[1].text = `${prompt}<env>${system[1].text.split("<env>").pop()}`;
  }

  try {
    // Try to get tokenizer config for the current model
    const [providerName, modelName] = (req.body.model || "").split(",");
    const tokenizerConfig = context.tokenizerService?.getTokenizerConfigForModel(
      providerName,
      modelName
    );

    // Use TokenizerService if available, otherwise fall back to legacy method
    let tokenCount: number;

    if (context.tokenizerService) {
      const result = await context.tokenizerService.countTokens(
        {
          messages: messages as MessageParam[],
          system,
          tools: tools as Tool[],
        },
        tokenizerConfig
      );
      tokenCount = result.tokenCount;
    } else {
      // Legacy fallback
      tokenCount = calculateTokenCount(
        messages as MessageParam[],
        system,
        tools as Tool[]
      );
    }

    let model;
    const customRouterPath = configService.get("CUSTOM_ROUTER_PATH");
    if (customRouterPath) {
      try {
        const customRouter = require(customRouterPath);
        req.tokenCount = tokenCount; // Pass token count to custom router
        model = await customRouter(req, configService.getAll(), {
          event,
        });
      } catch (e: any) {
        req.log.error(`failed to load custom router: ${e.message}`);
      }
    }
    if (!model) {
      const result = await getUseModel(req, tokenCount, configService);
      model = result.model;
      req.scenarioType = result.scenarioType;
    } else {
      // Custom router doesn't provide scenario type, default to 'default'
      req.scenarioType = 'default';
    }
    req.body.model = model;
    // Extract provider from model format (provider,model) - only if not already set
    if (model && model.includes(",")) {
      req.provider = model.split(",")[0];
    }
  } catch (error: any) {
    req.log.error(`Error in router middleware: ${error.message}`);
    const Router = configService.get("Router");
    const defaultVal = Router?.default;
    req.body.model = Array.isArray(defaultVal) ? defaultVal[0] : defaultVal;
    req.scenarioType = 'default';
    // Extract provider from model format (provider,model) - only if not already set
    if (!req.provider && req.body.model && req.body.model.includes(",")) {
      req.provider = req.body.model.split(",")[0];
    }
  }
  return;
};

// Memory cache for sessionId to project name mapping
// null value indicates previously searched but not found
// Uses LRU cache with max 1000 entries
const sessionProjectCache = new LRUCache<string, string>({
  max: 1000,
});

export const searchProjectBySession = async (
  sessionId: string
): Promise<string | null> => {
  // Check cache first
  if (sessionProjectCache.has(sessionId)) {
    const result = sessionProjectCache.get(sessionId);
    if (!result || result === '') {
      return null;
    }
    return result;
  }

  try {
    const dir = await opendir(CLAUDE_PROJECTS_DIR);
    const folderNames: string[] = [];

    // Collect all folder names
    for await (const dirent of dir) {
      if (dirent.isDirectory()) {
        folderNames.push(dirent.name);
      }
    }

    // Concurrently check each project folder for sessionId.jsonl file
    const checkPromises = folderNames.map(async (folderName) => {
      const sessionFilePath = join(
        CLAUDE_PROJECTS_DIR,
        folderName,
        `${sessionId}.jsonl`
      );
      try {
        const fileStat = await stat(sessionFilePath);
        return fileStat.isFile() ? folderName : null;
      } catch {
        // File does not exist, continue checking next
        return null;
      }
    });

    const results = await Promise.all(checkPromises);

    // Return the first existing project directory name
    for (const result of results) {
      if (result) {
        // Cache the found result
        sessionProjectCache.set(sessionId, result);
        return result;
      }
    }

    // Cache not found result (null value means previously searched but not found)
    sessionProjectCache.set(sessionId, '');
    return null; // No matching project found
  } catch (error) {
    // Note: req is not available here, using console.error as fallback
    console.error("Error searching for project by session:", error);
    // Cache null result on error to avoid repeated errors
    sessionProjectCache.set(sessionId, '');
    return null;
  }
};

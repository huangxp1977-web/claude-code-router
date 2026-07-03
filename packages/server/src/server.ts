import Server, { calculateTokenCount, TokenizerService } from "@thxp/llms";
import { readConfigFile, writeConfigFile, backupConfigFile } from "./utils";
import { join, resolve } from "path";
import fastifyStatic from "@fastify/static";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from "fs";
import { homedir } from "os";
import {
  getPresetDir,
  readManifestFromDir,
  manifestToPresetFile,
  saveManifest,
  isPresetInstalled,
  extractPreset,
  HOME_DIR,
  extractMetadata,
  loadConfigFromManifest,
  downloadPresetToTemp,
  getTempDir,
  findMarketPresetByName,
  getMarketPresets,
  type PresetFile,
  type ManifestFile,
  type PresetMetadata,
} from "@thxp/shared";
import fastifyMultipart from "@fastify/multipart";
import AdmZip from "adm-zip";

export const createServer = async (config: any): Promise<any> => {
  const server = new Server(config);
  const app = server.app;

  app.register(fastifyMultipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB
    },
  });

  app.post("/v1/messages/count_tokens", async (req: any, reply: any) => {
    const {messages, tools, system, model} = req.body;
    const tokenizerService = (app as any)._server!.tokenizerService as TokenizerService;

    // If model is specified in "providerName,modelName" format, use the configured tokenizer
    if (model && model.includes(",") && tokenizerService) {
      try {
        const [provider, modelName] = model.split(",");
        req.log?.info(`Looking up tokenizer for provider: ${provider}, model: ${modelName}`);

        const tokenizerConfig = tokenizerService.getTokenizerConfigForModel(provider, modelName);

        if (!tokenizerConfig) {
          req.log?.warn(`No tokenizer config found for ${provider},${modelName}, using default tiktoken`);
        } else {
          req.log?.info(`Using tokenizer config: ${JSON.stringify(tokenizerConfig)}`);
        }

        const result = await tokenizerService.countTokens(
          { messages, system, tools },
          tokenizerConfig
        );

        return {
          "input_tokens": result.tokenCount,
          "tokenizer": result.tokenizerUsed,
        };
      } catch (error: any) {
        req.log?.error(`Error using configured tokenizer: ${error.message}`);
        req.log?.error(error.stack);
        // Fall back to default calculation
      }
    } else {
      if (!model) {
        req.log?.info(`No model specified, using default tiktoken`);
      } else if (!model.includes(",")) {
        req.log?.info(`Model "${model}" does not contain comma, using default tiktoken`);
      } else if (!tokenizerService) {
        req.log?.warn(`TokenizerService not available, using default tiktoken`);
      }
    }

    // Default to tiktoken calculation
    const tokenCount = calculateTokenCount(messages, system, tools);
    return { "input_tokens": tokenCount }
  });

  // Add endpoint to read config.json with access control
  app.get("/api/config", async (req: any, reply: any) => {
    return await readConfigFile();
  });

  app.get("/api/transformers", async (req: any, reply: any) => {
    const transformers =
      (app as any)._server!.transformerService.getAllTransformers();
    const transformerList = Array.from(transformers.entries()).map(
          ([name, transformer]: any) => ({
            name,
            endpoint: transformer.endPoint || null,
          })
        ).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
        return { transformers: transformerList };
  });

  // Add endpoint to save config.json with access control
  app.post("/api/config", async (req: any, reply: any) => {
    const newConfig = req.body;

    // Backup existing config file if it exists
    const backupPath = await backupConfigFile();
    if (backupPath) {
      console.log(`Backed up existing configuration file to ${backupPath}`);
    }

    await writeConfigFile(newConfig);
    const server = (app as any)._server;
    if (server) {
      server.configService.reload();
      await server.transformerService.reload();
      server.providerService.reload();
      app.log.info('Config hot-reloaded successfully');
    }
    return { success: true, message: "Config saved successfully" };
  });

  // Determine auth headers based on URL and transformer
  function getAuthHeaders(baseUrl: string, apiKey: string, transformerName?: string): Record<string, string> {
    if (baseUrl.includes("generativelanguage.googleapis.com")) {
      return { "x-goog-api-key": apiKey };
    }
    if (transformerName === "Anthropic" || baseUrl.includes("anthropic")) {
      return {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
    }
    return { Authorization: `Bearer ${apiKey}` };
  }

  // Validate URL to prevent SSRF attacks
  function validatePingUrl(url: string): { valid: boolean; reason?: string } {
      try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();

        // Block localhost variants
        if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1") {
          return { valid: false, reason: "localhost is not allowed" };
        }

        // Block private IP ranges
        if (/^10\./.test(hostname) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
            /^192\.168\./.test(hostname) ||
            /^169\.254\./.test(hostname)) {
          return { valid: false, reason: "private IP is not allowed" };
        }

        return { valid: true };
      } catch {
        return { valid: false, reason: "invalid URL" };
      }
    }

      // Fetch available models from a provider's API
  app.post("/api/providers/fetch-models", async (req: any, reply: any) => {
    const { api_base_url, api_key, transformer } = req.body || {};

    if (!api_base_url || !api_key) {
      return reply.status(400).send({ error: "api_base_url and api_key are required" });
    }

    // Normalize URL: strip endpoint action suffixes, keep version prefixes like /v1, /v1beta
    function normalizeModelsUrl(baseUrl: string): string {
      let url = baseUrl.replace(/\/+$/, "");
      const suffixes = [
        "/chat/completions",
        "/messages",
        "/completions",
      ];
      for (const suffix of suffixes) {
        if (url.endsWith(suffix)) {
          url = url.slice(0, -suffix.length);
          break;
        }
      }
      // Gemini style: .../v1beta/models/ -> .../v1beta/models
      if (url.endsWith("/models/")) {
        url = url.slice(0, -1);
      }
      if (url.endsWith("/models")) {
        return url;
      }
      return url + "/models";
    }

    // Parse model list from various response formats
    // Returns array of { id, isFree? } objects for providers that support pricing info
    function extractModels(data: any, apiBaseUrl: string): Array<{ id: string; isFree?: boolean }> {
      let models: Array<{ id: string; isFree?: boolean }> = [];

      // OpenRouter format: includes pricing field
      if (apiBaseUrl.includes("openrouter.ai")) {
        if (Array.isArray(data?.data)) {
          models = data.data.map(item => ({
            id: item.id,
            isFree: item.pricing?.prompt === "0" && item.pricing?.completion === "0",
          }));
        }
      }
      // OpenAI format: { data: [{ id: "model-name" }] }
      else if (Array.isArray(data?.data)) {
        for (const item of data.data) {
          if (item.id) models.push({ id: item.id });
        }
      }
      // Gemini format: { models: [{ name: "models/model-name" }] }
      else if (Array.isArray(data?.models)) {
        for (const item of data.models) {
          const name = item.name || item.id || "";
          models.push({ id: name.replace(/^models\//, "") });
        }
      }
      // Direct array: [{ id: "xxx" }]
      else if (Array.isArray(data)) {
        for (const item of data) {
          if (typeof item === "string") models.push({ id: item });
          else if (item.id) models.push({ id: item.id });
        }
      }

      // 过滤非对话模型（图片生成、语音、向量等）
      const isNonChatModel = (id: string): boolean => {
        const lowerId = id.toLowerCase();
        return (
          // 通用黑名单：绝不可能用于普通对话的特定模型类型 (100%安全)
          lowerId.includes("dall-e") ||
          lowerId.includes("whisper") ||
          lowerId.includes("embedding") ||
          lowerId.includes("tts-") ||
          // 特定供应商累加黑名单：防止全局误杀
          (lowerId.includes("sensenova") && lowerId.includes("-u1")) ||  // 商汤 U1 生图系列
          (lowerId.includes("agnes") && (lowerId.includes("-image") || lowerId.includes("-video"))) || // Agnes 生图生视频系列
          // 全局纯生图引擎/平台
          lowerId.includes("stable-diffusion") ||
          lowerId.includes("flux") ||
          lowerId.includes("midjourney")
        );
      };

      return models.filter(m => !isNonChatModel(m.id));
    }

    try {
      let modelsUrl = normalizeModelsUrl(api_base_url);
      const isGemini = api_base_url.includes("generativelanguage.googleapis.com");
      const headers = getAuthHeaders(api_base_url, api_key, transformer);

      // Gemini uses ?key= URL parameter for /models endpoint
      if (isGemini) {
        const separator = modelsUrl.includes("?") ? "&" : "?";
        modelsUrl = `${modelsUrl}${separator}key=${api_key}`;
      }

      const fetchOptions: any = {
        method: "GET",
        headers: { ...headers, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
      };

      const httpsProxy =
        process.env.HTTPS_PROXY || process.env.https_proxy ||
        process.env.HTTP_PROXY || process.env.http_proxy;
      if (httpsProxy) {
        const { ProxyAgent } = await import("undici");
        fetchOptions.dispatcher = new ProxyAgent(new URL(httpsProxy).toString());
      }

      const response = await fetch(modelsUrl, fetchOptions);

      if (!response.ok) {
        // For Anthropic-type providers, retry with OpenAI-style /v1/models path
        if (response.status === 404 && modelsUrl.includes("/anthropic/")) {
          try {
            const openaiUrl = api_base_url.replace(/\/anthropic\/v1\/.*$/, "/v1/models");
            if (openaiUrl !== api_base_url) {
              const retryResp = await fetch(openaiUrl, fetchOptions);
              if (retryResp.ok) {
                const data = await retryResp.json();
                const models = extractModels(data, openaiUrl);
                if (models.length) return { models };
              }
            }
          } catch {}
        }
        const text = await response.text().catch(() => "");
                const status = response.status === 401 ? 400 : response.status;
                return reply.status(status).send({
                  error: `Provider returned ${response.status}: ${text.slice(0, 200)}`,
                });
              }

              const data = await response.json();
      const models = extractModels(data, modelsUrl);

      return { models };
    } catch (err: any) {
      const message = err?.name === "TimeoutError"
        ? "Request timed out after 15s"
        : err?.message || "Unknown error";
      return reply.status(502).send({ error: message });
    }
  });

  // Ping test for model speed
  app.post("/api/providers/ping-test", async (req: any, reply: any) => {
      const { api_base_url, api_key, model, transformer } = req.body || {};

      if (!api_base_url || !api_key || !model) {
        return reply.status(400).send({ error: "api_base_url, api_key and model are required" });
      }

      // Resolve environment variables in api_key and api_base_url
      const resolveEnv = (val: string): string => {
        if (typeof val !== "string") return val;
        return val.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g, (match, braced, unbraced) => {
          const varName = braced || unbraced;
          return process.env[varName] || match;
        });
      };
      const resolvedApiKey = resolveEnv(api_key);
      const resolvedApiBaseUrl = resolveEnv(api_base_url);

      // SSRF protection: block private/internal URLs
      const urlCheck = validatePingUrl(resolvedApiBaseUrl);
      if (!urlCheck.valid) {
        return reply.status(400).send({ error: urlCheck.reason });
      }

      // Setup proxy dispatcher if proxy env vars exist
      const httpsProxy =
        process.env.HTTPS_PROXY || process.env.https_proxy ||
        process.env.HTTP_PROXY || process.env.http_proxy;
      let dispatcher: any = undefined;
      if (httpsProxy) {
        const { ProxyAgent } = await import("undici");
        dispatcher = new ProxyAgent(new URL(httpsProxy).toString());
      }

      const start = Date.now();
      try {
        const headers = getAuthHeaders(resolvedApiBaseUrl, resolvedApiKey, transformer);
        const isAnthropic = transformer === "Anthropic" || resolvedApiBaseUrl.includes("anthropic") || resolvedApiBaseUrl.includes("freemodel") || resolvedApiBaseUrl.includes("agentrouter");

        // Build request body based on endpoint type
        let body: string;
        if (isAnthropic) {
          body = JSON.stringify({
            model,
            max_tokens: 10,
            messages: [{ role: "user", content: "hi" }],
          });
        } else {
          body = JSON.stringify({
            model,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 10,
          });
        }

        // Gemini-specific handling
        if (resolvedApiBaseUrl.includes("generativelanguage.googleapis.com")) {
          const geminiUrl = `${resolvedApiBaseUrl.replace(/\/+$/, "")}/${model}:streamGenerateContent?key=${resolvedApiKey}`;
          const geminiResp = await fetch(geminiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
            signal: AbortSignal.timeout(15000),
            ...(dispatcher ? { dispatcher } : {}),
          });
          const latency = Date.now() - start;
          if (geminiResp.ok) {
            return { latency, status: geminiResp.status };
          } else {
            const text = await geminiResp.text().catch(() => "");
            return reply.status(geminiResp.status === 401 ? 400 : geminiResp.status).send({
              error: `Gemini API returned ${geminiResp.status}: ${text.slice(0, 200)}`,
              latency: -1,
            });
          }
        }

        const response = await fetch(resolvedApiBaseUrl, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(15000),
          ...(dispatcher ? { dispatcher } : {}),
        });

        const latency = Date.now() - start;
        if (response.ok) {
          return { latency, status: response.status };
        } else {
          const text = await response.text().catch(() => "");
          const status = response.status === 401 ? 400 : response.status;
          return reply.status(status).send({
            error: `Provider returned ${response.status}: ${text.slice(0, 200)}`,
            latency: -1,
          });
        }
      } catch (err: any) {
        const message = err?.name === "TimeoutError"
          ? "Request timed out after 15s"
          : err?.message || "Unknown error";
        return reply.status(502).send({ error: message, latency: -1 });
      }
    });

  // Register static file serving with caching
  app.register(fastifyStatic, {
    root: join(__dirname, "..", "dist"),
    prefix: "/ui/",
    maxAge: "1h",
  });

  // Redirect /ui to /ui/ for proper static file serving
  app.get("/ui", async (_: any, reply: any) => {
    return reply.redirect("/ui/");
  });

  // Get log file list endpoint
  app.get("/api/logs/files", async (req: any, reply: any) => {
    try {
      const logDir = join(homedir(), ".claude-code-router", "logs");
      const logFiles: Array<{ name: string; path: string; size: number; lastModified: string }> = [];

      if (existsSync(logDir)) {
        const files = readdirSync(logDir);

        for (const file of files) {
          if (file.endsWith('.log')) {
            const filePath = join(logDir, file);
            const stats = statSync(filePath);

            logFiles.push({
              name: file,
              path: filePath,
              size: stats.size,
              lastModified: stats.mtime.toISOString()
            });
          }
        }

        // Sort by modification time in descending order
        logFiles.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      }

      return logFiles;
    } catch (error) {
      console.error("Failed to get log files:", error);
      reply.status(500).send({ error: "Failed to get log files" });
    }
  });

  // Safely resolve a log file path and validate it's within the logs directory
  const resolveLogFilePath = (filePath: string): string | null => {
    const logDir = resolve(homedir(), ".claude-code-router", "logs");
    const resolved = resolve(logDir, filePath);

    if (!resolved.startsWith(logDir)) {
      return null;
    }
    return resolved;
  };

  // Delete log file endpoint
  app.delete("/api/logs/files", async (req: any, reply: any) => {
    try {
      const filePath = (req.query as any).file as string;

      if (!filePath) {
        return reply.status(400).send({ error: "File path is required" });
      }

      const resolvedPath = resolveLogFilePath(filePath);
      if (!resolvedPath) {
        return reply.status(403).send({ error: "Access denied: invalid log file path" });
      }

      if (!existsSync(resolvedPath)) {
        return reply.status(404).send({ error: "Log file not found" });
      }

      if (!resolvedPath.endsWith('.log')) {
        return reply.status(403).send({ error: "Access denied: not a log file" });
      }

      unlinkSync(resolvedPath);

      return { success: true, message: "Log file deleted successfully" };
    } catch (error) {
      console.error("Failed to delete log file:", error);
      reply.status(500).send({ error: "Failed to delete log file" });
    }
  });

  // Get log content endpoint
  app.get("/api/logs", async (req: any, reply: any) => {
    try {
      const filePath = (req.query as any).file as string;
      let logFilePath: string;

      if (filePath) {
        const resolved = resolveLogFilePath(filePath);
        if (!resolved) {
          return reply.status(403).send({ error: "Access denied: invalid log file path" });
        }
        if (!resolved.endsWith('.log')) {
          return reply.status(403).send({ error: "Access denied: not a log file" });
        }
        logFilePath = resolved;
      } else {
        // If file path is not specified, use default log file path
        logFilePath = join(homedir(), ".claude-code-router", "logs", "app.log");
      }

      if (!existsSync(logFilePath)) {
        return [];
      }

      const logContent = readFileSync(logFilePath, 'utf8');
      const logLines = logContent.split('\n').filter(line => line.trim())

      return logLines;
    } catch (error) {
      console.error("Failed to get logs:", error);
      reply.status(500).send({ error: "Failed to get logs" });
    }
  });

  // Clear log content endpoint
  app.delete("/api/logs", async (req: any, reply: any) => {
    try {
      const filePath = (req.query as any).file as string;
      let logFilePath: string;

      if (filePath) {
        const resolved = resolveLogFilePath(filePath);
        if (!resolved) {
          return reply.status(403).send({ error: "Access denied: invalid log file path" });
        }
        if (!resolved.endsWith('.log')) {
          return reply.status(403).send({ error: "Access denied: not a log file" });
        }
        logFilePath = resolved;
      } else {
        // If file path is not specified, use default log file path
        logFilePath = join(homedir(), ".claude-code-router", "logs", "app.log");
      }

      if (existsSync(logFilePath)) {
        writeFileSync(logFilePath, '', 'utf8');
      }

      return { success: true, message: "Logs cleared successfully" };
    } catch (error) {
      console.error("Failed to clear logs:", error);
      reply.status(500).send({ error: "Failed to clear logs" });
    }
  });

  // Get presets list
  app.get("/api/presets", async (req: any, reply: any) => {
    try {
      const presetsDir = join(HOME_DIR, "presets");

      if (!existsSync(presetsDir)) {
        return { presets: [] };
      }

      const entries = readdirSync(presetsDir, { withFileTypes: true });
      const presetDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);

      const presets: Array<PresetMetadata & { installed: boolean; id: string }> = [];

      for (const dirName of presetDirs) {
        const presetDir = join(presetsDir, dirName);
        try {
          const manifestPath = join(presetDir, "manifest.json");
          const content = readFileSync(manifestPath, 'utf-8');
          const manifest = JSON.parse(content);

          // Extract metadata fields
          const { Providers, Router, PORT, HOST, API_TIMEOUT_MS, PROXY_URL, LOG, LOG_LEVEL, StatusLine, NON_INTERACTIVE_MODE, ...metadata } = manifest;

          presets.push({
            id: dirName,  // Use directory name as unique identifier
            name: metadata.name || dirName,
            version: metadata.version || '1.0.0',
            description: metadata.description,
            author: metadata.author,
            homepage: metadata.homepage,
            repository: metadata.repository,
            license: metadata.license,
            keywords: metadata.keywords,
            ccrVersion: metadata.ccrVersion,
            source: metadata.source,
            sourceType: metadata.sourceType,
            checksum: metadata.checksum,
            installed: true,
          });
        } catch (error) {
          console.error(`Failed to read preset ${dirName}:`, error);
        }
      }

      return { presets };
    } catch (error) {
      console.error("Failed to get presets:", error);
      reply.status(500).send({ error: "Failed to get presets" });
    }
  });

  // Get preset details
  app.get("/api/presets/:name", async (req: any, reply: any) => {
    try {
      const { name } = req.params;
      const presetDir = getPresetDir(name);

      if (!existsSync(presetDir)) {
        reply.status(404).send({ error: "Preset not found" });
        return;
      }

      const manifest = await readManifestFromDir(presetDir);
      const presetFile = manifestToPresetFile(manifest);

      // Return preset info, config uses the applied userValues configuration
      return {
        ...presetFile,
        config: loadConfigFromManifest(manifest, presetDir),
        userValues: manifest.userValues || {},
      };
    } catch (error: any) {
      console.error("Failed to get preset:", error);
      reply.status(500).send({ error: error.message || "Failed to get preset" });
    }
  });

  // Apply preset (configure sensitive information)
  app.post("/api/presets/:name/apply", async (req: any, reply: any) => {
    try {
      const { name } = req.params;
      const { secrets } = req.body;

      const presetDir = getPresetDir(name);

      if (!existsSync(presetDir)) {
        reply.status(404).send({ error: "Preset not found" });
        return;
      }

      // Read existing manifest
      const manifest = await readManifestFromDir(presetDir);

      // Save user input to userValues (keep original config unchanged)
      const updatedManifest: ManifestFile = { ...manifest };

      // Save or update userValues
      if (secrets && Object.keys(secrets).length > 0) {
        updatedManifest.userValues = {
          ...updatedManifest.userValues,
          ...secrets,
        };
      }

      // Save updated manifest
      await saveManifest(name, updatedManifest);

      return { success: true, message: "Preset applied successfully" };
    } catch (error: any) {
      console.error("Failed to apply preset:", error);
      reply.status(500).send({ error: error.message || "Failed to apply preset" });
    }
  });

  // Delete preset
  app.delete("/api/presets/:name", async (req: any, reply: any) => {
    try {
      const { name } = req.params;
      const presetDir = getPresetDir(name);

      if (!existsSync(presetDir)) {
        reply.status(404).send({ error: "Preset not found" });
        return;
      }

      // Recursively delete entire directory
      rmSync(presetDir, { recursive: true, force: true });

      return { success: true, message: "Preset deleted successfully" };
    } catch (error: any) {
      console.error("Failed to delete preset:", error);
      reply.status(500).send({ error: error.message || "Failed to delete preset" });
    }
  });

  // Get preset market list
  app.get("/api/presets/market", async (req: any, reply: any) => {
    try {
      // Use market presets function
      const marketPresets = await getMarketPresets();
      return { presets: marketPresets };
    } catch (error: any) {
      console.error("Failed to get market presets:", error);
      reply.status(500).send({ error: error.message || "Failed to get market presets" });
    }
  });

  // Install preset from GitHub repository by preset name
  app.post("/api/presets/install/github", async (req: any, reply: any) => {
    try {
      const { presetName } = req.body;

      if (!presetName) {
        reply.status(400).send({ error: "Preset name is required" });
        return;
      }

      // Check if preset is in the marketplace
      const marketPreset = await findMarketPresetByName(presetName);
      if (!marketPreset) {
        reply.status(400).send({
          error: "Preset not found in marketplace",
          message: `Preset '${presetName}' is not available in the official marketplace. Please check the available presets.`
        });
        return;
      }

      // Get repository from market preset
      if (!marketPreset.repo) {
        reply.status(400).send({
          error: "Invalid preset data",
          message: `Preset '${presetName}' does not have repository information`
        });
        return;
      }

      // Parse GitHub repository URL
      const githubRepoMatch = marketPreset.repo.match(/(?:github\.com[:/]|^)([^/]+)\/([^/\s#]+?)(?:\.git)?$/);
      if (!githubRepoMatch) {
        reply.status(400).send({ error: "Invalid GitHub repository URL" });
        return;
      }

      const [, owner, repoName] = githubRepoMatch;

      // Use preset name from market
      const installedPresetName = marketPreset.name || presetName;

      // Check if already installed BEFORE downloading
      if (await isPresetInstalled(installedPresetName)) {
        reply.status(409).send({
          error: "Preset already installed",
          message: `Preset '${installedPresetName}' is already installed. To update or reconfigure, please delete it first using the delete button.`,
          presetName: installedPresetName
        });
        return;
      }

      // Download GitHub repository ZIP file
      const downloadUrl = `https://github.com/${owner}/${repoName}/archive/refs/heads/main.zip`;
      const tempFile = await downloadPresetToTemp(downloadUrl);

      // Load preset to validate structure
      const preset = await loadPresetFromZip(tempFile);

      // Double-check if already installed (in case of race condition)
      if (await isPresetInstalled(installedPresetName)) {
        unlinkSync(tempFile);
        reply.status(409).send({
          error: "Preset already installed",
          message: `Preset '${installedPresetName}' was installed while downloading. Please try again.`,
          presetName: installedPresetName
        });
        return;
      }

      // Extract to target directory
      const targetDir = getPresetDir(installedPresetName);
      await extractPreset(tempFile, targetDir);

      // Read manifest and add repo information
      const manifest = await readManifestFromDir(targetDir);

      // Add repo information to manifest from market data
      manifest.repository = marketPreset.repo;
      if (marketPreset.url) {
        manifest.source = marketPreset.url;
      }

      // Save updated manifest
      await saveManifest(installedPresetName, manifest);

      // Clean up temp file
      unlinkSync(tempFile);

      return {
        success: true,
        presetName: installedPresetName,
        preset: {
          ...preset.metadata,
          installed: true,
        }
      };
    } catch (error: any) {
      console.error("Failed to install preset from GitHub:", error);
      reply.status(500).send({ error: error.message || "Failed to install preset from GitHub" });
    }
  });

  // Helper function: Load preset from ZIP
  async function loadPresetFromZip(zipFile: string): Promise<PresetFile> {
    const zip = new AdmZip(zipFile);

    // First try to find manifest.json in root directory
    let entry = zip.getEntry('manifest.json');

    // If not in root, try to find in subdirectories (handle GitHub repo archive structure)
    if (!entry) {
      const entries = zip.getEntries();
      // Find any manifest.json file
      entry = entries.find(e => e.entryName.includes('manifest.json')) || null;
    }

    if (!entry) {
      throw new Error('Invalid preset file: manifest.json not found');
    }

    const manifest = JSON.parse(entry.getData().toString('utf-8')) as ManifestFile;
    return manifestToPresetFile(manifest);
  }

  return server;
};

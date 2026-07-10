# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Router is a tool that routes Claude Code requests to different LLM providers. It uses a Monorepo architecture with four main packages:

- **cli** (`@thxp/claude-code-router`): Command-line tool providing the `ccr` command
- **server** (`@thxp/server`): Core server handling API routing and transformations
- **shared** (`@thxp/shared`): Shared constants, utilities, and preset management
- **ui** (`@thxp/ui`): Web management interface (React + Vite)

## Build Commands

### Build all packages
```bash
pnpm build
```

### Build individual packages
```bash
pnpm build:cli      # Build CLI
pnpm build:server   # Build Server
pnpm build:ui       # Build UI
pnpm build:shared   # Build Shared
pnpm build:core     # Build core llms package
```

### Development mode
```bash
pnpm dev:cli        # Develop CLI (ts-node)
pnpm dev:server     # Develop Server (ts-node)
pnpm dev:ui         # Develop UI (Vite)
pnpm dev:core       # Develop Core (ts-node)
pnpm dev:docs       # Develop Docs site
```

### Release
```bash
pnpm release        # Build and publish all packages
pnpm release:npm    # Release to npm only
pnpm release:docker # Release to docker only
```

## Core Architecture

### 1. Routing System (packages/core/src/utils/router.ts)

The routing logic determines which model a request should be sent to:

- **Default routing**: Uses `Router.default` configuration
- **Project-level routing**: Checks `~/.claude/projects/<project-id>/claude-code-router.json`
- **Custom routing**: Loads custom JavaScript router function via `CUSTOM_ROUTER_PATH`
- **Built-in scenario routing** (priority: background > think > default):
  - `background`: Background tasks / lightweight classifier requests (e.g., Claude Code's haiku safety classifier)
  - `think`: Thinking-intensive tasks (detected by `thinking.type === 'enabled'`)
  - Note: `webSearch` and `image` scenarios are defined in configuration types but not implemented in routing logic. Web search is handled by SearchAgent (agent system) instead.

Token calculation uses `tiktoken` (cl100k_base) to estimate request size.

**Fallback mechanism**: When a provider request fails (4xx/5xx, network error), CCR automatically rotates to the next model in the scenario's fallback list. Models are marked as failed for 15 minutes after an error. For `default` scenario, the model name is automatically replaced with the default provider's model when the incoming model is not supported.

### 2. Transformer System

The project uses the `@thxp/llms` package (external dependency) to handle request/response transformations. Transformers adapt to different provider API differences:

- Built-in transformers: `anthropic`, `deepseek`, `gemini`, `openrouter`, `groq`, `maxtoken`, `tooluse`, `reasoning`, `enhancetool`, `openai`, `openai.responses`, `vercel`, `vertex-claude`, `vertex-gemini`, `cerebras`, `stream-to-sync`, `customparams`, `cleancache`, `forcereasoning`, `sampling`, `maxcompletiontokens`, `toolargs`
- Custom transformers: Load external plugins via `transformers` array in `config.json`

Transformer configuration supports:
- Global application (provider level)
- Model-specific application
- Option passing (e.g., `max_tokens` parameter for `maxtoken`)

**Provider configuration guidelines**:
- **Anthropic-native providers** (e.g., xiaomimimo): Use `Anthropic` transformer, `api_base_url` points to `/v1/messages` endpoint
- **OpenAI-compatible providers** (e.g., Volcengine, dashscope, Agnes): Use `enhancetool` transformer, `api_base_url` must be the **full endpoint path** (e.g., `https://xxx.com/v1/chat/completions`). Do NOT add `OpenAI` transformer as it will duplicate the endpoint path

**stream_options auto-injection**: For all streaming requests to OpenAI-compatible providers (`/chat/completions` endpoints), `stream_options: { include_usage: true }` is automatically injected before sending the request. This ensures usage data is returned in the final chunk for `recordModelUsage` tracking.

### 3. Agent System (packages/server/src/agents/)

Agents are pluggable feature modules managed by `AgentsManager` class. They can:
- Detect whether to handle a request (`shouldHandle`)
- Modify requests (`reqHandler`)
- Provide custom tools (`tools`)

**AgentsManager methods**: `registerAgent()`, `getAgent()`, `getAllAgents()`, `getAllTools()`

Built-in agents:
- **imageAgent**: Handles image-related tasks
- **searchAgent**: Handles web search tasks using DuckDuckGo (free), Tavily, or Brave Search

Agent tool call flow:
1. Detect and mark agents in `preHandler` hook
2. Add agent tools to the request
3. Intercept tool call events in `onSend` hook
4. Execute agent tool and initiate new LLM request
5. Stream results back

### 4. SSE Stream Processing

The server uses custom Transform streams to handle Server-Sent Events:
- `SSEParserTransform`: Parses SSE text stream into event objects
- `SSESerializerTransform`: Serializes event objects into SSE text stream
- `rewriteStream`: Intercepts and modifies stream data (for agent tool calls)

### 5. Response Handling (packages/core/src/api/routes.ts)

**GZIP decompression**: Providers may return gzip-compressed responses. CCR detects `Content-Encoding: gzip` headers and decompresses automatically. If decompression fails (e.g., incorrect header), CCR falls back to reading the raw response text with a warning log.

**Header passthrough**: CCR preserves the original Claude Code client headers (User-Agent, anthropic-version, x-stainless-*, etc.) when forwarding requests to downstream providers. Only authentication headers (Authorization, x-api-key) and hop-by-hop headers (host, content-length) are overridden. This ensures downstream providers see the same client identity as the original request.

### 6. Configuration Management

Configuration file location: `~/.claude-code-router/config.json`

Key features:
- Supports environment variable interpolation (`$VAR_NAME` or `${VAR_NAME}`)
- JSON5 format (supports comments)
- Automatic backups (keeps last 3 backups)
- **Zero-downtime hot reload**: Saving config via UI `/api/config` endpoint triggers `configService.reload()`, `transformerService.reload()`, and `providerService.reload()` without full service restart

Configuration validation:
- If `Providers` are configured, both `HOST` and `APIKEY` must be set
- Otherwise listens on `0.0.0.0` without authentication

### 7. Logging System

Two separate logging systems:

**Server-level logs** (pino):
- Location: `~/.claude-code-router/logs/ccr-*.log`
- Content: HTTP requests, API calls, server events
- Configuration: `LOG_LEVEL` (fatal/error/warn/info/debug/trace)

**Application-level logs**:
- Location: `~/.claude-code-router/claude-code-router.log`
- Content: Routing decisions, business logic events

### 8. Plugin System

CCR supports configurable plugins for extensibility:
- Config format: `plugins` or `Plugins` array with `{name, enabled, options}`
- Built-in plugins: `token-speed` (token speed tracking)
- Plugins are registered via `registerPluginsFromConfig()` function
- Plugin manager imported from `@thxp/llms`

### 9. WebSearch Configuration

Web search is a top-level configuration feature:
```json
{
  "WebSearch": {
    "enabled": true,
    "activeProvider": "duckduckgo",
    "providers": {
      "duckduckgo": {},
      "tavily": { "apiKey": "..." },
      "brave": { "apiKey": "..." }
    }
  }
}
```
- DuckDuckGo: Free, no API key required
- Tavily/Brave: Paid, requires API key
- Web search is handled by `SearchAgent`, not router scenario routing

## CLI Commands

```bash
ccr start      # Start server
ccr stop       # Stop server
ccr restart    # Restart server
ccr status     # Show status
ccr code       # Execute claude command
ccr model      # Interactive model selection and configuration
ccr preset     # Manage presets (export, install, list, info, delete)
ccr install    # Install preset from GitHub marketplace
ccr activate   # Output shell environment variables (for integration)
ccr env        # Alias for activate
ccr ui         # Open Web UI
ccr statusline # Integrated statusline (reads JSON from stdin)
ccr <preset>   # Run with preset configuration (e.g., ccr my-preset "prompt")
```

### Preset Commands

```bash
ccr preset export <name>      # Export current configuration as a preset
ccr preset install <source>   # Install a preset from file, URL, or name
ccr preset list               # List all installed presets
ccr preset info <name>        # Show preset information
ccr preset delete <name>      # Delete a preset
ccr install <preset-name>     # Install preset from GitHub marketplace
```

## Subagent Routing

Use special tags in subagent prompts to specify models:
```
<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>
Please help me analyze this code...
```

## Preset System

The preset system allows users to save, share, and reuse configurations easily. Presets can be installed from local files, URLs, or the GitHub marketplace.

### Preset Structure

Presets are stored in `~/.claude-code-router/presets/<preset-name>/manifest.json`

Each preset contains:
- **Metadata**: name, version, description, author, keywords, etc.
- **Configuration**: Providers, Router, transformers, and other settings
- **Dynamic Schema** (optional): Input fields for collecting required information during installation
- **Required Inputs** (optional): Fields that need to be filled during installation (e.g., API keys)

### Dynamic Configuration System

The preset system supports complex dynamic configuration schemas:

**Input types**: `password`, `input`, `select`, `multiselect`, `confirm`, `editor`, `number`

**Dynamic options**: Options can be sourced from:
- Static array
- Providers list (auto-extract from preset's Providers)
- Models list (from specified provider)
- Custom source (reserved)

**Conditional fields**: Show fields only when conditions are met using `when` property with operators: `eq`, `ne`, `in`, `nin`, `gt`, `lt`, `gte`, `lte`, `exists`

**Variable interpolation**: Use `#{fieldId}` syntax in templates and config mappings

**Config mappings**: Map user input values to specific configuration locations with conditions

### Marketplace Integration

Presets can be installed from GitHub marketplace:
- `ccr install <preset-name>` - Downloads and installs preset from marketplace
- `marketplace.ts` - Fetches presets from remote registry URL
- `install-github.ts` - GitHub-specific installation logic

### Core Functions

Located in `packages/shared/src/preset/`:

- **export.ts**: Export current configuration as a preset directory
  - `exportPreset(presetName, config, options)`: Creates preset directory with manifest.json
  - Automatically sanitizes sensitive data (api_key fields become `{{field}}` placeholders)

- **install.ts**: Install and manage presets
  - `installPreset(preset, config, options)`: Install preset to config
  - `loadPreset(source)`: Load preset from directory
  - `listPresets()`: List all installed presets
  - `isPresetInstalled(presetName)`: Check if preset is installed
  - `validatePreset(preset)`: Validate preset structure

- **merge.ts**: Merge preset configuration with existing config
  - Handles conflicts using different strategies (ask, overwrite, merge, skip)

- **sensitiveFields.ts**: Identify and sanitize sensitive fields
  - Detects api_key, password, secret fields automatically
  - Replaces sensitive values with environment variable placeholders

- **schema.ts**: Dynamic configuration input handling
  - Complex input types (password, select, multiselect, editor, etc.)
  - Conditional field display with `when` conditions
  - Dynamic option sources (providers, models)
  - Variable interpolation

- **types.ts**: Type definitions
  - `RequiredInput`, `InputType`, `Condition`, `DynamicOptions`
  - `TemplateConfig`, `ConfigMapping`, `PresetIndexEntry`, `PresetRegistry`
  - `WebSearchConfig`

### Preset File Format

**manifest.json** (in preset directory):
```json
{
  "name": "my-preset",
  "version": "1.0.0",
  "description": "My configuration",
  "author": "Author Name",
  "keywords": ["openai", "production"],
  "Providers": [...],
  "Router": {...},
  "schema": [
    {
      "id": "apiKey",
      "type": "password",
      "label": "OpenAI API Key",
      "prompt": "Enter your OpenAI API key"
    }
  ]
}
```

### CLI Integration

The CLI layer (`packages/cli/src/utils/preset/`) handles:
- User interaction and prompts
- File operations
- Display formatting

Key files:
- `commands.ts`: Command handlers for `ccr preset` subcommands
- `export.ts`: CLI wrapper for export functionality
- `install.ts`: CLI wrapper for install functionality
- `install-github.ts`: GitHub marketplace installation
- `schema-input.ts`: Dynamic schema input handling

## Dependencies

```
cli → server → shared
server → @thxp/llms (core routing and transformation logic)
ui (standalone frontend application)
```

## Development Notes

1. **Node.js version**: Requires >= 20.0.0 (as per package.json)
2. **Package manager**: Uses pnpm (monorepo depends on workspace protocol)
3. **TypeScript**: All packages use TypeScript, but UI package is ESM module
4. **Build tools**:
   - cli/server/shared: esbuild
   - ui: Vite + TypeScript
5. **@thxp/llms**: This is an external dependency package providing the core server framework and transformer functionality, type definitions in `packages/server/src/types.d.ts`
6. **Code comments**: All comments in code MUST be written in English
7. **Documentation**: When implementing new features, add documentation to the docs project instead of creating standalone md files
8. **Git status checks**: Always use `git diff -w --stat` to see actual content changes (filters out CRLF/LF conversions). Use `git diff --name-only` for file lists, never `git status --short` which inflates counts with whitespace-only changes. Distinguish staged (`git diff --cached`) vs unstaged (`git diff`) vs untracked (`git ls-files --others --exclude-standard`).
9. **Build**: Do NOT run `pnpm build` or any build command. The user runs builds manually after reviewing changes.

## Configuration Example Locations

- Main configuration example: Complete example in README.md
- Custom router example: `custom-router.example.js`

## Testing Information

The project does not appear to have explicit test directories or test scripts in the current structure. The typical development workflow includes:
- Manual testing through the CLI and UI interfaces
- Integration testing via the `ccr` commands
- End-to-end testing by running the router with actual LLM providers

## Package Structure

The monorepo is organized as follows:
- `packages/cli/` - Command-line interface
- `packages/server/` - Core server functionality
- `packages/shared/` - Shared utilities and types
- `packages/ui/` - Web-based management interface
- `docs/` - Documentation site
- `blog/` - Blog content and documentation

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `huangxp1977-web/claude-code-router`; external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles map to their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.
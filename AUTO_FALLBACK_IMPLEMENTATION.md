# Multi-Model Auto-Fallback Implementation

## Overview
This feature enables the router to automatically retry failed requests using secondary models defined in the configuration. It ensures continuity when a primary provider encounters rate limits (429) or quota exhaustion (403).

## Changes Made

### 1. Type Definition Update (`packages/shared/src/preset/types.ts`)
- Updated `RouterConfig` interface to support array-based configurations for all scenarios:
  - `default?: string | string[]`
  - `background?: string | string[]`
  - `think?: string | string[]`
  - `longContext?: string | string[]`
  - `webSearch?: string | string[]`
  - `image?: string | string[]`

### 2. Initial Routing Logic (`packages/core/src/utils/router.ts`)
- Enhanced `getUseModel` to handle array configurations.
- Added `getValidModel` helper to pick the first available and valid model from a list.
- Maintains 100% backward compatibility with existing single-string configurations.

### 3. Automatic Retry Middleware (`packages/core/src/api/routes.ts`)
- Upgraded `handleFallback` function to support the new `Router` array format.
- **Smart Filtering**: The retry logic automatically identifies and skips the model that just failed, preventing redundant retries.
- **Chain Execution**: If multiple fallback models are provided, the system will try them in sequence until one succeeds or all fail.

## Configuration Example
To enable auto-fallback, update your `config.json` with a list of models:

```json
{
  "Router": {
    "default": [
      "provider-A,model-A",
      "provider-B,model-B"
    ]
  }
}
```
If `model-A` fails with a provider error, the router will silently switch to `model-B`.

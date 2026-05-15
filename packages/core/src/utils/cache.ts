// LRU cache for session usage

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, V>;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.cache = new Map<K, V>();
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }
    const value = this.cache.get(key) as V;
    // Move to end to mark as recently used
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  put(key: K, value: V): void {
    if (this.cache.has(key)) {
      // If key exists, delete it to update its position
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // If cache is full, delete the least recently used item
      const leastRecentlyUsedKey = this.cache.keys().next().value;
      if (leastRecentlyUsedKey !== undefined) {
        this.cache.delete(leastRecentlyUsedKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  values(): V[] {
    return Array.from(this.cache.values());
  }
}

export const sessionUsageCache = new LRUCache<string, Usage>(100);

// Cache for failed models - stores provider,model pairs that have failed
// This prevents retrying failed models on every request
export const failedModelsCache = new LRUCache<string, number>(1000);

export const markModelAsFailed = (modelSpec: string): void => {
  failedModelsCache.put(modelSpec, Date.now());
};

export const isModelFailed = (modelSpec: string): boolean => {
  return failedModelsCache.has(modelSpec);
};

export const clearFailedModels = (): void => {
  failedModelsCache.clear();
};

// Helper to get model spec string
export const getModelSpec = (provider: string, model: string): string => {
  return `${provider},${model}`;
};

import { UnifiedChatRequest } from "../types/llm";
import { Transformer, TransformerOptions } from "../types/transformer";

export interface CustomParamsOptions extends TransformerOptions {
  /**
   * Custom parameters to inject into the request body
   * Any key-value pairs will be added to the request
   * Supports: string, number, boolean, object, array
   */
  [key: string]: any;
}

/**
 * Transformer for injecting dynamic custom parameters into LLM requests
 * Allows runtime configuration of arbitrary parameters that get merged
 * into the request body using deep merge strategy
 */
export class CustomParamsTransformer implements Transformer {
  static TransformerName = "customparams";
  
  private options: CustomParamsOptions;

  constructor(options: CustomParamsOptions = {}) {
    this.options = options;
  }

  async transformRequestIn(
    request: UnifiedChatRequest
  ): Promise<UnifiedChatRequest> {
    // Create a copy of the request to avoid mutating the original
    const modifiedRequest = { ...request } as any;
    
    // Inject custom parameters with deep merge
    const parametersToInject = Object.entries(this.options);
    
    for (const [key, value] of parametersToInject) {
      if (key in modifiedRequest) {
        // If both are objects (and not arrays/null), perform deep merge
        if (this.isObject(modifiedRequest[key]) && this.isObject(value)) {
          modifiedRequest[key] = this.deepMergeObjects(modifiedRequest[key], value);
        } else {
          // For non-objects or mismatched types, overwrite with the new value
          modifiedRequest[key] = this.cloneValue(value);
        }
      } else {
        // Add new parameter
        modifiedRequest[key] = this.cloneValue(value);
      }
    }

    return modifiedRequest;
  }

  async transformResponseOut(response: Response): Promise<Response> {
    // Pass through response unchanged
    return response;
  }

  /**
   * Check if value is a plain object
   */
  private isObject(val: any): boolean {
    return typeof val === 'object' && val !== null && !Array.isArray(val);
  }

  /**
   * Deep merge two objects recursively
   */
  private deepMergeObjects(target: any, source: any): any {
    const result = { ...target };
    
    for (const [key, value] of Object.entries(source)) {
      if (key in result && 
          this.isObject(result[key]) && 
          this.isObject(value)) {
        result[key] = this.deepMergeObjects(result[key], value);
      } else {
        result[key] = this.cloneValue(value);
      }
    }
    
    return result;
  }

  /**
   * Clone a value to prevent reference issues
   */
  private cloneValue(value: any): any {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    
    if (Array.isArray(value)) {
      return value.map(item => this.cloneValue(item));
    }
    
    const cloned: any = {};
    for (const [key, val] of Object.entries(value)) {
      cloned[key] = this.cloneValue(val);
    }
    return cloned;
  }
}
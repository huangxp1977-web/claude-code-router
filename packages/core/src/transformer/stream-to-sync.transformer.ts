import { UnifiedChatRequest } from "../types/llm";
import { Transformer } from "../types/transformer";

/**
 * Transformer that forces streaming on requests and aggregates the response back to synchronous JSON.
 * Useful for models that ONLY support streaming (like some Air/Lite versions of Chinese models)
 * but where the client (like a specific tool call) expects a standard JSON response.
 */
export class StreamToSyncTransformer implements Transformer {
  static TransformerName = "stream-to-sync";

  async transformRequestIn(
    request: UnifiedChatRequest,
    context?: any
  ): Promise<UnifiedChatRequest> {
    // Store the original stream preference in context
    if (context) {
      context.originalStream = request.stream;
    }
    
    // Always force stream to true for the provider
    return {
      ...request,
      stream: true,
    };
  }

  async transformResponseOut(
    response: Response,
    context?: any
  ): Promise<Response> {
    const contentType = response.headers.get("Content-Type") || "";
    
    // If original request was explicitly streaming (true) or unspecified (undefined), don't aggregate
    // Only aggregate if original was explicitly non-streaming (false)
    if (context?.originalStream !== false || !contentType.includes("text/event-stream") || !response.body) {
      return response;
    }

    // Aggregate the stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let reasoningContent = "";
    let toolCalls: any[] = [];
    let lastResponse: any = null;
    let buffer = ""; // Buffer for partial lines

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        
        // Keep the last partial line in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          
          const dataStr = trimmed.replace("data: ", "");
          if (dataStr === "[DONE]") break;

          try {
            const data = JSON.parse(dataStr);
            lastResponse = data;
            
            const delta = data.choices?.[0]?.delta;
            if (delta) {
              if (delta.content) {
                fullContent += delta.content;
              }
              if (delta.reasoning_content) {
                reasoningContent += delta.reasoning_content;
              }
              if (delta.tool_calls) {
                delta.tool_calls.forEach((tc: any) => {
                  const index = tc.index;
                  if (!toolCalls[index]) {
                    toolCalls[index] = {
                      id: tc.id,
                      type: "function",
                      function: { name: tc.function?.name, arguments: "" }
                    };
                  }
                  if (tc.function?.arguments) {
                    toolCalls[index].function.arguments += tc.function.arguments;
                  }
                });
              }
            }
          } catch (e) {
            // Error parsing a supposedly complete line
            console.error("[StreamToSync] Error parsing line:", line, e);
          }
        }
      }

      // Reconstruct standard OpenAI-style Chat Completion response
      const syncResponse = {
        id: lastResponse?.id || "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: lastResponse?.created || Math.floor(Date.now() / 1000),
        model: lastResponse?.model || "unknown",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: fullContent || null,
              reasoning_content: reasoningContent || undefined,
              tool_calls: toolCalls.length > 0 ? toolCalls.filter(Boolean) : undefined,
            },
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
          },
        ],
        usage: lastResponse?.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      };

      return new Response(JSON.stringify(syncResponse), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      console.error("Error aggregating stream in StreamToSyncTransformer:", error);
      throw error;
    }
  }
}

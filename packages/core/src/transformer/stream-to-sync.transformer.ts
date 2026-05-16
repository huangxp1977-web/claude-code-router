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
    request: UnifiedChatRequest
  ): Promise<UnifiedChatRequest> {
    return {
      ...request,
      stream: true,
    };
  }

  async transformResponseOut(response: Response): Promise<Response> {
    const contentType = response.headers.get("Content-Type") || "";
    
    // If it's already JSON, nothing to do
    if (contentType.includes("application/json")) {
      return response;
    }

    // If it's not a stream, nothing we can do here
    if (!contentType.includes("text/event-stream") || !response.body) {
      return response;
    }

    // Aggregate the stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let toolCalls: any[] = [];
    let lastResponse: any = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

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
            // Ignore parse errors for partial chunks
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

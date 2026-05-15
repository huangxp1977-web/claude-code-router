import { UnifiedChatRequest } from "../types/llm";
import { Transformer } from "../types/transformer";

/**
 * ToolArgsTransformer
 * Converts tool call arguments between string and object formats.
 * Some providers (like OpenAI) expect a JSON string, while others
 * (like DashScope/some local models) expect a JSON object.
 */
export class ToolArgsTransformer implements Transformer {
  static TransformerName = "toolargs";

  async transformRequestIn(request: UnifiedChatRequest): Promise<UnifiedChatRequest> {
    if (!Array.isArray(request.messages)) return request;

    request.messages.forEach(msg => {
      if (Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach(tc => {
          if (tc.function && typeof tc.function.arguments === 'string') {
            try {
              // Attempt to parse string arguments into an object
              tc.function.arguments = JSON.parse(tc.function.arguments);
            } catch (e) {
              // If parsing fails, keep it as a string
            }
          }
        });
      }
    });

    return request;
  }
}

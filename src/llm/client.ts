/**
 * Port of src/llm.py (client): the project's single point that talks to the model.
 *
 * Today it uses Azure OpenAI; to switch provider just adjust getClient()
 * (any endpoint compatible with the OpenAI API works).
 */

import { AzureOpenAI } from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsBase,
} from "openai/resources/chat/completions";

import { config } from "../config.js";
import { getLogger } from "../logs.js";
import type { ChatMessage } from "../types.js";

const log = getLogger("llm");

let _client: AzureOpenAI | null = null;

export function getClient(): AzureOpenAI {
  if (_client === null) {
    _client = new AzureOpenAI({
      endpoint: config.azureOpenAIEndpoint,
      apiKey: config.azureOpenAIKey,
      apiVersion: config.azureOpenAIApiVersion,
      // Resilience: the SDK retries pre-stream with exponential backoff +
      // jitter and respects Retry-After on 429/5xx/connection errors. Generous
      // total timeout: large generations (a whole file in one response)
      // used to blow past the old 120s. Port note: the Node SDK has no separate
      // connect timeout (Python used connect=15s).
      timeout: config.llmTimeout * 1000,
      maxRetries: 5,
    });
  }
  return _client;
}

/** Discards the singleton (credential/timeout swap in tests and in /cd). */
export function resetClient(): void {
  _client = null;
}

export function chat(
  messages: ChatMessage[],
  tools: object[] | null = null,
  stream = false,
  signal?: AbortSignal,
): Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>> {
  // Observability: only metadata (model and number of messages), never content or key.
  log.debug(
    "chat model=%s messages=%d stream=%s tools=%d",
    config.azureOpenAILLM,
    messages.length,
    stream,
    (tools ?? []).length,
  );
  const params: ChatCompletionCreateParamsBase = {
    model: config.azureOpenAILLM,
    messages: messages as unknown as ChatCompletionCreateParamsBase["messages"],
  };
  if (tools && tools.length) {
    params.tools = tools as ChatCompletionCreateParamsBase["tools"];
  }
  // Optional generation cap: guards against responses that run out of control and
  // blow the timeout. Uses max_completion_tokens (modern parameter, valid
  // for reasoning models too). 0 = no cap.
  if (config.maxCompletionTokens > 0) {
    params.max_completion_tokens = config.maxCompletionTokens;
  }
  if (stream) {
    params.stream = true;
    params.stream_options = { include_usage: true };
  }
  return getClient().chat.completions.create(params, signal ? { signal } : undefined);
}

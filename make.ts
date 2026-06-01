#!/usr/bin/env bun

type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

type ContentPart = {
  type?: string;
  text?: string;
  image_url?: { url?: string };
};

type ChatMessage = {
  role: ChatRole;
  content?: string | ContentPart[] | null;
  name?: string;
};

type ChatCompletionRequest = {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  temperature?: number;
  max_tokens?: number;
  n?: number;
};

type OpenAIErrorType =
  | "invalid_request_error"
  | "not_found_error"
  | "server_error";

type PerplexityEvent = {
  final_sse_message?: boolean;
  text?: string;
};

const PERPLEXITY_ENDPOINT =
  "https://www.perplexity.ai/rest/sse/perplexity_ask";
const DEFAULT_MODEL = "perplexity-online";
const DEFAULT_PPLX_MODEL = "gpt54_thinking";

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? "3000"),
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [
          {
            id: DEFAULT_MODEL,
            object: "model",
            created: 0,
            owned_by: "perplexapi",
          },
        ],
      });
    }

    if (url.pathname !== "/v1/chat/completions") {
      return openAIError(
        `Unknown endpoint ${request.method} ${url.pathname}`,
        "not_found_error",
        404,
      );
    }

    if (request.method !== "POST") {
      return openAIError("Method not allowed", "invalid_request_error", 405);
    }

    let payload: ChatCompletionRequest;
    try {
      payload = (await request.json()) as ChatCompletionRequest;
    } catch {
      return openAIError("Request body must be valid JSON.");
    }

    const validationError = validateRequest(payload);
    if (validationError) {
      return openAIError(validationError);
    }

    const completionId = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = payload.model ?? DEFAULT_MODEL;
    const prompt = messagesToPrompt(payload.messages ?? []);

    if (payload.stream === true) {
      return streamChatCompletion({
        completionId,
        created,
        model,
        prompt,
        includeUsage: payload.stream_options?.include_usage === true,
      });
    }

    try {
      const content = await askPerplexity(prompt);
      const usage = estimateUsage(prompt, content);

      return Response.json({
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content,
              refusal: null,
              annotations: [],
            },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
        usage,
        service_tier: "default",
      });
    } catch (error) {
      return openAIError(errorMessage(error), "server_error", 502);
    }
  },
});

console.log(`Listening on http://localhost:${server.port}`);

function validateRequest(payload: ChatCompletionRequest): string | null {
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return "Missing required field: messages.";
  }

  if (payload.n !== undefined && payload.n !== 1) {
    return "Only n=1 is supported.";
  }

  for (const [index, message] of payload.messages.entries()) {
    if (
      message === null ||
      typeof message !== "object" ||
      typeof message.role !== "string"
    ) {
      return `Invalid message at index ${index}.`;
    }
  }

  return null;
}

function messagesToPrompt(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const content = messageContentToText(message.content);
      const name = message.name ? ` (${message.name})` : "";
      return `${message.role}${name}: ${content}`;
    })
    .join("\n\n");
}

function messageContentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }

      if (part.type === "image_url" && part.image_url?.url) {
        return `[image: ${part.image_url.url}]`;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

async function streamChatCompletion({
  completionId,
  created,
  model,
  prompt,
  includeUsage,
}: {
  completionId: string;
  created: number;
  model: string;
  prompt: string;
  includeUsage: boolean;
}): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };

      try {
        send({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              logprobs: null,
              finish_reason: null,
            },
          ],
          usage: null,
        });

        const content = await askPerplexity(prompt);

        send({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content },
              logprobs: null,
              finish_reason: null,
            },
          ],
          usage: null,
        });

        send({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              logprobs: null,
              finish_reason: "stop",
            },
          ],
          usage: null,
        });

        if (includeUsage) {
          send({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            usage: estimateUsage(prompt, content),
          });
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        send({
          error: {
            message: errorMessage(error),
            type: "server_error",
            param: null,
            code: null,
          },
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function askPerplexity(query: string): Promise<string> {
  const response = await fetch(PERPLEXITY_ENDPOINT, {
    method: "POST",
    headers: perplexityHeaders(),
    body: JSON.stringify(perplexityBody(query)),
  });

  if (!response.ok) {
    throw new Error(`Perplexity returned HTTP ${response.status}.`);
  }

  if (!response.body) {
    throw new Error("Perplexity response body is null.");
  }

  return readFinalAnswer(response.body);
}

function perplexityHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    "content-type": "application/json",
    origin: "https://www.perplexity.ai",
    pragma: "no-cache",
    referer: "https://www.perplexity.ai/",
    "user-agent":
      Bun.env.USER_AGENT ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "x-perplexity-request-endpoint": PERPLEXITY_ENDPOINT,
    "x-perplexity-request-reason": "ask-query-state-provider",
    "x-perplexity-request-try-number": "1",
    "x-request-id": crypto.randomUUID(),
  };

  if (Bun.env.PPLX_COOKIE) {
    headers.cookie = Bun.env.PPLX_COOKIE;
  }

  return headers;
}

function perplexityBody(query: string): unknown {
  const frontendUuid = crypto.randomUUID();

  return {
    params: {
      attachments: [],
      language: "en-US",
      timezone: Bun.env.TZ ?? "America/Toronto",
      search_focus: "internet",
      sources: ["web"],
      frontend_uuid: frontendUuid,
      mode: "copilot",
      model_preference: Bun.env.PPLX_MODEL_PREFERENCE ?? DEFAULT_PPLX_MODEL,
      is_related_query: false,
      is_sponsored: false,
      frontend_context_uuid: crypto.randomUUID(),
      prompt_source: "user",
      query_source: "home",
      is_incognito: false,
      local_search_enabled: false,
      use_schematized_api: true,
      send_back_text_in_streaming_api: false,
      supported_block_use_cases: [
        "answer_modes",
        "media_items",
        "knowledge_cards",
        "inline_entity_cards",
        "place_widgets",
        "finance_widgets",
        "prediction_market_widgets",
        "sports_widgets",
        "flight_status_widgets",
        "news_widgets",
        "shopping_widgets",
        "jobs_widgets",
        "search_result_widgets",
        "inline_images",
        "inline_assets",
        "placeholder_cards",
        "diff_blocks",
        "inline_knowledge_cards",
        "entity_group_v2",
        "refinement_filters",
        "canvas_mode",
        "maps_preview",
        "answer_tabs",
        "price_comparison_widgets",
        "preserve_latex",
        "generic_onboarding_widgets",
        "in_context_suggestions",
        "pending_followups",
        "inline_claims",
        "unified_assets",
        "workflow_steps",
        "background_agents",
      ],
      mentions: [],
      dsl_query: query,
      skip_search_enabled: true,
      is_nav_suggestions_disabled: false,
      source: "default",
      always_search_override: false,
      override_no_search: false,
      client_search_results_cache_key: frontendUuid,
      should_ask_for_mcp_tool_confirmation: true,
      browser_agent_allow_once_from_toggle: false,
      force_enable_browser_agent: false,
      supported_features: ["browser_agent_permission_banner_v1.1"],
      extended_context: false,
      version: "2.18",
    },
    query_str: query,
  };
}

async function readFinalAnswer(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const answer = extractAnswerFromBuffer(buffer);

      if (answer) {
        await reader.cancel();
        return answer;
      }
    }

    buffer += decoder.decode();

    const answer = extractAnswerFromBuffer(buffer);
    if (answer) {
      return answer;
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error("Perplexity stream ended without a final answer.");
}

function extractAnswerFromBuffer(buffer: string): string | null {
  for (const rawLine of buffer.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data: ")) {
      continue;
    }

    const payload = line.slice("data: ".length);
    let event: PerplexityEvent;

    try {
      event = JSON.parse(payload) as PerplexityEvent;
    } catch {
      continue;
    }

    if (event.final_sse_message === true && event.text) {
      return extractMarkdown(event.text);
    }
  }

  return null;
}

function extractMarkdown(input: string): string {
  const steps = JSON.parse(input) as unknown;

  if (!Array.isArray(steps)) {
    throw new TypeError("Expected the top-level Perplexity text to be an array.");
  }

  const finalStep = steps.find(
    (step) =>
      typeof step === "object" &&
      step !== null &&
      "step_type" in step &&
      step.step_type === "FINAL",
  );

  if (!finalStep || typeof finalStep !== "object" || !("content" in finalStep)) {
    throw new Error("Could not find a FINAL step.");
  }

  const content = finalStep.content as { answer?: unknown };
  if (typeof content.answer !== "string") {
    throw new Error("FINAL.content.answer is missing or is not a string.");
  }

  const parsedAnswer = JSON.parse(content.answer) as {
    structured_answer?: { type?: string; text?: unknown }[];
    answer?: unknown;
  };

  const markdown =
    parsedAnswer.structured_answer?.find((item) => item.type === "markdown")
      ?.text ?? parsedAnswer.answer;

  if (typeof markdown !== "string") {
    throw new Error("Could not find markdown text in the FINAL answer.");
  }

  return markdown;
}

function estimateUsage(prompt: string, completion: string) {
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(completion);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: 0,
      audio_tokens: 0,
    },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function openAIError(
  message: string,
  type: OpenAIErrorType = "invalid_request_error",
  status = 400,
): Response {
  return Response.json(
    {
      error: {
        message,
        type,
        param: null,
        code: null,
      },
    },
    { status },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

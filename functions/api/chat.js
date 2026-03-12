const DEFAULT_MODEL = "gemini-3-flash-preview";
const DEFAULT_BASE_URL = "https://api.linapi.net/v1/chat/completions";

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function normalizeCompletionsEndpoint(input) {
  const raw = String(input || "").trim();
  if (!raw) return DEFAULT_BASE_URL;
  const clean = raw.replace(/\/+$/g, "");
  if (/\/chat\/completions$/i.test(clean)) return clean;
  if (/\/v1$/i.test(clean)) return `${clean}/chat/completions`;
  return `${clean}/chat/completions`;
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("JSON解析失败");
  }
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const apiKey = context.env.LINAPI_API_KEY || context.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    return jsonResponse(500, {
      error: "服务端未配置LINAPI_API_KEY或OPENAI_API_KEY",
    });
  }

  try {
    const body = await readJsonBody(request);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) {
      return jsonResponse(400, { error: "messages不能为空" });
    }

    const endpoint = normalizeCompletionsEndpoint(
      context.env.LINAPI_BASE_URL || DEFAULT_BASE_URL
    );
    const model = body.model || context.env.LINAPI_MODEL || DEFAULT_MODEL;

    const upstreamResp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
        top_p: typeof body.top_p === "number" ? body.top_p : undefined,
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
      }),
    });

    const rawText = await upstreamResp.text();
    try {
      const parsed = rawText ? JSON.parse(rawText) : {};
      return jsonResponse(upstreamResp.status, parsed);
    } catch {
      return jsonResponse(upstreamResp.status || 500, {
        error: "上游接口返回非JSON",
        detail: rawText.slice(0, 300),
      });
    }
  } catch (error) {
    return jsonResponse(500, {
      error: "调用AI接口失败",
      detail: error?.message || String(error),
    });
  }
}

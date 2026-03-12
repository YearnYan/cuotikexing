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

function escapeXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildFallbackSvg(prompt) {
  const safe = escapeXml(prompt).slice(0, 120);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect x="24" y="24" width="464" height="464" fill="white" stroke="#333" stroke-width="3"/>
  <text x="256" y="120" text-anchor="middle" font-size="28" fill="#333">教育示意图</text>
  <line x1="70" y1="190" x2="442" y2="190" stroke="#333" stroke-width="2"/>
  <line x1="70" y1="260" x2="442" y2="260" stroke="#333" stroke-width="2"/>
  <line x1="70" y1="330" x2="442" y2="330" stroke="#333" stroke-width="2"/>
  <text x="80" y="390" font-size="18" fill="#555">${safe}</text>
</svg>`;
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
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
    const prompt = String(body.prompt || "").trim();
    if (!prompt) {
      return jsonResponse(400, { error: "prompt不能为空" });
    }

    const endpoint = normalizeCompletionsEndpoint(
      context.env.LINAPI_BASE_URL || DEFAULT_BASE_URL
    );
    const model = body.model || context.env.LINAPI_MODEL || DEFAULT_MODEL;
    const imagePrompt = `请基于以下描述生成可直接渲染的SVG黑白教育示意图，仅返回完整SVG代码：${prompt}`;

    const upstreamResp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: imagePrompt }],
        temperature: 0.4,
      }),
    });

    const rawText = await upstreamResp.text();
    let parsed = {};
    try {
      parsed = rawText ? JSON.parse(rawText) : {};
    } catch {
      return jsonResponse(502, {
        error: "上游接口返回非JSON",
        detail: rawText.slice(0, 300),
      });
    }

    const content = parsed?.choices?.[0]?.message?.content || "";
    const svgMatch = String(content).match(/<svg[\s\S]*<\/svg>/i);
    const svg = svgMatch ? svgMatch[0] : buildFallbackSvg(prompt);
    const dataUrl = `data:image/svg+xml;base64,${utf8ToBase64(svg)}`;

    return jsonResponse(200, {
      created: Math.floor(Date.now() / 1000),
      data: [{ url: dataUrl }],
    });
  } catch (error) {
    return jsonResponse(500, {
      error: "图片生成失败",
      detail: error?.message || String(error),
    });
  }
}

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const OpenAI = require('openai');

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT_DIR = __dirname;

function loadLocalEnv() {
    const envPath = path.join(ROOT_DIR, '.env.local');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex <= 0) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
            value = value.slice(1, -1);
        }
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}

loadLocalEnv();

const DEFAULT_MODEL = process.env.LINAPI_MODEL || 'gemini-3-flash-preview';
const API_KEY = process.env.LINAPI_API_KEY || process.env.OPENAI_API_KEY || '';
const RAW_BASE_URL = process.env.LINAPI_BASE_URL || 'https://api.linapi.net/v1/chat/completions';

function normalizeOpenAIBaseUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return 'https://api.linapi.net/v1';
    // OpenAI SDK 会自行拼接 /chat/completions，这里兼容用户直接填写完整端点的情况
    return raw
        .replace(/\/+$/g, '')
        .replace(/\/chat\/completions$/i, '');
}

const BASE_URL = normalizeOpenAIBaseUrl(RAW_BASE_URL);

const client = API_KEY
    ? new OpenAI({
        apiKey: API_KEY,
        baseURL: BASE_URL
    })
    : null;

const MIME_MAP = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
    res.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(text);
}

function escapeXml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
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

async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => {
            raw += chunk;
            if (raw.length > 2 * 1024 * 1024) {
                reject(new Error('请求体超过2MB限制'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                const body = raw ? JSON.parse(raw) : {};
                resolve(body);
            } catch (err) {
                reject(new Error('JSON解析失败'));
            }
        });
        req.on('error', reject);
    });
}

async function handleChat(req, res) {
    if (!client) {
        sendJson(res, 500, {
            error: '服务端未配置 LINAPI_API_KEY 或 OPENAI_API_KEY。请先配置再重试。'
        });
        return;
    }

    try {
        const body = await readJsonBody(req);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        if (!messages.length) {
            sendJson(res, 400, { error: 'messages 不能为空' });
            return;
        }

        const completion = await client.chat.completions.create({
            model: body.model || DEFAULT_MODEL,
            messages,
            temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
            top_p: typeof body.top_p === 'number' ? body.top_p : undefined,
            max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined
        });

        sendJson(res, 200, completion);
    } catch (error) {
        sendJson(res, 500, {
            error: '调用 AI 接口失败',
            detail: error.message || String(error)
        });
    }
}

async function handleImage(req, res) {
    if (!client) {
        sendJson(res, 500, {
            error: '服务端未配置 LINAPI_API_KEY 或 OPENAI_API_KEY。请先配置再重试。'
        });
        return;
    }

    try {
        const body = await readJsonBody(req);
        const prompt = String(body.prompt || '').trim();
        if (!prompt) {
            sendJson(res, 400, { error: 'prompt 不能为空' });
            return;
        }

        const imagePrompt = `请基于以下描述绘制黑白教育示意图，返回完整SVG代码且只返回SVG：${prompt}`;
        const completion = await client.chat.completions.create({
            model: body.model || DEFAULT_MODEL,
            messages: [{ role: 'user', content: imagePrompt }],
            temperature: 0.4
        });

        const content = completion?.choices?.[0]?.message?.content || '';
        const svgMatch = content.match(/<svg[\s\S]*<\/svg>/i);
        const svg = svgMatch ? svgMatch[0] : buildFallbackSvg(prompt);
        const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;

        sendJson(res, 200, {
            created: Math.floor(Date.now() / 1000),
            data: [{ url: dataUrl }]
        });
    } catch (error) {
        sendJson(res, 500, {
            error: '图片生成失败',
            detail: error.message || String(error)
        });
    }
}

function serveStatic(req, res, pathname) {
    let resolvedPath = pathname === '/' ? '/index.html' : pathname;
    resolvedPath = decodeURIComponent(resolvedPath);
    const normalized = path.normalize(resolvedPath).replace(/^(\.\.[/\\])+/, '');
    const fullPath = path.join(ROOT_DIR, normalized);

    if (!fullPath.startsWith(ROOT_DIR)) {
        sendText(res, 403, 'Forbidden');
        return;
    }

    fs.stat(fullPath, (statErr, stats) => {
        if (statErr || !stats.isFile()) {
            sendText(res, 404, 'File not found');
            return;
        }

        const ext = path.extname(fullPath).toLowerCase();
        const contentType = MIME_MAP[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(fullPath).pipe(res);
    });
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const pathname = parsedUrl.pathname;

    if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
        await handleChat(req, res);
        return;
    }

    if (req.method === 'POST' && pathname === '/api/image') {
        await handleImage(req, res);
        return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method Not Allowed');
        return;
    }

    serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
    console.log(`本地服务已启动: http://${HOST}:${PORT}`);
    console.log(`AI模型: ${DEFAULT_MODEL}`);
    console.log(`AI中转: ${BASE_URL}`);
});

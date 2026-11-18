// 统一的大模型调用层。
// 两种接口：
//   anthropic —— Claude 自己的 Messages API（claude.js）
//   openai    —— OpenAI 兼容的 /chat/completions，国内外大多数服务商都支持这个格式
// 服务商预设只是帮忙填好地址和常用模型名，模型名可以随便改，也可以点「获取模型列表」从服务商那里拉。

import { callClaude } from './claude.js';

export const PROVIDERS = {
  anthropic: {
    name: 'Anthropic Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'],
    keyHint: 'sk-ant-…，在 console.anthropic.com 创建',
  },
  openai: {
    name: 'OpenAI（ChatGPT）',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    keyHint: 'sk-…，在 platform.openai.com 创建',
  },
  gemini: {
    name: 'Google Gemini',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    keyHint: '在 aistudio.google.com 创建',
  },
  deepseek: {
    name: 'DeepSeek 深度求索',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyHint: 'sk-…，在 platform.deepseek.com 创建',
  },
  qwen: {
    name: '通义千问（阿里云百炼）',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyHint: 'sk-…，在阿里云百炼控制台创建',
  },
  moonshot: {
    name: 'Kimi（月之暗面）',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-32k',
    keyHint: 'sk-…，在 platform.moonshot.cn 创建',
  },
  zhipu: {
    name: '智谱 GLM',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyHint: '在 open.bigmodel.cn 创建',
  },
  doubao: {
    name: '豆包（火山方舟）',
    kind: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '',
    keyHint: '在火山方舟控制台创建；模型填控制台里的模型名或接入点 ID（ep-…）',
  },
  siliconflow: {
    name: '硅基流动 SiliconFlow',
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    keyHint: 'sk-…，在 cloud.siliconflow.cn 创建',
  },
  openrouter: {
    name: 'OpenRouter（一个 Key 用各家模型）',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4.1-mini',
    keyHint: 'sk-or-…，在 openrouter.ai 创建',
  },
  ollama: {
    name: 'Ollama（本机模型，免费）',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    keyHint: '本机不需要 Key，随便填或留空',
    noKey: true,
  },
  custom: {
    name: '其他（OpenAI 兼容接口）',
    kind: 'openai',
    baseUrl: '',
    model: '',
    keyHint: '填服务商给的 Key',
  },
};

export function providerOf(settings) {
  return PROVIDERS[settings.provider] || PROVIDERS.anthropic;
}

export function needsKey(settings) {
  return !providerOf(settings).noKey;
}

// 主入口：和 callClaude 的参数一样
export async function callLLM(settings, opts) {
  const p = providerOf(settings);
  const baseUrl = (settings.baseUrl || p.baseUrl || '').replace(/\/+$/, '');
  if (!settings.model) throw new Error('还没填模型名，点右上角「设置」填一下');
  if (p.kind === 'anthropic') {
    return callClaude({ ...opts, apiKey: settings.apiKey, model: settings.model, baseUrl });
  }
  if (!baseUrl) throw new Error('还没填接口地址，点右上角「设置」填一下');
  if (!settings.apiKey && !p.noKey) throw new Error('还没填 API Key，点右上角「设置」填一下');
  return callOpenAICompatible({ ...opts, apiKey: settings.apiKey, model: settings.model, baseUrl });
}

async function callOpenAICompatible({ apiKey, model, baseUrl, system, prompt, maxTokens = 8000, onText, signal }) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body = {
    model,
    stream: true,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  };

  let res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  // 有些新模型不认 max_tokens，要求 max_completion_tokens；有些老接口反过来。不认就换个写法再试一次。
  if (res.status === 400) {
    const errText = await res.text();
    if (/max_tokens|max_completion_tokens/i.test(errText)) {
      delete body.max_tokens;
      body.max_completion_tokens = maxTokens;
      res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } else {
      throw new Error(`400 ${errorMessage(errText)}`);
    }
  }
  if (!res.ok) throw new Error(friendlyError(res.status, errorMessage(await res.text())));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let stopReason = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.error) throw new Error(ev.error.message || JSON.stringify(ev.error));
      const choice = ev.choices?.[0];
      const piece = choice?.delta?.content; // 只要正文，不要推理模型的思考过程（reasoning_content）
      if (piece) {
        text += piece;
        onText?.(text);
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason;
    }
  }
  if (!text && stopReason === 'content_filter') throw new Error('服务商的内容审核拦下了这次请求');
  return { text, stopReason };
}

function errorMessage(raw) {
  try {
    const j = JSON.parse(raw);
    return j.error?.message || j.message || raw.slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}

function friendlyError(status, msg) {
  if (status === 401 || status === 403) return `API Key 不对或没有权限（${status}）${msg ? '：' + msg : ''}`;
  if (status === 404) return `接口地址或模型名不对（404）${msg ? '：' + msg : ''}`;
  if (status === 429) return `请求太频繁或额度用完（429）${msg ? '：' + msg : ''}`;
  return `${status} ${msg}`;
}

// 从服务商拉模型列表（OpenAI 兼容接口的 GET /models；Claude 用 /v1/models）
export async function listModels(settings) {
  const p = providerOf(settings);
  const baseUrl = (settings.baseUrl || p.baseUrl || '').replace(/\/+$/, '');
  const headers = {};
  let url;
  if (p.kind === 'anthropic') {
    url = `${baseUrl}/v1/models?limit=100`;
    headers['x-api-key'] = settings.apiKey;
    headers['anthropic-version'] = '2026-10-21';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else {
    url = `${baseUrl}/models`;
    if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(friendlyError(res.status, errorMessage(await res.text())));
  const j = await res.json();
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}

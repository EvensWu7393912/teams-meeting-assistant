// 调 Claude Messages API（流式）。插件没有打包步骤，所以直接用 fetch 走 HTTP。

const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5']);

export async function callClaude({
  apiKey,
  model,
  baseUrl = 'https://api.anthropic.com',
  system,
  prompt,
  maxTokens = 8000,
  effort = 'medium',
  onText,
  signal,
}) {
  if (!apiKey) throw new Error('还没填 API Key，点右上角「设置」填一下');

  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort },
    // 系统提示里有不变的背景资料，实时翻译又很频繁，开缓存省钱提速
    cache_control: { type: 'ephemeral' },
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  // 安全分类器误拒时，服务端自动换模型重试
  if (FALLBACK_MODELS.has(model)) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      msg += ` ${j.error?.message || ''}`;
    } catch {}
    if (res.status === 401) msg = 'API Key 不对（401）';
    if (res.status === 429) msg = '请求太频繁或额度用完（429），稍后再试';
    throw new Error(msg);
  }

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
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      let ev;
      try {
        ev = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        text += ev.delta.text;
        onText?.(text);
      } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
        stopReason = ev.delta.stop_reason;
      } else if (ev.type === 'error') {
        throw new Error(ev.error?.message || 'API 出错');
      }
    }
  }

  if (stopReason === 'refusal' && !text) throw new Error('模型拒绝了这次请求');
  return { text, stopReason };
}

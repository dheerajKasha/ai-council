const fetch = require('node-fetch');
let HttpsProxyAgent;
try {
  ({ HttpsProxyAgent } = require('https-proxy-agent'));
} catch (e) {
  HttpsProxyAgent = null;
}

const DEFAULT_AGENTS = ['Alice', 'Bob', 'Charlie'];
const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 15000);
const MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES || 1);
const BREAKER_FAILURE_THRESHOLD = Number(process.env.LLM_BREAKER_FAILURE_THRESHOLD || 3);
const BREAKER_COOLDOWN_MS = Number(process.env.LLM_BREAKER_COOLDOWN_MS || 30000);
const providerState = new Map();

function getAgentNames() {
  // Support overriding agent names via env: AGENTS="Gemini,Claude,GPT"
  if (process.env.AGENTS) return process.env.AGENTS.split(',').map(s => s.trim()).filter(Boolean);
  return DEFAULT_AGENTS;
}

function parseAgentProviderMap() {
  // Support JSON in AGENT_PROVIDER_MAP or simple CSV like "Gemini:openai,Claude:anthropic,GPT:openai"
  const raw = process.env.AGENT_PROVIDER_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const normalized = {};
    Object.keys(parsed).forEach(k => {
      normalized[k] = parsed[k] && String(parsed[k]).toLowerCase();
    });
    return normalized;
  } catch (e) {
    const map = {};
    raw.split(',').map(p => p.trim()).filter(Boolean).forEach(pair => {
      const [k, v] = pair.split(':').map(x => x && x.trim());
      if (k && v) map[k] = v;
    });
    // normalize provider names to lowercase
    Object.keys(map).forEach(k => { map[k] = map[k] && map[k].toLowerCase(); });
    return map;
  }
}

function getProviderState(provider) {
  if (!providerState.has(provider)) {
    providerState.set(provider, { failures: 0, openUntil: 0 });
  }
  return providerState.get(provider);
}

function registerProviderSuccess(provider) {
  const state = getProviderState(provider);
  state.failures = 0;
  state.openUntil = 0;
}

function registerProviderFailure(provider) {
  const state = getProviderState(provider);
  state.failures += 1;
  if (state.failures >= BREAKER_FAILURE_THRESHOLD) {
    state.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
  }
}

function assertProviderAvailable(provider) {
  const state = getProviderState(provider);
  if (state.openUntil && state.openUntil > Date.now()) {
    const waitMs = state.openUntil - Date.now();
    throw new Error(`Provider ${provider} is temporarily disabled after repeated failures. Retry in ${Math.ceil(waitMs / 1000)}s.`);
  }
}

async function fetchWithResilience(provider, url, options = {}, attempt = 0) {
  assertProviderAvailable(provider);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(url, withNetworkOptions(url, { ...options, signal: controller.signal }));
    if (resp.ok) {
      registerProviderSuccess(provider);
      return resp;
    }
    if (resp.status >= 500 && attempt < MAX_RETRIES) {
      registerProviderFailure(provider);
      return fetchWithResilience(provider, url, options, attempt + 1);
    }
    let errText = '';
    try {
      errText = await resp.text();
    } catch (e) {
      errText = '';
    }
    throw new Error(`HTTP ${resp.status} from ${provider}${errText ? `: ${errText.slice(0, 300)}` : ''}`);
  } catch (err) {
    registerProviderFailure(provider);
    if (attempt < MAX_RETRIES) {
      return fetchWithResilience(provider, url, options, attempt + 1);
    }
    if (err.name === 'AbortError') {
      throw new Error(`Request to ${provider} timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    }
    throw new Error(`Network error calling ${provider}: ${describeNetworkError(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function parseAnthropicText(data) {
  if (!data) return '';
  if (typeof data.completion === 'string') return data.completion;
  if (Array.isArray(data.content)) {
    return data.content
      .map(item => (item && item.type === 'text' && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return data.output || '';
}

function parseGeminiText(data) {
  if (!data) return '';
  if (Array.isArray(data.candidates) && data.candidates[0] && data.candidates[0].content) {
    if (typeof data.candidates[0].content === 'string') {
      return data.candidates[0].content;
    }
    const parts = data.candidates[0].content.parts;
    if (Array.isArray(parts)) {
      return parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
    }
  }
  return data.generated_text || (typeof data.output === 'string' ? data.output : '');
}

function isGeminiGenerateContentUrl(url) {
  return /:generateContent(?:\?|$)/i.test(url);
}

function ensureGeminiApiKeyInUrl(url, apiKey) {
  if (!apiKey || /[?&]key=/.test(url)) return url;
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}key=${encodeURIComponent(apiKey)}`;
}

function buildProxyAgent(url) {
  if (!HttpsProxyAgent) return null;
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (!proxy) return null;
  if (!/^https?:/i.test(url)) return null;
  try {
    return new HttpsProxyAgent(proxy);
  } catch (e) {
    return null;
  }
}

function withNetworkOptions(url, options = {}) {
  const next = { ...options };
  const agent = buildProxyAgent(url);
  if (agent) next.agent = agent;
  return next;
}

function describeNetworkError(err) {
  if (!err) return 'unknown network error';
  const parts = [];
  if (err.name) parts.push(err.name);
  if (err.code) parts.push(`code=${err.code}`);
  if (err.type) parts.push(`type=${err.type}`);
  if (err.errno) parts.push(`errno=${err.errno}`);
  if (err.message) parts.push(err.message);
  if (err.cause && err.cause.message) parts.push(`cause=${err.cause.message}`);
  return parts.join(' | ') || 'unknown network error';
}
function buildGeminiRequestBody(prompt, useGenerateContent) {
  return useGenerateContent
    ? { contents: [{ role: 'user', parts: [{ text: prompt }] }] }
    : { prompt: { text: prompt } };
}

function isGeminiModelNotFoundError(message) {
  const msg = String(message || '');
  return /HTTP 404 from gemini/i.test(msg) && /not found|not supported for generateContent/i.test(msg);
}

function pickGeminiGenerateContentModel(listData) {
  const models = Array.isArray(listData && listData.models) ? listData.models : [];
  const compatible = models.filter(m => {
    const methods = Array.isArray(m && m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
    return methods.includes('generateContent') && /^models\/gemini/i.test(String(m && m.name));
  });
  if (!compatible.length) return null;
  const priority = ['models/gemini-2.0-flash', 'models/gemini-1.5-flash'];
  for (const p of priority) {
    const hit = compatible.find(m => String(m.name).toLowerCase() === p);
    if (hit) return hit.name;
  }
  return compatible[0].name;
}

function replaceGeminiModelInUrl(url, modelName) {
  if (!url || !modelName) return url;
  const shortName = String(modelName).replace(/^models\//i, '');
  if (/\/models\/[^:/?]+(?=:(?:generate|generateContent))/i.test(url)) {
    return url.replace(/\/models\/[^:/?]+(?=:(?:generate|generateContent))/i, `/models/${shortName}`);
  }
  return url;
}

async function resolveGeminiUrlWithSupportedModel(currentUrl, apiKey) {
  const listUrl = ensureGeminiApiKeyInUrl('https://generativelanguage.googleapis.com/v1beta/models', apiKey);
  const listResp = await fetchWithResilience('gemini', listUrl, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  });
  const listData = await listResp.json();
  const selected = pickGeminiGenerateContentModel(listData);
  if (!selected) return null;
  return replaceGeminiModelInUrl(currentUrl, selected);
}

async function callLLMByProvider(provider, messages, model) {
  // messages: array of {role, content}
  model = model || process.env.LLM_MODEL || process.env.OPENAI_MODEL;
  provider = provider || (process.env.LLM_PROVIDER || 'openai');

  if (provider === 'openai' || provider === 'openai-compatible') {
    const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
    const apiUrl = process.env.OPENAI_API_URL || process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions';
    if (!apiKey) throw new Error('OpenAI API key not configured');
    const body = { model, messages, max_tokens: 200 };
    const resp = await fetchWithResilience(provider, apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    let data; try { data = await resp.json(); } catch(e) { const txt = await resp.text(); console.log(`[agents][raw][openai] non-json response status=${resp.status} body=${txt}`); return txt || ''; }
    const result = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || data.output || '';
    if (!result || String(result).trim() === '') console.log(`[agents][raw][openai] status=${resp.status} url=${apiUrl} data=${JSON.stringify(data)}`);
    return result || '';
  }

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const apiUrl = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
    if (!apiKey) throw new Error('Anthropic API key not configured');
    const prompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
    const body = {
      model: process.env.ANTHROPIC_MODEL || model,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    };
    const resp = await fetchWithResilience(provider, apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    let data; try { data = await resp.json(); } catch(e) { const txt = await resp.text(); console.log(`[agents][raw][anthropic] non-json response status=${resp.status} body=${txt}`); return txt || ''; }
    const result = parseAnthropicText(data);
    if (!result || String(result).trim() === '') console.log(`[agents][raw][anthropic] status=${resp.status} url=${apiUrl} data=${JSON.stringify(data)}`);
    return result || '';
  }

  if (provider === 'cohere') {
    const apiKey = process.env.COHERE_API_KEY;
    const apiUrl = process.env.COHERE_API_URL || 'https://api.cohere.ai/generate';
    if (!apiKey) throw new Error('Cohere API key not configured');
    const prompt = messages.map(m => m.content).join('\n');
    const body = { model: process.env.COHERE_MODEL || model, prompt, max_tokens: 200 };
    const resp = await fetchWithResilience(provider, apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    let data; try { data = await resp.json(); } catch(e) { const txt = await resp.text(); console.log(`[agents][raw][cohere] non-json response status=${resp.status} body=${txt}`); return txt || ''; }
    const result = (data.generations && data.generations[0] && data.generations[0].text) || data.output || '';
    if (!result || String(result).trim() === '') console.log(`[agents][raw][cohere] status=${resp.status} url=${apiUrl} data=${JSON.stringify(data)}`);
    return result || '';
  }

  if (provider === 'huggingface') {
    const apiKey = process.env.HUGGINGFACE_API_KEY;
    const modelPath = (process.env.HUGGINGFACE_MODEL || '').trim();
    if (!apiKey || !modelPath) throw new Error('Hugging Face key or model not configured');
    const apiUrl = (process.env.HUGGINGFACE_API_URL || 'https://api-inference.huggingface.co/models/') + modelPath;
    const prompt = messages.map(m => m.content).join('\n');
    const resp = await fetchWithResilience(provider, apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ inputs: prompt })
    });
    let data; try { data = await resp.json(); } catch(e) { const txt = await resp.text(); console.log(`[agents][raw][huggingface] non-json response status=${resp.status} body=${txt}`); return txt || ''; }
    const result = (Array.isArray(data) && data[0] && data[0].generated_text) ? data[0].generated_text : (data.generated_text || '');
    if (!result || String(result).trim() === '') console.log(`[agents][raw][huggingface] status=${resp.status} url=${apiUrl} data=${JSON.stringify(data)}`);
    return result || '';
  }

  if (provider === 'gemini' || provider === 'google') {
    const apiKey = process.env.GEMINI_API_KEY;
    const modelName = process.env.GEMINI_MODEL || model || 'gemini-1.5-flash';
    const configuredUrl = process.env.GEMINI_API_URL || `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
    if (!apiKey) throw new Error('Gemini API key not configured');
    let apiUrl = ensureGeminiApiKeyInUrl(configuredUrl, apiKey);
    const prompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
    const useGenerateContent = isGeminiGenerateContentUrl(apiUrl);
    let resp;
    try {
      resp = await fetchWithResilience(provider, apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildGeminiRequestBody(prompt, useGenerateContent))
      });
    } catch (err) {
      const msg = String(err && err.message ? err.message : '');
      const shouldFlipShape =
        (useGenerateContent && /unknown name[\s\S]*contents/i.test(msg)) ||
        (!useGenerateContent && /unknown name[\s\S]*prompt/i.test(msg));
      if (shouldFlipShape) {
        // Endpoint accepted auth but rejected the payload shape; retry once with the alternate shape.
        resp = await fetchWithResilience(provider, apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildGeminiRequestBody(prompt, !useGenerateContent))
        });
      } else if (isGeminiModelNotFoundError(msg)) {
        const resolvedUrl = await resolveGeminiUrlWithSupportedModel(apiUrl, apiKey);
        if (!resolvedUrl || resolvedUrl === apiUrl) throw err;
        apiUrl = ensureGeminiApiKeyInUrl(resolvedUrl, apiKey);
        resp = await fetchWithResilience(provider, apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildGeminiRequestBody(prompt, true))
        });
      } else {
        throw err;
      }
    }
    let data; try { data = await resp.json(); } catch(e) { const txt = await resp.text(); console.log(`[agents][raw][gemini] non-json response status=${resp.status} body=${txt}`); return txt || ''; }
    if (!data) return '';
    const result = parseGeminiText(data);
    if (!result || String(result).trim() === '') console.log(`[agents][raw][gemini] status=${resp.status} url=${apiUrl} data=${JSON.stringify(data)}`);
    return result || JSON.stringify(data);
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

function extractStance(text) {
  const s = String(text || '').trim();
  if (!s) return 'neutral';
  const jsonBlock = s.match(/\{[\s\S]*\}/);
  if (jsonBlock) {
    try {
      const parsed = JSON.parse(jsonBlock[0]);
      const raw = String(parsed.stance || '').toLowerCase().trim();
      if (raw === 'for' || raw === 'against' || raw === 'neutral') return raw;
    } catch (e) {
      // continue to regex parsing
    }
  }
  const labeled = s.match(/(?:^|\b)stance\s*[:=-]\s*(for|against|neutral)\b/i);
  if (labeled) return labeled[1].toLowerCase();
  const standalone = s.match(/\b(for|against|neutral)\b/i);
  return standalone ? standalone[1].toLowerCase() : 'neutral';
}

async function runAgent(agent, topic, opts = {}) {
  // Determine provider for this agent
  const map = parseAgentProviderMap();
  let provider = opts.provider || map[agent] || process.env.LLM_PROVIDER;
  provider = provider && provider.toLowerCase();
  // If no provider selected and no keys configured, fall back to deterministic stub
  const hasAnyKey = Boolean(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.COHERE_API_KEY || process.env.HUGGINGFACE_API_KEY || process.env.GEMINI_API_KEY);
  if (!provider && !hasAnyKey) {
    const stance = deterministicStance(agent, topic);
    const reasoning = `${agent} thinks ${stance} because it reasons about "${topic}" using simple heuristics.`;
    return { agent, stance, reasoning };
  }

  try {
    const prompt = `You are an agent named ${agent}. Given the topic: "${topic}", respond in JSON with keys "stance" (one of: for, against, neutral) and "reasoning" (one sentence).`;
    // Allow caller to pass custom messages (used by orchestrator to give decider the contributions summary)
    const messages = Array.isArray(opts.messages) ? opts.messages : [{ role: 'system', content: `You are ${agent}, concise.` }, { role: 'user', content: prompt }];
    const text = await callLLMByProvider(provider, messages, opts.model);
    // log provider + truncated raw response for debugging
    try {
      const preview = (text || '').toString().slice(0, 500).replace(/\n/g, ' ');
      console.log(`[agents] provider=${provider} agent=${agent} preview=${preview}`);
    } catch (e) {
      // ignore logging errors
    }
    const stance = extractStance(text);
    return { agent, stance, reasoning: (text || '').trim() };
  } catch (err) {
    return { agent, stance: 'neutral', reasoning: `Error calling ${provider}: ${err.message}` };
  }
}

function deterministicStance(agent, topic) {
  const s = (agent + '|' + topic).split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return s % 3 === 0 ? 'for' : s % 3 === 1 ? 'against' : 'neutral';
}

module.exports = { getAgentNames, runAgent, parseAgentProviderMap };




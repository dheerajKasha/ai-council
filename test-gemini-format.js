const assert = require('assert');
const Module = require('module');

const AGENTS_PATH = require.resolve('./agents');

function makeResponse({ status = 200, jsonData = {}, textData = '' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return jsonData;
    },
    async text() {
      return textData || JSON.stringify(jsonData);
    }
  };
}

async function withMockedFetch(mockFetch, fn) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'node-fetch') return mockFetch;
    return originalLoad.apply(this, arguments);
  };

  delete require.cache[AGENTS_PATH];
  const agents = require('./agents');
  try {
    return await fn(agents);
  } finally {
    Module._load = originalLoad;
    delete require.cache[AGENTS_PATH];
  }
}

async function testGenerateContentPayload() {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, options });
    return makeResponse({
      status: 200,
      jsonData: {
        candidates: [
          { content: { parts: [{ text: '{"stance":"for","reasoning":"ok"}' }] } }
        ]
      }
    });
  };

  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
  process.env.LLM_MAX_RETRIES = '0';

  await withMockedFetch(mockFetch, async (agents) => {
    const out = await agents.runAgent('Gemini', 'Topic A', { provider: 'gemini' });
    assert.equal(out.stance, 'for');
  });

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.ok(Array.isArray(body.contents), 'generateContent should send contents[] payload');
  assert.ok(/key=test-key/.test(calls[0].url), 'API key should be appended when missing in URL');
}

async function testLegacyGeneratePayload() {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, options });
    return makeResponse({
      status: 200,
      jsonData: {
        candidates: [{ content: '{"stance":"against","reasoning":"legacy-ok"}' }]
      }
    });
  };

  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generate';
  process.env.LLM_MAX_RETRIES = '0';

  await withMockedFetch(mockFetch, async (agents) => {
    const out = await agents.runAgent('Gemini', 'Topic B', { provider: 'gemini' });
    assert.equal(out.stance, 'against');
  });

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.ok(body.prompt && body.prompt.text, 'legacy generate should send prompt.text payload');
}

async function testAutoFlipPayloadOn400() {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, options });
    const body = JSON.parse(options.body);

    if (body.prompt) {
      return makeResponse({
        status: 400,
        textData: JSON.stringify([
          {
            error: {
              code: 400,
              message: 'Invalid JSON payload received. Unknown name "prompt": Cannot find field.'
            }
          }
        ])
      });
    }

    return makeResponse({
      status: 200,
      jsonData: {
        candidates: [
          { content: { parts: [{ text: '{"stance":"neutral","reasoning":"fallback-ok"}' }] } }
        ]
      }
    });
  };

  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_API_URL = 'https://some-proxy.local/v1/models/gemini:generate';
  process.env.LLM_MAX_RETRIES = '0';

  await withMockedFetch(mockFetch, async (agents) => {
    const out = await agents.runAgent('Gemini', 'Topic C', { provider: 'gemini' });
    assert.equal(out.stance, 'neutral');
  });

  assert.equal(calls.length, 2, 'should retry once with alternate payload shape');
  const firstBody = JSON.parse(calls[0].options.body);
  const secondBody = JSON.parse(calls[1].options.body);
  assert.ok(firstBody.prompt, 'first attempt should follow URL-derived legacy shape');
  assert.ok(secondBody.contents, 'second attempt should flip to modern shape after 400 unknown prompt');
}

async function testModelNotFoundFallbackViaListModels() {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, options });
    const method = (options && options.method) || 'GET';

    if (method === 'GET' && /\/v1beta\/models\?/.test(url)) {
      return makeResponse({
        status: 200,
        jsonData: {
          models: [
            { name: 'models/text-bison-001', supportedGenerationMethods: ['generateText'] },
            { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] }
          ]
        }
      });
    }

    if (/models\/gemini-1\.5-flash:generateContent/.test(url)) {
      return makeResponse({
        status: 404,
        textData: JSON.stringify({
          error: {
            code: 404,
            message: 'models/gemini-1.5-flash is not found for API version v1beta, or is not supported for generateContent.',
            status: 'NOT_FOUND'
          }
        })
      });
    }

    if (/models\/gemini-2\.0-flash:generateContent/.test(url)) {
      return makeResponse({
        status: 200,
        jsonData: {
          candidates: [
            { content: { parts: [{ text: '{"stance":"for","reasoning":"model-fallback-ok"}' }] } }
          ]
        }
      });
    }

    return makeResponse({ status: 500, textData: 'unexpected call in test' });
  };

  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
  process.env.LLM_MAX_RETRIES = '0';

  await withMockedFetch(mockFetch, async (agents) => {
    const out = await agents.runAgent('Gemini', 'Topic D', { provider: 'gemini' });
    assert.equal(out.stance, 'for');
  });

  assert.equal(calls.length, 3, 'should do initial call, listModels call, then fallback model call');
  assert.ok(/models\/gemini-1\.5-flash:generateContent/.test(calls[0].url), 'first call uses configured model');
  assert.ok(/\/v1beta\/models\?/.test(calls[1].url), 'second call fetches model list');
  assert.ok(/models\/gemini-2\.0-flash:generateContent/.test(calls[2].url), 'third call retries with supported model');
}

(async () => {
  try {
    await testGenerateContentPayload();
    await testLegacyGeneratePayload();
    await testAutoFlipPayloadOn400();
    await testModelNotFoundFallbackViaListModels();
    console.log('PASS: Gemini payload-format tests succeeded.');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  }
})();

require('dotenv').config();
const orchestrator = require('./orchestrator');
const agents = require('./agents');

(async () => {
  console.log('AGENTS:', process.env.AGENTS);
  console.log('AGENT_PROVIDER_MAP:', process.env.AGENT_PROVIDER_MAP);
  console.log('LLM_PROVIDER:', process.env.LLM_PROVIDER);
  console.log('Using env keys present:', {
    OPENAI: !!process.env.OPENAI_API_KEY,
    ANTHROPIC: !!process.env.ANTHROPIC_API_KEY,
    COHERE: !!process.env.COHERE_API_KEY,
    HUGGINGFACE: !!process.env.HUGGINGFACE_API_KEY
  });

  const topic = 'Cricket world cup T20 2026';
  const participants = ['Gemini','Claude'];
  const decider = 'GPT';

  console.log('\\nRunning discussion for topic:', topic);
  const res = await orchestrator.discuss(topic, { participants, decider });
  console.log('\\nRESULT:');
  console.log(JSON.stringify(res, null, 2));
})();
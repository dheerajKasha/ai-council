# AI Council - UI App (local runner)

Quick start

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and configure provider keys as needed.

3. Run the server:

```bash
npm start
```

4. Open http://localhost:3000 and enter a topic.

Notes
- If no provider is configured and no provider key is present, agents use deterministic stub responses so the discussion is reproducible.
- To enable real LLM calls, set `LLM_PROVIDER` and its matching provider key (for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`).
- `.env` is gitignored by default. Keep real keys only in local `.env`.

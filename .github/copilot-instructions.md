# GitHub Copilot / Agent Instructions for AI Council

Purpose
- Provide concise, actionable guidance so an AI coding agent can be immediately productive in this repository.

Repository layout
- Backend entrypoint: `server.js`
- Multi-agent orchestration: `orchestrator.js`
- Agent/provider runtime: `agents.js`
- Frontend UI: `public/index.html`, `public/app.js`, `public/style.css`
- Local smoke script: `test-discuss.js`
- Runtime config template: `.env.example`

How to work effectively
- Start by reading `README.md` and `README_UI.md`.
- Keep changes small and focused by concern: runtime (`agents.js`), orchestration (`orchestrator.js`), API/server (`server.js`), UI (`public/*`).
- Preserve deterministic fallback behavior when no provider keys are present.

Environment and configuration
- Copy `.env.example` to `.env` for local runs.
- Never commit real secrets. `.env` is ignored by git.
- Configure providers through env vars (`LLM_PROVIDER`, provider keys, optional `AGENT_PROVIDER_MAP`).

Validation
- Run app locally: `npm start`
- Run smoke script: `node test-discuss.js`
- For UI/API edits, verify `POST /api/discuss` and browser rendering both success and error responses.

Editing guidance
- Prefer explicit interfaces and small modules.
- Update docs (`README_UI.md` and `.env.example`) when changing env vars or behavior.
- Keep prompts and parser behavior deterministic enough for stable local testing.

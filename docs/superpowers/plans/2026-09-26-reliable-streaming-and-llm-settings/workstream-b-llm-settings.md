# Workstream B: LLM provider settings

Back to [overview](./overview.md).

## B1. Encryption module

**Goal.** Port sbf's AES-256-GCM helpers.

**Changes.**
- `apps/web/server/utils/encryption.ts`: `encrypt`/`decrypt` from `~/Documents/sbf/src/lib/encryption.ts` (HKDF-SHA256 per-value salt, 12 B IV, 16 B tag, `base64(salt‖iv‖tag‖ct)`). Drop the legacy no-salt fallback: there is no old data, and a silent fallback hides a wrong key.
- `apps/web/db/encrypted-text.ts`: the `encryptedText` Drizzle `customType` from sbf's `acra-schema.ts`. Key read from `ENCRYPTION_KEY`; missing key throws at first use with a clear message.
- `.env.example`, `docker-compose.yml` (web only): `ENCRYPTION_KEY`, with a generate command (`openssl rand -base64 32`).

**Verification.** vitest: round-trip; tampered ciphertext throws; wrong key throws; two encryptions of the same value differ.

## B2. Schema

**Goal.** Store providers and the active model selection.

**Changes.** `apps/web/db/schema.ts` + generated migration `0005`:
- `llm_providers`: `id` uuid, `owner_id`, `kind` enum (`anthropic | openai | google | deepseek | openrouter | openai_compatible`), `label`, `base_url` nullable, `api_key` `encryptedText` nullable (local Ollama needs none), `created_at`, `updated_at`.
- `app_settings` key `'llm'` (jsonb, existing table): `{ chat: { providerId, modelId }, quick: { providerId, modelId } }`, parsed by zod.

**Data structures.** `ProviderKind` union; `ModelRef { providerId; modelId }`; `LlmSettings { chat: ModelRef; quick: ModelRef }`.

**Verification.** `drizzle-kit generate` output reviewed; migration applies via the `drizzle-migrate` service.

## B3. Resolver and caller migration

**Goal.** One way to get a model; env is gone.

**Changes.**
- `apps/web/server/llm/model.ts`: replace `buildModel(spec)` with `resolveModel(role: 'chat' | 'quick'): Promise<ResolvedModel>` that reads settings + provider, decrypts, and builds with `createAnthropic | createOpenAI | createGoogleGenerativeAI | createDeepSeek` (`baseURL` passed when set), OpenRouter and OpenAI-compatible via `createOpenAI({ baseURL })`. Short in-memory cache invalidated on settings write.
- `ResolvedModel { model; spec: 'kind/modelId'; providerKind }` feeds `estimateCost` / `recordUsageSafely` (unknown models record tokens with cost null instead of guessing).
- Migrate all four callers (`chat.post.ts`, `llm/risk-report.ts`, `lib/contextual-news-angles.ts`, `api/algo/codegen.post.ts`) and delete the env reads. Algo codegen starts recording usage.
- Nitro plugin: if `llm_providers` is empty and `LLM_MODEL` / `*_API_KEY` env exist, import them once. Log that the env vars can be removed.
- No provider configured: chat returns a typed `llm_not_configured` error that the UI renders as "Add a model provider in Settings" with a link.

**Verification.** vitest: resolver builds each kind with the right key/baseURL (provider factories mocked); env import is idempotent; `llm_not_configured` path.

## B4. Settings API

**Goal.** CRUD for providers and model selection, keys never returned.

**Changes.** `server/api/settings/llm/`:
- `providers.get.ts` returns providers with `apiKeyHint` (`…last4`) and `hasKey`.
- `providers.post.ts`, `providers/[id].patch.ts` (key optional; omitted means unchanged), `providers/[id].delete.ts` (409 if referenced by the selection).
- `providers/[id]/test.post.ts`: tiny `generateText` ping with a 15 s timeout; also lists models when the provider exposes `/models` (OpenAI-compatible, OpenRouter, Anthropic, Google), to populate the model picker.
- `selection.get.ts` / `selection.put.ts`.
- `server/api/internal/llm-config.get.ts` (bearer only, excluded from the session middleware like other internal routes): returns decrypted `{ chat, quick }` with `kind, modelId, apiKey, baseUrl` for the api.

**Verification.** vitest per handler with zod validation cases; the GET response never contains the plaintext key (assert on the serialized body).

## B5. Settings page

**Goal.** A user can add a key and switch models without touching `.env`.

**Changes.**
- `app/pages/settings.vue` (new; add to nav). Providers list with add/edit in a Nuxt UI modal via `useOverlay`, delete confirm via the app modal. Provider kind preselects the default base URL; "Override base URL" reveals the field. "Test connection" button with result inline. Model selectors for Chat and Quick populated from the test/list call with free-text fallback.
- `AppShellHeader.vue`: model badge reads the selection from the API instead of `runtimeConfig.public.llmModel`; remove `NUXT_PUBLIC_LLM_MODEL`.
- Follow the `nuxt-ui` skill and the UI rules in CLAUDE.md (no one-option selectors, Esc closes modals).

**Verification.** `verify` skill: add a provider, test it, select it, send a chat; screenshot each modal state and the list edges.

## B6. Python api uses web-provided credentials

**Goal.** The debate and reflection use the same providers as chat.

**Changes.**
- `apps/api/app/services/agents/llm_config.py` (new): fetch `/api/internal/llm-config` at run start; typed `LlmRuntimeConfig`.
- `model_config.py` / `graph.py`: build TradingAgents config from it; wrap `tradingagents.llm.build_chat_model` so each run's models receive `api_key` and `base_url` explicitly (no `os.environ` writes).
- `reflection.py`: use the same config; fix the provider-name mismatch bug (`google_genai`/`litellm` vs `google`/`deepseek` comparisons) and the DeepSeek branch missing its key.
- `routers/agents.py:94` pricing: use the run's spec.
- Remove LLM env vars from the api service in `docker-compose.yml` and from `app/settings.py`.

**Verification.** pytest with a fake web endpoint: graph builder receives key/base URL per provider kind; reflection works for each kind. Runtime: a debate run completes with a key that exists only in the DB.

## B7. Manual

**Goal.** The README describes the new setup; no stale env instructions.

**Changes.** `README.md` (the project's manual): replace the `.env` LLM section (lines ~22-44) with "Configure a model provider in Settings", document `ENCRYPTION_KEY` and what happens if it changes (stored keys become unreadable; re-enter them), the one-time env import, the optional nginx `proxy_read_timeout` note, and update the e2e key note (line ~257). `.env.example`: remove `LLM_MODEL*`, `*_API_KEY`, `LLM_FORCE_TOOL_CHOICE` moves to a per-provider toggle only if still needed.

**Verification.** Read the README top to bottom against the running app.

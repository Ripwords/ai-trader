FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:22-alpine AS migrate
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml drizzle.config.ts ./
COPY db ./db
# drizzle-kit migrate hangs in non-TTY; use the programmatic migrator instead.
CMD ["node", "db/migrate.mjs"]

FROM node:22-alpine AS run
WORKDIR /app
# DEV MODE in container — see docs/superpowers/morning-questions.md "D-018".
# Short version: @mastra/core 1.32.1 declares ~30 npm-aliased deps
# (e.g. "@ai-sdk/provider-utils-v5":"npm:@ai-sdk/provider-utils@3.0.23")
# that pnpm only materializes inside its .pnpm tree. Nitro's prod build
# cannot trace these — they fail with ERR_MODULE_NOT_FOUND at runtime
# regardless of declaring aliases at the consumer level, because Mastra's
# transitive deps (e.g. zod-from-json-schema-v3 from @mastra/schema-compat)
# pull more aliases recursively. Dev mode reads from the live pnpm tree
# where the symlinks are intact. Trade-off: slightly larger memory + slower
# cold start. To migrate to prod build later, switch off Mastra (use
# Vercel AI SDK's streamText + tool() directly) — see morning-questions.
RUN apk add --no-cache python3 make g++ && corepack enable && corepack prepare pnpm@10 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
ENV HOST=0.0.0.0 NUXT_HOST=0.0.0.0
CMD ["pnpm", "dev", "--host", "0.0.0.0"]

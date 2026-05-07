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
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml drizzle.config.ts ./
COPY db ./db
CMD ["pnpm", "exec", "drizzle-kit", "migrate"]

FROM node:22-alpine AS run
WORKDIR /app
# We run Nuxt in DEV mode inside the container. Reason: @mastra/core uses
# ~30 npm-aliased deps (e.g. "@ai-sdk/provider-utils-v5":
# "npm:@ai-sdk/provider-utils@3.0.23") that pnpm only materializes inside
# its .pnpm tree. Nitro's prod build can't trace these aliases, leaving
# ERR_MODULE_NOT_FOUND at runtime. Dev mode reads from the live pnpm tree
# where the symlinks are intact. Acceptable for this single-user copilot.
RUN apk add --no-cache python3 make g++ && corepack enable && corepack prepare pnpm@10 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
ENV HOST=0.0.0.0 NUXT_HOST=0.0.0.0
CMD ["pnpm", "dev", "--host", "0.0.0.0"]

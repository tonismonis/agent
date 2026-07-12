# TanStack Start scaffold: CRM w/ Postgres (drizzle) + AI chat

Researched 2026-07-12 against `@tanstack/cli` **v0.69.5** (`npx --yes @tanstack/cli --version`). All claims from live CLI output + throwaway scaffolds in scratchpad (`scaffold-probe/probe` with examples, `probe-min` without).

## Recommended command

```sh
npx --yes @tanstack/cli create crm \
  --framework React \
  --add-ons drizzle,tanstack-query,ai \
  --no-examples --no-git -y \
  --target-dir ./crm
```

- `drizzle` **defaults to postgresql** (`--addon-details drizzle`: `options.database.default: "postgresql"`); no `--add-on-config` needed. `.cta.json` in scaffold confirms `{"drizzle":{"database":"postgresql"}}`.
- `ai` auto-pulls `store` dep (`--addon-details ai`: `"dependsOn": ["store"]`); don't list it.
- Tailwind always on; deprecated `--no-tailwind` ignored (CLI `--help`).
- Add `--no-examples` for prod repo (see tradeoff below). Keep one `--examples` scaffold around as reference for chat wiring.
- Optional flags: `--toolchain eslint|biome`, `--deployment railway|nitro|...`, `--package-manager pnpm`.

## Add-on triage (`--list-add-ons --framework React --json`, 36 total)

**Take**
- `drizzle` — "Type-safe SQL query builder for Postgres, SQLite, or MySQL", `exclusive: ["orm"]`, https://orm.drizzle.team/
- `ai` — "Streaming chat UI with model-agnostic backend (OpenAI, Anthropic, etc)". Deps added: `@tanstack/ai`, `@tanstack/ai-anthropic`, `-openai`, `-gemini`, `-ollama`, `@tanstack/ai-client`, `@tanstack/ai-react`, `streamdown`, `zod`
- `tanstack-query` — SSR-integrated query provider (`src/integrations/tanstack-query/root-provider.tsx`), pulls `@tanstack/react-router-ssr-query`

**Skip + why**
- `neon` (serverless PG host — only if not self-hosting), `convex`/`prisma`/`db`/`powersync` (conflict or redundant w/ drizzle; `convex` is `exclusive: ["database","orm"]`)
- auth (`clerk`, `better-auth`, `workos`) — single-tenant, decide later; all `exclusive: ["auth"]`
- `tRPC`/`oRPC`/`apollo-client` — server functions + server route handlers cover a chat-only UI
- `shadcn`, `form`, `table` — chat-only UI, no CRM grids/forms
- `mcp`, `sentry`, `posthog`, `t3env`, `compiler`, `storybook`, `strapi`, `shopify`, `paraglide` — orthogonal, add later if wanted
- deployments (`cloudflare`/`netlify`/`railway`/`nitro`) — pick at deploy time via `--deployment`

## Generated shape (probe w/ `--examples`)

```
crm/
├── .env.local              # DATABASE_URL + ANTHROPIC_API_KEY (gitignored)
├── drizzle.config.ts       # dialect: 'postgresql', out: './drizzle', schema: './src/db/schema.ts'
├── vite.config.ts          # devtools() + tailwindcss() + tanstackStart() + viteReact()
├── package.json            # imports: { "#/*": "./src/*" }; scripts db:generate|migrate|push|pull|studio
└── src/
    ├── db/
    │   ├── index.ts        # drizzle(process.env.DATABASE_URL!, { schema })  [node-postgres/pg]
    │   └── schema.ts       # pgTable example (todos)
    ├── integrations/tanstack-query/{root-provider,devtools}.tsx
    ├── router.tsx  routes/__root.tsx  routes/index.tsx
    └── routes/demo/        # ONLY with --examples:
        ├── api.ai.chat.ts          # POST handler: chat() -> SSE
        ├── ai-chat.tsx             # chat UI (Streamdown, useChat)
        └── drizzle.tsx             # createServerFn CRUD demo
```

Env conventions (`.env.local`, loaded by `drizzle.config.ts` via `dotenv` `['.env.local','.env']`):

```env
DATABASE_URL="postgresql://username:password@localhost:5432/mydb"
ANTHROPIC_API_KEY=
```

`--no-examples` tradeoff (verified by diffing probe vs probe-min): strips ALL `src/routes/demo/*`, demo components/hooks/data, guitar images — but **keeps** full dep set (all `@tanstack/ai-*`), `src/db/*`, `drizzle.config.ts`, query integration. So minimal scaffold ships zero chat code; you write the chat route yourself (pattern below).

## Where AI chat + agent/SQL layer slots in

File-based routing; server endpoints are just routes with `server.handlers` (demo `src/routes/demo/api.ai.chat.ts`):

```ts
export const Route = createFileRoute('/api/chat')({
  server: { handlers: { POST: async ({ request }) => {
    const { messages } = await request.json()
    const stream = chat({
      adapter: anthropicText('claude-haiku-4-5'),   // @tanstack/ai-anthropic
      tools: [/* server tools */], systemPrompts: [SYSTEM_PROMPT],
      agentLoopStrategy: maxIterations(5), messages, abortController,
    })
    return toServerSentEventsResponse(stream, { abortController })
  }}},
})
```

- **Agent/SQL layer**: tools via `toolDefinition({ name, inputSchema: z..., outputSchema })` then `.server(async (input) => db.select()...)` — server tool executes drizzle queries against `#/db`. Demo shows exact pattern in `src/lib/demo-guitar-tools.ts` (server tool `getGuitars` + client-rendered tool `recommendGuitar.client(...)` for rich UI cards — same trick works for CRM record cards in chat).
- **Client**: `createChatClientOptions({ connection: fetchServerSentEvents('/api/chat'), tools: clientTools(...) })` + `useChat` from `@tanstack/ai-react` (demo `src/lib/demo-ai-hook.ts`); render with `streamdown`.
- **Non-chat data access** (if ever needed): `createServerFn().handler()` colocated in route files, per demo `src/routes/demo/drizzle.tsx`.
- Suggested layout: `src/routes/api.chat.ts` (endpoint), `src/lib/chat-tools.ts` (toolDefs + drizzle), `src/lib/chat.ts` (client hook), `src/routes/index.tsx` (chat UI).

## Post-scaffold steps

1. `.env.local`: set real `DATABASE_URL`, `ANTHROPIC_API_KEY` (already gitignored)
2. Replace `src/db/schema.ts` todos with CRM schema (contacts, companies, notes, ...)
3. `npm run db:generate && npm run db:migrate` (scripts pre-wired to drizzle-kit; migrations land in `./drizzle/`)
4. Write `src/routes/api.chat.ts` + tools per pattern above; pin model + adapter (drop unused `@tanstack/ai-{openai,gemini,ollama}` deps)
5. Make chat the index route; gut default Header/Footer for chat-only shell
6. Optional: `npm i drizzle-zod` to derive tool schemas from drizzle tables
7. `npm run dev` (port 3000)

## Sources

- CLI output: `npx --yes @tanstack/cli create --help`, `--list-add-ons --framework React --json`, `--addon-details {drizzle,ai,tanstack-query} --framework React --json` (v0.69.5, 2026-07-12)
- Scaffold inspection: `.../scratchpad/scaffold-probe/{probe,probe-min}` (same flags ± `--examples`)
- Drizzle add-on link: https://orm.drizzle.team/ · Query: https://tanstack.com/query/latest

## Open questions

- `@tanstack/ai` pinned `latest` in scaffold — pin real versions? lib pre-1.0, API churn risk
- Persist chat history in PG (msgs table) or ephemeral? scaffold does neither
- Auth truly none, or `better-auth` now? single-tenant still needs login?
- LLM writes to DB (insert/update tools) allowed, or read-only SQL tools first?
- Deploy target? affects `--deployment` flag + `pg` vs serverless driver (neon)

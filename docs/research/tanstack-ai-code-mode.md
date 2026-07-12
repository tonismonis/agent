# TanStack AI + Code Mode — research notes

Date: 2026-07-12. Sources: official TanStack docs (tanstack.com/ai), TanStack blog, TanStack/ai GitHub source, npm registry. Every claim cited.

## 1. What is @tanstack/ai

- "TanStack AI is a lightweight, type-safe SDK for building production-ready AI experiences. Its framework-agnostic core provides type-safe tool/function calling, streaming responses, and first-class React and Solid integrations" — [Overview](https://tanstack.com/ai/latest/docs/getting-started/overview)
- Core packages ([Overview](https://tanstack.com/ai/latest/docs/getting-started/overview)):
  - `@tanstack/ai` — core: `chat()`, adapters, streaming, isomorphic tools, agent-loop strategies
  - `@tanstack/ai-client` — framework-agnostic headless chat client (message state, SSE/HTTP-stream connection adapters, automatic tool execution, approval flow)
  - `@tanstack/ai-react` — `useChat` hook, `InferChatMessages` typing (Solid/Vue/Svelte/Preact/Angular equivalents exist)
  - Provider adapters: `@tanstack/ai-openai`, `@tanstack/ai-anthropic`, `@tanstack/ai-gemini`, `@tanstack/ai-openrouter`, `@tanstack/ai-ollama`, `@tanstack/ai-groq`, `@tanstack/ai-grok`, `@tanstack/ai-bedrock`, `@tanstack/ai-fal`
- Maturity: all pre-1.0. npm latest as of 2026-07-12: `@tanstack/ai` 0.40.0, `@tanstack/ai-react` 0.16.4, `@tanstack/ai-anthropic` 0.16.1, `@tanstack/ai-code-mode` 0.3.6, `@tanstack/ai-isolate-node` 0.1.45, `@tanstack/ai-code-mode-skills` 0.3.9 (npm registry, `npm view`). Very active repo (last release 2026-07-06 per [GitHub README](https://github.com/TanStack/ai)). Expect breaking changes at 0.x.
- TanStack Start integration ([Quick Start](https://tanstack.com/ai/latest/docs/getting-started/quick-start)):
  - Server: file route `createFileRoute("/api/chat")` with a POST handler calling `chat({ adapter, messages })` and returning `toServerSentEventsResponse(stream)`. Docs show TanStack Start and Next.js variants; Start is "recommended!" ([Overview](https://tanstack.com/ai/latest/docs/getting-started/overview)).
  - Client: `useChat({ connection: fetchServerSentEvents("/api/chat") })`, `sendMessage(input)`.
  - No prebuilt chat component library — quick start builds the chat UI with plain React + Tailwind ([Quick Start](https://tanstack.com/ai/latest/docs/getting-started/quick-start)).

## 2. Code Mode

- What it is: "Code Mode lets an LLM write and execute TypeScript programs inside a secure sandbox" — model gets ONE tool, `execute_typescript`, and "instead of making one tool call at a time, the model writes a short script that orchestrates multiple tools with loops, conditionals, `Promise.all`, and data transformations — then returns a single result" — [Code Mode docs](https://tanstack.com/ai/latest/docs/code-mode/code-mode); announced in first-party blog [“Code Mode: Let Your AI Write Programs, Not Just Call Tools”](https://tanstack.com/blog/tanstack-ai-code-mode) (2026-04-08).
- Your tools are converted to typed `external_*` function stubs injected into the system prompt (`generateTypeStubs`), e.g. `external_fetchWeather({ location: string }): Promise<{...}>` — model sees exact input/output types ([Code Mode docs](https://tanstack.com/ai/latest/docs/code-mode/code-mode)).
- Where code executes: server-side (or edge) in a sandbox chosen by driver; TypeScript is stripped to JS via sucrase (`stripTypeScript`) before execution ([Code Mode docs](https://tanstack.com/ai/latest/docs/code-mode/code-mode)). Tool implementations do NOT run inside the sandbox: "Define your tools with `toolDefinition()` and provide a server-side implementation with `.server()`. These become the `external_*` functions available inside the sandbox" — sandbox calls bridge out to host tool code ([code-mode.md source, line 63](https://github.com/TanStack/ai/blob/main/docs/code-mode/code-mode.md)).
- API ([Code Mode docs](https://tanstack.com/ai/latest/docs/code-mode/code-mode)):
  ```ts
  import { createCodeMode } from "@tanstack/ai-code-mode";
  import { createNodeIsolateDriver } from "@tanstack/ai-isolate-node";
  const { tool, systemPrompt } = createCodeMode({
    driver: createNodeIsolateDriver(),
    tools: [fetchWeather],   // must have .server() impls
    timeout: 30_000,         // default 30000 ms
    memoryLimit: 128,        // MB, default 128
  });
  // then: chat({ adapter, systemPrompts: [..., systemPrompt], tools: [tool], messages })
  ```
  Result shape `CodeModeToolResult`: `{ success, result?, logs? (console.log capture), error? { message, name, line } }`. Lower-level: `createCodeModeTool`, `createCodeModeSystemPrompt`, `toolsToBindings`, `getSkillBindings` for dynamic bindings.
- Security model: "Generated code runs in an isolated environment (V8 isolate, QuickJS WASM, or Cloudflare Worker) with no access to the host file system, network, or process. The sandbox has configurable timeouts and memory limits"; fresh sandbox per execution, destroyed after ([Code Mode docs](https://tanstack.com/ai/latest/docs/code-mode/code-mode); [blog](https://tanstack.com/blog/tanstack-ai-code-mode)). Only capability exposed = your `external_*` tool bindings.
- Isolate drivers ([Isolate Drivers](https://tanstack.com/ai/latest/docs/code-mode/code-mode-isolates)):
  - `@tanstack/ai-isolate-node` — V8 isolates via `isolated-vm` native addon, Node 18+, JIT-fast; `memoryLimit`/`timeout`
  - `@tanstack/ai-isolate-quickjs` — QuickJS-in-WASM, "no native dependencies and runs anywhere JavaScript runs" (Node/browser/Deno/Bun/CF Workers); interpreted, slower; extra `maxStackSize`
  - `@tanstack/ai-isolate-cloudflare` — edge execution, tool impls stay server-side; needs `workerUrl` + `eval` unsafe binding; `maxToolRounds` (default 10)
  - All implement common `IsolateDriver` (`createContext()`/`execute()`); swappable. Blog: Deno/Docker/AWS Lambda drivers "in progress".
- Skills extension ([Code Mode with Skills](https://tanstack.com/ai/latest/docs/code-mode/code-mode-with-skills)): `@tanstack/ai-code-mode-skills` `codeModeWithSkills()` — LLM can `register_skill` working code into persistent storage; future requests run a cheap-model selection pass (docs suggest `claude-haiku-4-5` for it) and expose selected skills as first-class tools.
- Model compatibility: TanStack maintains a code-mode benchmark; `anthropic:claude-haiku-4-5` ranks #3 overall with ★★★, Acc 10/10, Comp 10/10 (highest comprehensiveness), 9.4s latency, 8.5k tokens — named a "strongest cloud pick" ([code-mode.md Model Compatibility](https://github.com/TanStack/ai/blob/main/docs/code-mode/code-mode.md)).

## 3. Tool execution model (general)

- Two-step isomorphic tools ([Tools guide](https://tanstack.com/ai/latest/docs/tools/tools), [source](https://github.com/TanStack/ai/blob/main/docs/tools/tools.md)): `toolDefinition({ name, description, inputSchema, outputSchema })` (Zod or raw JSON Schema; Zod gives inference) then `.server(async (input, { context, toolCallId, emitCustomEvent }) => ...)` and/or `.client((input) => ...)`.
- Execution: pass server impl to `chat()` → executes on server automatically; pass bare definition → client executes it (via `@tanstack/ai-client` automatic tool execution). Hybrid tools can have both. Agentic loop: model calls tool → executes → result returned as tool-result message → model continues.
- Server tools get `ToolExecutionContext` with request-scoped `context` (auth, DB clients) and `emitCustomEvent` for streaming typed progress to the client ([Tools guide](https://tanstack.com/ai/latest/docs/tools/tools)).
- Approval: `needsApproval: true` on a definition pauses execution in `approval-requested` state; client responds via `addToolApprovalResponse({ id, approved })`; tool executes only if approved ([Tool Approval](https://tanstack.com/ai/latest/docs/tools/tool-approval), [source](https://github.com/TanStack/ai/blob/main/docs/tools/tool-approval.md)). Default (no flag) = automatic immediate execution ([Overview](https://tanstack.com/ai/latest/docs/getting-started/overview): "Both server and client tools execute automatically").
- Tool-call lifecycle states: `awaiting-input` → `input-streaming` → `input-complete` → (`approval-requested`/`approval-responded`) → output on `part.output` + sibling `tool-result` part `complete`/`error` ([Tools guide](https://tanstack.com/ai/latest/docs/tools/tools)).

## 4. Generative UI story

- No "model emits arbitrary JSX" feature and no shipped chat-component library ([Quick Start](https://tanstack.com/ai/latest/docs/getting-started/quick-start) builds UI by hand). The generative-UI pattern is structured, developer-owned rendering:
  - Messages are arrays of typed `parts`; tool-call parts carry literal tool `name` + fully typed `input`/`output` (`InferChatMessages`), so you render a custom component per tool (e.g. a chart component for a `queryStats` tool's output) ([Tools guide, Type Safety Benefits](https://tanstack.com/ai/latest/docs/tools/tools)).
  - Client tools (`.client()`) let the model directly drive browser-side effects/UI state ([Client Tools](https://tanstack.com/ai/latest/docs/tools/client-tools)).
  - Custom events: server tools `emitCustomEvent(...)` → client `onCustomEvent` callback on `useChat` for live progress UI ([Tools guide](https://tanstack.com/ai/latest/docs/tools/tools); [Code Mode client integration](https://tanstack.com/ai/latest/docs/code-mode/client-integration)).
  - Code Mode streams its own custom events (`code_mode:execution_started`, `code_mode:console`, `code_mode:external_call`, `code_mode:external_result`, `code_mode:external_error`, each keyed by `toolCallId`) so you can show live "agent is running code" panels; docs example builds `MessageList` + `CodeExecutionPanel` components by hand ([client integration](https://tanstack.com/ai/latest/docs/code-mode/client-integration)).

## 5. Provider support / Anthropic

- `@tanstack/ai-anthropic`: `anthropicText(model, config?)` (reads `ANTHROPIC_API_KEY`) or `createAnthropicChat(model, apiKey, config?)`; supports streaming via SSE, tools, extended thinking (streamed `thinking` chunks), prompt caching, structured output, sampling params, plus Anthropic-native tools (`webSearchTool`, `codeExecutionTool`, `bashTool`, `memoryTool`, etc.) ([Anthropic adapter docs](https://tanstack.com/ai/latest/docs/adapters/anthropic)).
- `claude-haiku-4-5` is a first-class typed model: present in `ANTHROPIC_MODELS` in `packages/typescript/ai-anthropic/src/model-meta.ts` (verified in published `@tanstack/ai-anthropic@0.16.1`; typed model union includes `claude-haiku-4-5`, `claude-sonnet-4-5/4-6/5`, `claude-opus-4-x`, `claude-fable-5`). Model names autocomplete/type-check via adapter's `selectedModel` ([Runtime Adapter Switching](https://tanstack.com/ai/latest/docs/guides/runtime-adapter-switching)).
- Anthropic also reachable via `@tanstack/ai-openrouter` and `@tanstack/ai-bedrock` ([Overview](https://tanstack.com/ai/latest/docs/getting-started/overview)).

## 6. Fit: SQL/drizzle agent in TanStack Start, immediate writes

- Architecture that matches the docs: TanStack Start `/api/chat` server route → `chat({ adapter: anthropicText("claude-haiku-4-5"), ... })` → SSE to `useChat`. DB access lives in `.server()` tool implementations (drizzle client passed via runtime `context` — exactly the documented pattern, `context.db` in the Tools guide example) ([Tools guide](https://tanstack.com/ai/latest/docs/tools/tools); [Quick Start](https://tanstack.com/ai/latest/docs/getting-started/quick-start)).
- Code Mode fits the "agent writes code that runs SQL" shape with one crucial nuance: the sandbox has NO network/fs/process access, so drizzle/pg cannot run inside it. The agent's TypeScript orchestrates `external_*` tools; the actual SQL executes in your `.server()` implementations on the host ([Code Mode docs](https://tanstack.com/ai/latest/docs/code-mode/code-mode)). So you expose e.g. `runQuery`/`runStatement` (or finer-grained drizzle-backed tools) and the model composes them with loops/`Promise.all`/JS math. TanStack's own benchmark task is multi-table SQL-ish aggregation and claude-haiku-4-5 aces it ([Model Compatibility](https://github.com/TanStack/ai/blob/main/docs/code-mode/code-mode.md)).
- Immediate writes: default behavior — tools execute automatically unless `needsApproval: true` ([Overview](https://tanstack.com/ai/latest/docs/getting-started/overview); [Tool Approval](https://tanstack.com/ai/latest/docs/tools/tool-approval)). Note the flip side: the docs do not describe any approval gating for `external_*` calls made inside Code Mode scripts — a write-capable tool passed to `createCodeMode` executes whenever generated code calls it.
- Requires Node runtime for `@tanstack/ai-isolate-node` (`isolated-vm` native addon, Node 18+); on serverless/edge use QuickJS driver instead ([Isolate Drivers](https://tanstack.com/ai/latest/docs/code-mode/code-mode-isolates)).
- Version risk: everything 0.x; `@tanstack/ai-code-mode` at 0.3.6 and isolate-node at 0.1.45 (npm) — young API surface.

## Open questions

- `needsApproval` honored inside Code Mode `external_*` calls? Docs silent; assume no — verify in `@tanstack/ai-code-mode` source before shipping writes.
- Sandbox `external_*` bridge: per-call timeout on tool side? Long-running SQL vs 30s sandbox timeout interplay undocumented.
- Runtime `context` (drizzle client) injection into Code Mode tools — docs show `chat()` context for plain tools; Code Mode docs don't show context plumbing. Verify `toolsToBindings` preserves it.
- Raw free-form SQL tool (model writes SQL string) vs typed drizzle tools — docs benchmark used `external_queryTable`-style typed tools; no guidance on SQL-injection-shaped tool design.
- Persistence of chat history (docs/chat/persistence.md exists — not reviewed) for multi-turn write agents.
- `@tanstack/ai` 1.0 timeline / stability commitments — nothing published.
- Start server-route auth patterns for the chat endpoint — quick start shows no auth.

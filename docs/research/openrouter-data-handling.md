# OpenRouter data handling for Client data (ticket #13)

Researched 2026-08-02. Primary sources only: openrouter.ai docs/policies, OpenRouter's own live APIs (`/api/v1/endpoints/zdr`, `/api/frontend/v1/all-providers`), Anthropic/Claude platform docs, and the published `@tanstack/ai-openrouter` + `@openrouter/sdk` type definitions. Every claim cited; unverified items are marked.

## Verdict

**Technically achievable, contractually blocked for the psychologist case as written.**

1. **OpenRouter itself is ZDR by default.** "OpenRouter does not store your prompts or responses, unless you opt in" — two separate opt-ins, both off by default ([Data Collection](https://openrouter.ai/docs/guides/privacy/data-collection)). It never trains on inputs: "OpenRouter does not use your Inputs or Outputs for model training" ([Privacy Policy](https://openrouter.ai/privacy)). So the gateway is not the retention risk.
2. **The default upstream route for Haiku 4.5 *is* the retention risk.** OpenRouter's live provider policy for the first-party `anthropic` endpoint is `{"training": false, "retainsPrompts": true, "retentionDays": 30, "requiresUserIDs": true}` ([all-providers API](https://openrouter.ai/api/frontend/v1/all-providers)). Without `zdr`, Client data can land there and sit for 30 days.
3. **`zdr: true` fixes it, and narrows routing to 4 endpoints.** Diffing the live ZDR list against the model's endpoint list (both fetched 2026-08-02) — `anthropic/claude-haiku-4.5` has 6 endpoints; **Google Vertex (global, europe) and Amazon Bedrock (global, eu-west-1) are ZDR; first-party Anthropic and Azure are not.**
4. **`gpt-oss-120b` is 19-for-19 ZDR — which is the problem, not the solution.** Every host is ZDR-flagged, including Mancer, Phala, SiliconFlow (SG), Mara, Novita. `zdr: true` alone would happily route a psychologist's session notes to any of them. Needs an explicit `only` allowlist, which erases most of its cost advantage.
5. **The blocker is the DPA, not the plumbing.** OpenRouter's DPA §2.5 prohibits processing sensitive data "unless explicitly stated in the Agreement" ([DPA](https://openrouter.ai/data-processing-agreement)). No HIPAA/BAA anywhere in OpenRouter's stack. Health-adjacent notes are special-category data under GDPR Art. 9 and "datos sensibles" under Chile's Ley 21.719.

**Shape of the v1 answer:** ship with `zdr: true` + `data_collection: "deny"` + an `only` allowlist, pinned to `anthropic/claude-haiku-4.5`; and **keep health-adjacent free-text out of the model's context** by product design rather than by contract. See [v1 configuration](#v1-configuration) and [Blockers and conditions](#blockers-and-conditions).

---

## 1. What OpenRouter itself retains

| Thing | Default | Source |
|---|---|---|
| Prompts / completions | **Not stored** | ["OpenRouter does not store your prompts or responses, unless you opt in to one or both of the following"](https://openrouter.ai/docs/guides/privacy/data-collection) |
| Private Input & Output Logging | **Off**. Stores your prompts for your own debugging; "OpenRouter does not access or use this data"; org admins can view | [Data Collection](https://openrouter.ai/docs/guides/privacy/data-collection) |
| OpenRouter Use of Inputs/Outputs | **Off**. Opting in trades prompt data for "a 1% discount on all model usage" | [Data Collection](https://openrouter.ai/docs/guides/privacy/data-collection) |
| Training by OpenRouter | **Never** | ["OpenRouter does not use your Inputs or Outputs for model training"](https://openrouter.ai/privacy) |
| Request metadata | **Always stored** — "number of prompt and completion tokens, latency, etc"; "does not include the content of your prompts or responses" | [Data Collection](https://openrouter.ai/docs/guides/privacy/data-collection) |
| Anonymous input categorization | **Always on** — "OpenRouter samples a small number of prompts for categorization"; if not opted in, "stored completely anonymously and never associated with your account or user ID. The categorization is done by model with a zero-data-retention policy" | [Data Collection](https://openrouter.ai/docs/guides/privacy/data-collection) |

Two caveats worth naming:

- **Anonymous categorization is not zero-egress.** Prompt content is sampled and sent to a third model even with everything opted out. It's anonymised and ZDR-classified, but it is prompt *content* leaving the request path. There is no documented opt-out.
- **Enabling logging changes the licence you grant.** The ToS baseline licence is "solely in connection with operating and providing the Service"; with prompt logging enabled it becomes a "worldwide, perpetual, irrevocable, non-exclusive, royalty-free... right and license (with the right to sublicense) to host, store, transfer, display, perform, reproduce, modify... adapt, translate, and prepare derivative works of, and distribute your User Content" ([Terms](https://openrouter.ai/terms)). **Never enable logging on the operator account.**

Personal data OpenRouter does collect on the operator: "identifiers (name, email, IP address), commercial information (transaction history), network activity data... geolocation data, account credentials" ([Privacy Policy](https://openrouter.ai/privacy)). Retained "for as long as is reasonably necessary to comply with our business and legal obligations" — no window given.

## 2. ZDR controls

Definition: "Zero Data Retention (ZDR) means that a provider will not store your data for any period of time. Providers that do not retain your data are also unable to train on your data." ([ZDR docs](https://openrouter.ai/docs/guides/features/zdr))

Three enforcement points, combined with **OR** semantics:

1. **Account-wide** — `openrouter.ai/settings/privacy`. Granular per model group: Anthropic, OpenAI, Google, xAI, non-frontier.
2. **Guardrail-level** (org feature) — `enforce_zdr_anthropic`, `enforce_zdr_openai`, `enforce_zdr_google`, `enforce_zdr_other`; the flat `enforce_zdr` is deprecated and copied into unset per-provider fields (verified in `@openrouter/sdk@0.13.20` `models/createguardrailrequest.d.ts`).
3. **Per-request** — `"provider": { "zdr": true }`.

"The request-level `zdr` parameter operates as an 'OR' with your account-wide and guardrail ZDR settings — if any is enabled, ZDR enforcement will be applied... the per-request parameter can only be used to ensure ZDR is enabled for a specific request, not to override or disable account-wide or guardrail enforcement." ([ZDR docs](https://openrouter.ai/docs/guides/features/zdr)) — **This is the useful property: belt-and-braces is free.** Set it account-wide *and* per-request; a code regression that drops the request param cannot silently disable protection.

What ZDR does **not** cover:

- "ZDR enforcement only applies to provider routing for inference requests. It does not apply to plugins and tools you choose to enable, such as web search. These may be operated by third-party services with their own data retention policies." ([ZDR docs](https://openrouter.ai/docs/guides/features/zdr)) — we use no OpenRouter plugins, so moot, but it forecloses ever adding the `web` plugin.
- OpenRouter's own metadata and the anonymous categorization sampling (§1).
- Anything about *where* processing happens. ZDR ≠ residency; see §5.

`data_collection` is a **separate, weaker** control: "`allow`: (default) allow providers which store user data non-transiently and may train on it / `deny`: use only providers which do not collect user data" ([Provider Selection](https://openrouter.ai/docs/guides/routing/provider-selection)). Its backing data carries an explicit disclaimer: "This is not a definitive source of third party data policies, but represents our best knowledge." Set both; treat `zdr` as the load-bearing one.

## 3. Provider routing for our two models

Fetched 2026-08-02 from `/api/v1/models/{slug}/endpoints` and `/api/v1/endpoints/zdr`.

Note the slug: OpenRouter uses **`anthropic/claude-haiku-4.5`** (dot), not `claude-haiku-4-5`. The Anthropic-native id `claude-haiku-4-5` is not an OpenRouter slug.

### `anthropic/claude-haiku-4.5` — 6 endpoints, 4 ZDR

| Provider | Endpoint tag | ZDR? |
|---|---|---|
| Google (Vertex) | `google-vertex/global` | ✅ |
| Google (Vertex) | `google-vertex/europe` | ✅ |
| Amazon Bedrock | `amazon-bedrock/global` | ✅ |
| Amazon Bedrock | `amazon-bedrock/eu-west-1` | ✅ |
| **Anthropic (first-party)** | `anthropic` | ❌ — 30-day retention |
| **Azure** | `azure/global` | ❌ |

Provider-level data policies from [`/api/frontend/v1/all-providers`](https://openrouter.ai/api/frontend/v1/all-providers):

```json
"anthropic":      {"training": false, "trainingOpenRouter": false, "retainsPrompts": true,  "retentionDays": 30, "canPublish": false, "requiresUserIDs": true}
"google-vertex":  {"training": false, "trainingOpenRouter": false, "retainsPrompts": false, "canPublish": false, "requiresUserIDs": true}
"amazon-bedrock": {"training": false, "trainingOpenRouter": false, "retainsPrompts": false, "canPublish": false, "requiresUserIDs": false}
"azure":          {"training": false, "trainingOpenRouter": false, "retainsPrompts": false, "canPublish": false, "requiresUserIDs": false}
```

Two things to flag:

- **Azure's provider-level policy says no retention, yet its Haiku endpoint is absent from the ZDR list.** ZDR is decided per *endpoint*, not per provider, and the two data sources disagree. Trust the ZDR list; don't reason from `all-providers`.
- **`requiresUserIDs: true` on both `anthropic` and `google-vertex`** — an end-user identifier is forwarded upstream. Whatever we pass as `user` becomes upstream metadata. Pass an opaque Owner UUID, never an email or name. (The mechanism is documented by the field name only; the exact payload is **unverified**.)

### `openai/gpt-oss-120b` — 19 endpoints, **19 ZDR**

CoreWeave, DeepInfra (×2), Novita, SiliconFlow, Mancer 2, DigitalOcean, Google Vertex, BaseTen, Parasail, SambaNova, Amazon Bedrock (×2), Together, Nebius, Phala, Groq, Mara, Cerebras. All flagged ZDR; all report `retainsPrompts: false, training: false` at provider level ([all-providers](https://openrouter.ai/api/frontend/v1/all-providers)).

This is worse than it looks. `zdr: true` becomes a **no-op filter** for this model — it excludes nothing. Routing is then decided by price/latency, so a request carrying appointment notes can land on Mancer (no published HQ), Phala (redpill.ai ToS), SiliconFlow (Singapore), or Mara. Several were also unhealthy at fetch time (SiliconFlow `status: -5`, uptime 49% / 30m; Mancer `-5`, 67%; Phala `-5`, 30%). **For `gpt-oss-120b`, only an explicit `only` allowlist provides any assurance** — and once you pin to Groq/Cerebras/Bedrock/Vertex you've given up the "cheap open model, many hosts" premise.

### Pinning mechanics

Verified against `@openrouter/sdk@0.13.20` `models/providerpreferences.d.ts` and the [Provider Selection docs](https://openrouter.ai/docs/guides/routing/provider-selection):

- `order: string[]` — "An ordered list of provider slugs. The router will attempt to use the first provider in the subset of this list that supports your requested model, and fall back to the next if it is unavailable. **If no providers are available, the request will fail with an error message.**"
- `only: string[]` — allowlist; "merged with your account-wide" settings.
- `ignore: string[]` — denylist; also merged account-wide.
- `allow_fallbacks: boolean` (default `true`) — `false` means "use only the primary/custom provider, and return the upstream error if it's unavailable."
- `data_collection: "allow" | "deny"` (default `"allow"`).
- `zdr: boolean` — "When true, only endpoints that do not retain prompts will be used."

**Slug vs display name is ambiguous.** The docs' examples use lowercase slugs (`["anthropic", "openai"]`), but the SDK's `ProviderName` enum is display names (`"Amazon Bedrock"`, `"Anthropic"`, `"Google"`, `"Azure"`) and the type is `Array<ProviderName | string>` — so both appear accepted. **Unverified which form the router canonicalises.** Assert it with a live smoke test that inspects the response's provider field before trusting the allowlist (see [Blockers](#blockers-and-conditions)).

## 4. Upstream model-provider policies

### Anthropic (first-party API — the endpoint we will *exclude*)

- No training: "Anthropic will not use inputs or outputs from commercial products... to train its models" ([Privacy Center](https://privacy.anthropic.com/en/articles/7996868-i-want-to-opt-out-of-my-prompts-and-results-being-used-for-training-models)).
- Default retention: inputs and outputs deleted within **30 days** ([Privacy Center](https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-personal-data)) — matching OpenRouter's `retentionDays: 30`.
- ZDR exists but is **per-organization and sales-gated**: "To request ZDR for your organization, contact the Anthropic sales team. ZDR is enabled per organization" ([API and data retention](https://platform.claude.com/docs/en/docs/build-with-claude/zero-data-retention)). **It is Anthropic's org, not ours** — OpenRouter's account, not the operator's. We cannot obtain it, which is precisely why the `anthropic` endpoint is not ZDR on OpenRouter.
- HIPAA readiness with a signed BAA exists on `api.anthropic.com` — but explicitly **"does not cover... Partner-operated platforms: Amazon Bedrock and Google Cloud's Agent Platform"** and is unreachable through a third-party gateway.
- Even under ZDR/BAA: "if a chat or session is flagged, Anthropic may retain inputs and outputs for up to 2 years."

### Google Vertex / Amazon Bedrock (the endpoints we *will* use)

Anthropic's own docs are explicit about who the processor is: "On Amazon Bedrock and Google Cloud's Agent Platform, the cloud provider is the data processor; refer to those platforms' data retention and compliance documentation" ([API and data retention](https://platform.claude.com/docs/en/docs/build-with-claude/zero-data-retention)). So the upstream chain for our recommended config is **Owner → our server → OpenRouter → Google Cloud or AWS**, and the relevant contract is Google's / AWS's — neither of which we hold; OpenRouter holds it. OpenRouter reports both as `retainsPrompts: false, training: false`, ToS at [cloud.google.com/terms](https://cloud.google.com/terms/) and [aws.amazon.com/service-terms](https://aws.amazon.com/service-terms/). **We are relying on OpenRouter's assertion about a contract we cannot inspect.** That's the honest characterisation.

### gpt-oss-120b hosts

All 19 report `training: false, retainsPrompts: false, canPublish: false` in [all-providers](https://openrouter.ai/api/frontend/v1/all-providers), each with a ToS/privacy URL. Spot-relevant HQs: Nebius `NL`, SiliconFlow `SG`, Mancer `null`, DigitalOcean `null`, rest `US`. **These are OpenRouter's characterisations, not our reading of each host's policy** — 19 individual policy reviews were out of scope and the docs themselves warn the data "is not a definitive source of third party data policies, but represents our best knowledge."

## 5. Contractual posture

- **OpenRouter is a processor.** DPA §2.1: "Customer is a Controller, and OpenRouter is a Processor." Binding "upon executing the Order Form or using the Service" — i.e. click-through, no negotiation needed ([DPA](https://openrouter.ai/data-processing-agreement)). The ToS incorporate it by reference for anyone using the Service "for commercial, for-profit purposes" ([Terms §10.2](https://openrouter.ai/terms)).
- **Transfers:** SCCs Module 2 (Controller→Processor) for the EEA, UK Addendum, Swiss modifications (DPA §13.2). Servers in the US "or to other countries outside the European Economic Area" ([Privacy Policy](https://openrouter.ai/privacy)).
- **Security (DPA Schedule 2):** TLS 1.2+ in transit, AES-256 at rest, SOC 2 Type II, GCP hosting, quarterly vulnerability scans, annual external pen test. Deletion "within 30 business days of request". Audit rights once a year via an independent auditor (§6). Sub-processors listed at [trust.openrouter.ai](https://trust.openrouter.ai/).
- **Sensitive data is excluded.** DPA §2.5 prohibits processing sensitive data "unless explicitly stated in the Agreement." No HIPAA language, no BAA. **This is the contract-level blocker.**
- **Liability is nominal:** capped at "the greater of amounts paid in prior 12 months or $100" ([Terms](https://openrouter.ai/terms)). A breach involving a psychologist's Clients would not be meaningfully covered.
- **Responsibility is pushed to us:** "You are solely responsible for... determining whether any Model, Model Terms, Input, Output, or Use Case is appropriate for your business, legal, security, privacy, and compliance requirements" ([Terms](https://openrouter.ai/terms)).
- **EU in-region routing exists but is out of reach:** `https://eu.openrouter.ai` guarantees requests "are only decrypted within the designated region, and are only routed to providers operating in that region" — but "EU in-region routing is available for enterprise customers by request" ([Sovereign AI](https://openrouter.ai/docs/guides/features/sovereign-ai)). Not available on a standard operator account in v1.

**Chile (CLP ⇒ Chilean Owners).** Ley 21.719 was published 2024-12-13 and takes effect **2026-12-01**; it treats health data as "datos sensibles" with stricter consent and processing requirements, adds an data-protection agency, 72h breach notification, a mandatory processing register, and fines up to 20,000 UTM. **Sources are secondary (Chilean legal/consultancy blogs) — bcn.cl was unreachable at research time, so treat dates and figures as unverified.** The direction of travel is not in doubt though: a Chilean psychologist's session notes will be regulated sensitive data from roughly four months after this was written.

## v1 configuration

### OpenRouter account (operator-owned key)

1. `openrouter.ai/settings/privacy` → **ZDR ON account-wide**, all groups (Anthropic, OpenAI, Google, xAI, non-frontier).
2. Same page → **OpenRouter Use of Inputs/Outputs: OFF**. Forgo the 1% discount; it costs a perpetual sublicensable licence over Client data.
3. Observability settings → **Private Input & Output Logging: OFF**. (Even though OpenRouter can't read it, it's Client data at rest we don't need.)
4. Training opt-out toggles OFF for both paid and free models ([Provider Logging](https://openrouter.ai/docs/guides/privacy/provider-logging)).
5. Never enable any OpenRouter plugin (`web`, `file-parser`, …) — ZDR does not extend to them.

### Per-request provider preferences

Snake_case wire form (what actually goes on `/v1/chat/completions`):

```json
{
  "model": "anthropic/claude-haiku-4.5",
  "provider": {
    "zdr": true,
    "data_collection": "deny",
    "only": ["google-vertex", "amazon-bedrock"],
    "allow_fallbacks": true
  },
  "user": "<opaque Owner UUID>"
}
```

Through `@tanstack/ai-openrouter` the same preferences ride on `modelOptions` in camelCase — the adapter docs state the "Provider routing surface (`provider`, `models`, `plugins`, `variant`, `transforms`) passes through `modelOptions`", and `OpenRouterCommonOptions` is `Pick<ChatRequest, 'provider' | 'plugins' | 'user' | ...>` (verified in `@tanstack/ai-openrouter@0.15.10` `dist/esm/text/text-provider-options.d.ts` and `adapters/text.d.ts`):

```ts
chat({
  adapter: openRouterText('anthropic/claude-haiku-4.5'),
  modelOptions: {
    provider: {
      zdr: true,
      dataCollection: 'deny',
      only: ['google-vertex', 'amazon-bedrock'],
      allowFallbacks: true,
    },
    user: ownerId,          // opaque UUID — never email/name
  },
  // ...
})
```

`zdr`, `dataCollection`, `only`, `ignore`, `order`, `allowFallbacks` all exist on the SDK's `ProviderPreferences` (`@openrouter/sdk@0.13.20`, `models/providerpreferences.d.ts`).

**Why `only` as well as `zdr`:** `zdr: true` already reduces Haiku 4.5 to exactly those two providers, so `only` is redundant *today*. It's there so that a future ZDR-list change (e.g. Azure or first-party Anthropic gaining a ZDR endpoint with different regional behaviour) cannot silently widen the blast radius. Keep `allow_fallbacks: true` — with only two providers left, disabling fallback trades a privacy non-benefit for an availability hit.

### Model choice consequence

**Ship Haiku 4.5. Do not ship `gpt-oss-120b` as a v1 fallback.** ZDR is a meaningless filter for it (19/19 pass), so the only defensible config is a hand-maintained `only` allowlist over hosts we have not individually vetted — trading a known two-provider surface (Google Cloud, AWS) for an unvetted many-host surface, to save on a model that our own [code-mode research](./tanstack-ai-code-mode.md) already ranks below Haiku on the task that matters. If a second model is ever needed for cost, the honest version is `openai/gpt-oss-120b` with `only: ["groq", "cerebras", "amazon-bedrock", "google-vertex"]` — and a written note that we accepted those four vendors' policies unread.

### Application-side controls (the part OpenRouter can't give us)

- **Data minimisation is the real control.** The agent sends chat + SQL tool results. Tool results should return the minimum columns needed — no free-text notes column in a result set unless the Owner's question requires it.
- **No health-adjacent free-text field in v1.** `CONTEXT.md` currently defines no notes field on Appointment or Client. Keep it that way until §7's conditions are met; adding "notes" is what turns this from ordinary contact data into Art. 9 / Ley 21.719 sensitive data.
- **Owner-facing disclosure**: name OpenRouter and the upstream cloud processors in whatever privacy notice the invite-only signup carries. Under GDPR/Ley 21.719 the Owner is the controller for their Clients' data and we are their processor; they cannot obtain valid consent from a Client without knowing where data goes.

## Blockers and conditions

**Hard blocker.** OpenRouter's DPA §2.5 prohibits processing sensitive data absent explicit agreement, and OpenRouter offers no BAA and no health-data provision. **Routing a psychologist's clinical notes through this path is contractually out of scope, regardless of ZDR.** ZDR solves retention; it does not grant permission to process special-category data.

**Conditions that must hold for v1 to proceed as recommended:**

1. **No clinical/health free-text reaches the model.** Names, appointment times, service names, and CLP amounts are ordinary personal data — acceptable. The moment a "notes" field exists and is queryable by the agent, §7's blocker binds. This is a product decision, not a config one.
2. **Account-wide ZDR is on** *before* the first real Owner is onboarded, so a dropped request param can't matter (OR semantics, §2).
3. **Prompt logging stays off, permanently**, on both toggles. Worth an operator runbook line — the 1% discount is a standing temptation with a perpetual-licence price tag.
4. **A live smoke test asserts the route.** Send a request with the recommended `provider` block and assert the response's reported provider is one of Google/Amazon Bedrock. This simultaneously resolves the slug-vs-display-name ambiguity (§3) and catches a silently-ignored preference block. Without it, a typo'd provider name is indistinguishable from working config.
5. **The ZDR endpoint list is monitored, not assumed.** It's live data (`/api/v1/endpoints/zdr`) and changed shape once already. A quarterly check that `anthropic/claude-haiku-4.5` still has ≥1 ZDR endpoint is cheap; discovering it lost them all via a production error is not.
6. **Owner-facing privacy notice names the chain** (OpenRouter → Google Cloud / AWS, US processing under SCCs).

**Accepted residual risks, stated plainly:**

- Prompt content is sampled for anonymous categorization with no opt-out (§1).
- We rely on OpenRouter's assertion of Google's and AWS's retention behaviour; we hold no contract with either and cannot audit the claim.
- Processing is US-based under SCCs; EU in-region routing is enterprise-gated and unavailable to us.
- Liability is capped at ~$100. There is no financial remedy for a breach.
- Anthropic may retain flagged content up to 2 years even under ZDR arrangements — and that's on Anthropic's first-party path, which we exclude; the Bedrock/Vertex equivalent is undocumented here. **Unverified.**

## Open questions

- Exact payload OpenRouter forwards for `requiresUserIDs: true` providers (Anthropic, Google Vertex) — field name only is documented.
- Whether `only`/`order` accept endpoint tags (`google-vertex/europe`) or only provider granularity. Endpoint-tag pinning would let us force EU-region inference without enterprise Sovereign AI.
- Whether OpenRouter will scope sensitive-data processing into the DPA on request for a small account, or whether that is enterprise-only.
- Chile Ley 21.719 specifics — all current sourcing is secondary. Needs a bcn.cl read before it informs any design decision.
- Whether `data_collection: "deny"` and `zdr: true` interact (AND) or whether one supersedes; docs describe them independently.

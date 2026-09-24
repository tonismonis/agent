# Chat model: gpt-6-luna, no ZDR pin

The chat model is `openai/gpt-6-luna` with reasoning effort `none`. Provider routing is `data_collection: "deny"` with `allow_fallbacks: true`; the ZDR requirement and the provider pin are dropped. Supersedes [ADR-0003](0003-chat-model-luna.md), and with it the v1 spec's ZDR routing ([#13](https://github.com/tonismonis/agent/issues/13)).

Operator decision, 2026-09-23.

- **Why drop ZDR:** only Azure served gpt-5.6-luna with zero retention, so the pin allowed a single provider. Its shared OpenRouter capacity returned upstream 429s on about half of the runs in live testing, and `allow_fallbacks` had nothing to fall back to.
- **What still holds:** `data_collection: "deny"` excludes providers that train on, or keep for their own use, the prompts they serve. Owners with `restricted_notes` still never send notes.
- **What is given up:** first-party OpenAI and others may keep prompts, including client names, contact details and payments, for up to 30 days for abuse monitoring. The privacy notice should say so before real Owners onboard.
- **Why gpt-6-luna:** newest luna, $0.10/$0.50 per Mtok against gpt-5.6-luna's $0.20/$1.20, served by OpenAI, Azure and Bedrock (seven endpoints on 2026-09-23), with tool calling and reasoning effort supported.

The `crm/ab-utterances.md` set has not been run against it.

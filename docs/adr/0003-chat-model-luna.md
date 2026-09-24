# Chat model: gpt-5.6-luna on Azure

Superseded by [ADR-0004](0004-chat-model-gpt-6-luna.md).

The chat model is `openai/gpt-5.6-luna`, pinned to Azure (`only: ["azure"]`, `zdr: true`, `data_collection: "deny"`), with reasoning effort `none`. This replaces the v1 spec's `anthropic/claude-haiku-4-5` on Google Vertex / Amazon Bedrock ([#13](https://github.com/tonismonis/agent/issues/13)).

Operator decision, 2026-09-23. luna costs about a fifth of haiku per token. The spec's adoption gate (checkpoint 2) had three parts:

- (b) ZDR routing: checked 2026-08-15 (commit 7f4b53a). Only luna's Azure endpoints are ZDR; first-party OpenAI and Bedrock are not.
- (a) crm suite + `crm/ab-utterances.md`: not run against luna at the time of this decision.
- (c) intro-pricing throttles and quantized serving: ongoing watch.

If Azure loses ZDR for luna, or it fails the utterance set, the fallback is the previous haiku config.

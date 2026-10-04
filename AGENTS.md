## Agent skills

### Issue tracker

Issues live in GitHub Issues via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five labels (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.

## Code style

### Function names

Name a function with a verb phrase that says what it does: `buildReceipt(writes)`, `readMessageText(message)`, `factToLines(fact)`. Never use the `somethingOf(x)` pattern (`receiptOf`, `textOf`). It hides whether the function builds, reads or finds, and two such names collide easily.

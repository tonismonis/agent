# Assistant voice and first days

The app prompt (`crm/src/lib/system-prompt.ts`) now sets a voice, names the Owner, uses the tool names the model can actually call, and guides an Owner with an empty CRM. It amends the prompt-owned behavior rules in the v1 spec ([#4](https://github.com/tonismonis/agent/issues/4)/[#5](https://github.com/tonismonis/agent/issues/5)) without changing any existing rule.

Operator decision, 2026-09-26.

- **Voice:** the assistant is Libreta. Chilean Spanish with tú, brief, no slang, emoji or exclamation marks. Plain text only, because the chat renders no Markdown; lists are lines starting with "- ". After a write it says what it did in one sentence, since the receipt already shows the fields.
- **Owner name:** `owners.name` is injected, so the model addresses the Owner by first name and never asks for it.
- **Tool names:** code mode exposes each tool as `external_<name>` inside `execute_typescript`. The old text said `restore_*`, which did not exist; it now says `external_softDelete*`, `external_restore*`, `external_listAuditLog` and `external_find_free_slots`.
- **Library prompt:** `createCodeMode` only exposes `execute_typescript`, but its appended system prompt says to call tools directly and shows an example with functions that do not exist here. The app prompt tells the model to ignore both.
- **First days:** when a request needs data that does not exist yet (no services when booking, no working hours when looking for free time), the model names what is missing, asks for it in one question, then finishes the request. Asked how to start, it suggests services with prices, then weekly hours, then clients as they come.

The `crm/ab-utterances.md` set has not been run against the new prompt.

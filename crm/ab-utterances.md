# A/B utterance set — gpt-oss-120b vs claude-haiku-4-5

Run the full set once per model (`CHAT_MODEL=openai/gpt-oss-120b npm run dev`, then default `anthropic/claude-haiku-4-5`). Fresh chat per model; judge live w/ instrumentation panel + `audit_log`. Reset db between runs: `docker compose exec db psql -U crm -c "truncate clients, services, audit_log restart identity"`.

## Onboarding (freeform vibe test, run first)

| # | Utterance | Expects |
|---|-----------|---------|
| O1 |  | 2× createService (hour + flat) in one turn — loop/Promise.all in panel |
| O2 |  | 3× createClient; "paga en efectivo" → Carmen's notes unprompted |
| O3 | ¿qué sabes de mí? | lists services + clients back |

Don't bother telling it your name/profession — no table home, evaporates on refresh (owner-profile = open v1 question).

## Scripted set

| # | Utterance | Expects |
|---|-----------|---------|
| 1 | nueva clienta Ana Rojas, correo ana@gmail.com | createClient |
| 2 | agrega servicio limpieza de casa, 15000 la hora | createService hour |
| 3 | agrega sesión de terapia, 40000 por sesión | createService flat |
| 4 | el teléfono de Ana es +56 9 1234 5678 | find→updateClient |
| 5 | ¿cuánto cobro por 3 horas de limpieza? | findServices + math in sandbox (45000) |
| 6 | lista mis clientes | findClients |
| 7 | sube la limpieza a 18000 | find→updateService |
| 8 | borra a Ana | softDeleteClient (never hard) |
| 9 | ¿cuántos clientes tengo y qué servicios ofrezco? | compose both finds |
| 10 | agrega a Pedro 20000 | ambiguous — should ask client vs service |
| 11 | ¿qué tiempo hace hoy? | out of scope — decline gracefully |

Judge per utterance: correct tool(s)? correct data (check audit_log)? sane Spanish reply? garbage/retries in panel?


Hola! Te cuento lo que vendo: limpieza de casas a 15.000 la hora, y aseo profundo a 60.000 por visita
Mis clientes actuales son: Ana Rojas (ana@gmail.com), Pedro Soto (+56 9 8765 4321), y la Sra. Carmen que paga siempre en efectivo
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

## Time and availability (ADR 0006)

Run on an empty CRM, in order. W4 onward needs Pedro, Ana and one service.

| # | Utterance | Expects |
|---|-----------|---------|
| W1 | onboardeame. doy clases de piano, 35.000 en mi casa y 45.000 a domicilio. haz todo de una | 2× createService only; no question or mention of horario |
| W2 | ¿tengo libre el martes en la tarde? | findAppointments for all of Tuesday; "no tienes nada agendado"; no time proposed, no offer to set hours |
| W3 | ¿cuándo puedo ver a Pedro esta semana? | findAppointments for the week; lists what is scheduled (or nothing); asks which day and hour; proposes none |
| W4 | agéndame a Pedro el jueves a las 17 a domicilio | createAppointment starts_at Thursday 17:00 Santiago; receipt shows 17:00 |
| W5 | agenda a Ana el jueves a las 17:30 | overlap error; reply names Pedro 17:00–18:00 and asks for another time; suggests none |
| W6 | ¿tengo libre el jueves en la tarde? | lists Pedro 17:00–18:00; does not say "libre de 18 a …" |
| W7 | agéndame a Ana el viernes en la tarde | no write; asks for the hour |
| W8 | trabajo de lunes a viernes de 9 a 18 | no write anywhere; says Libreta keeps no schedule |
| W9 | agenda a Pedro la próxima semana a la misma hora que este jueves | createAppointment next Thursday 17:00 |
| W10 | agéndame a Pedro el sábado 3 de abril de 2027 a las 23:30 | books 2027-04-04T02:30Z (repeated hour, earlier instant); receipt shows 23:30 |
| W11 | agéndame a Ana el 6 de septiembre de 2026 a las 00:30 | tool rejects the nonexistent time; model relays it and asks for another hour |
| W12 | búscame un hueco para Pedro esta semana | lists the week; asks day and hour; proposes none |
| W13 | (after 16:30) ¿tengo algo hoy? | lists only what is still ahead, or says so; past ones marked as already happened |
| W14 | agéndame a Ana mañana temprano | no write; asks for the hour |
| W15 | ¿tengo libre el jueves entre 3 y 7? | names the empty parts of 15:00–19:00 with "no tienes nada agendado"; never "libre" |

Judge W2, W3, W6, W12, W15: any proposed or "free" time fails the row.


Hola! Te cuento lo que vendo: limpieza de casas a 15.000 la hora, y aseo profundo a 60.000 por visita
Mis clientes actuales son: Ana Rojas (ana@gmail.com), Pedro Soto (+56 9 8765 4321), y la Sra. Carmen que paga siempre en efectivo
# No availability: the Owner names every time

Libreta keeps no working hours, availability or free-slot computation. The Owner names every appointment time, the CRM books it and rejects overlaps, and questions about free time are answered by listing scheduled appointments. Supersedes the `working_hours`, `set_working_hours` and `find_free_slots` items of the v1 spec ([#7](https://github.com/tonismonis/agent/issues/7)). [ADR-0005](0005-assistant-voice-and-first-days.md) is amended in place to drop its working-hours clauses.

Operator decision, 2026-09-26.

- **Why:** on 2026-09-26 the model wrote a Mon–Fri 09:00–18:00 template the Owner never gave. `find_free_slots` returned nothing without a template and the prompt said to offer only its times, so the prompt pushed the model to create one. A weekly template is an employee concept; a freelancer's time is shaped by what they book.
- **What replaces it:** nothing. The model reads scheduled appointments and lists them. It never proposes a time and never calls one "libre" or "disponible". When the Owner names both ends of a span ("el jueves entre 3 y 7"), it may say which parts of that span have nothing scheduled. It never picks the bounds itself.
- **Busy:** only `scheduled`, non-deleted appointments take up time, the same rule as `assertNoOverlap` and `appointments_no_overlap`. The free-slot SQL also counted completed and no-show appointments; that second rule is gone with it.
- **Guard:** a test in `crm/src/lib/tools.test.ts` fails if a chat tool name matches slot, hours, availability or schedule.
- **Not chosen:** a server check that a booking time appears in the Owner's recent messages. A substring match is too loose (any "17" passes) and too strict ("a la misma hora que la última vez" fails).
- **Data:** migration 0010 drops the table and keeps `btree_gist`, which `appointments_no_overlap` needs. The `set_working_hours` audit rows keep every template that was written.

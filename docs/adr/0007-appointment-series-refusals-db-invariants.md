# Appointment series, one refusal contract, invariants in the database

The Owner can book a weekly series ("Pedro, todos los martes a las 17, hasta fin de año") in one all-or-nothing write. Every tool now refuses the same way, and the Owner only ever hears Spanish written for them. Rules that retries, races or tool bugs could break live in `crm/src/db/schema.ts` as constraints. This supersedes the "recurrence table" item in the out-of-scope list of the v1 spec (`docs/spec/v1.md`).

Operator decision, 2026-09-26.

## Refusals

- **Who resolves it decides the shape.** A refusal carries either `say` or `fix`, never both. `say` kinds (`conflict`, `ask`, `blocked`, `internal`) are finished Spanish for the Owner, and the model relays them. `fix` kinds (`invalid_input`, `not_found`, `notes_off`) are English with field paths, for the model to correct silently. The Owner never hears about fields, because only `fix` refusals carry them.
- **Wire format.** A refusal is thrown as `RefusalError`, and its `error.message` is the refusal's JSON. That message is the only thing the code-mode isolate keeps, so a thrown refusal stops the model's code and reaches it intact. `readRefusal` in `crm/src/lib/refusal.ts` is the one parser, used by sandbox code (`JSON.parse`), `withRefusalOutput` in chat-run, the work margin and the audit log.
- **Spanish is derived, never written at a throw site.** `refuse.*` builders build `say` from the details with the templates in `refusal.ts`. `refusal.test.ts` pins every template.
- **Validation lives in the tool.** `bindTool` hands code mode plain JSON Schemas, which its binding passes through without validating (pinned by `refusal.bridge.test.ts`). `writeTool` and `readTool` parse the input themselves. A missing field that the tool's `guide.asks` knows how to ask for becomes an `ask`. Any other bad input becomes `invalid_input`. Invalid input refuses before anything runs, so it writes no audit row.
- **Audit.** A failed write records the refusal JSON the model saw. For `internal` refusals the row also keeps the technical `cause`. The model never sees it, since driver messages can carry SQL and notes.
- **Guides.** Every tool carries a Spanish `guide` (`does`, `asks`, `wont`) for the Owner. It feeds `ask` refusals now and can document Libreta later.
- **Missing ids.** Update, delete and restore on an id that does not exist now refuse with `not_found` instead of returning nothing.

## Database invariants

- **Principle.** A rule that a retry, a race or a tool bug could break is declared in the schema. Tool code checks first only so it can explain the refusal in Spanish. There are no triggers, and the exclusion constraint `appointments_no_overlap` is still the only hand-written SQL constraint.
- **Checks.** Service prices are positive, and so are durations when set. An appointment ends after it starts and its price is not negative. Payment amounts are positive. Zod stops these values first, so a violation means a bug and refuses as `internal`.
- **Payments settle their own client's appointment.** A payment references `appointments(id, client_id, owner_id)`, so linking another client's appointment fails in Postgres (`payments_appointment_client_fk`).
- **One map.** `refusalByConstraint` in `crm/src/lib/tools.server.ts` turns constraint names into refusals. A clash constraint is re-read and reported with real dates. A foreign key names the missing record. Anything unlisted is `internal`.

## Series

- **Data.** `appointment_series` stores the rule: client, service, mode, per-class duration and price, `starts_on`, `ends_on`. `appointment_series_days` stores one row per weekday with its clock time. Each class is an ordinary appointment carrying `series_id` and `series_date`, the rule date it fulfils, which stays the same if that class alone moves. The database guarantees one live class per series date (`appointments_series_date_unique`), that a class belongs to the series' client, and that its date falls on one of the series' weekdays.
- **Twice a week is one series.** One Owner sentence gives one all-or-nothing call, one receipt, one undo.
- **Dates step on Santiago calendar dates**, not instant plus seven days, so a 17:00 class stays 17:00 across both clock changes. A class in the skipped spring hour is a conflict date like any clash.
- **All or nothing.** `writeWithoutClashes` checks every class in one query and refuses with the full list: other appointments in the way, skipped hours, classes of the same request overlapping each other. `retry.skip` is the complete skip list to send back. A concurrent booking that slips past the check trips the constraint, which is re-read and reported the same way.
- **Count mode** books N classes; skipped dates push the end out. One call books at most 104 classes or one year. Past that, the tool asks the Owner for a nearer end.
- **Ending is a status, not a delete.** An earlier `until` cancels the future, scheduled, unpaid classes after it. Paid ones stay scheduled and come back in `kept_paid`. This keeps CONTEXT.md's rule that soft delete erases mistakes only. `softDeleteAppointmentSeries` is for a series booked by mistake, and `restoreAppointmentSeries` brings back exactly the classes that deletion removed.
- **Undoing an end reopens the same classes.** An end stamps the series and the classes it cancels with one `now()`. A later `until` reopens the cancelled classes carrying that stamp, rechecking every time, and books new dates only past the last existing class. Dates the Owner skipped are never booked again. A later edit to the series moves its stamp, and after that the old end's classes no longer reopen together.
- **Days cannot change.** To move a series to other weekdays, the model creates the new series first, then ends the old one. A refused create has then ended nothing.
- **One class stays one class.** `updateAppointment` on a member moves only that class. `createAppointment` with `series_id` and `series_date` books a clashing date at another hour as a member of the series.
- **Payments** have no series link. A month's payment is one payment without `appointment_id`.
- **Not chosen:** refusals as return values, because a failed write would let the model's code keep running and every consumer would need a union. Patching the isolate driver, because it is 0.x and ships weekly. Soft-deleting classes to end a series, because that turns a real ending into an erased mistake. A single call to change a series' weekdays, because it could end the old series and then fail to book the new one.

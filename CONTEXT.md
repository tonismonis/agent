# CRM for friends

Chat-only CRM for freelancers; a code-mode agent turns chat into data operations.

## Language

**Owner**:
The freelancer using the CRM; the identity and isolation root for all their CRM data. Exactly one authenticated identity represents an Owner in v1.
_Avoid_: User, tenant, friend, workspace, organization

**Client**:
A person the Owner sells to. Name required; contact details optional.
_Avoid_: Customer, contact, account

**Service**:
A catalog offering the Owner sells, priced as amount × unit. Belongs to the catalog, never to a Client.
_Avoid_: Product, rate, session type

**Unit**:
How a Service is charged: `hour` (price per hour) or `flat` (price per occurrence — session, visit, job).
_Avoid_: Billing type, pricing model

**Appointment**:
A scheduled block of the Owner's time delivering one Service to exactly one adult Client, online or in person. Never a group; the Client attending is the Client paying. Only `scheduled` Appointments take up the Owner's time, for the overlap check and for answering whether the Owner is free. The CRM has no availability concept. Every Appointment time comes from the Owner.
_Avoid_: Booking, session, lesson, class

**Money**:
All amounts are whole Chilean pesos stored as integers. CLP has no minor unit — there are no cents anywhere.
_Avoid_: Cents, currency field

**Payment**:
Money actually received from a Client, usually tied to one Appointment. Revenue-collected questions sum Payments; revenue-earned questions sum completed Appointments.
_Avoid_: Invoice, charge, transaction

**Soft delete**:
The only agent-facing delete: records remain recoverable. Erases mistakes only — a cancelled Appointment is a status, not a delete. Reversed by Restore.

**Restore**:
Un-delete: flips `deleted_at` back to null via a `restore_*` tool. Restoring an Appointment re-runs the overlap check.

**Audit log**:
Append-only record of every agent *write* (tool, input, entity+id, before-state, ok, error, timestamp). Reads are not logged. Retained for the Owner's lifetime; the sole durable record of what the agent did.

**Owner purge**:
Permanent erasure of an Owner and all identifying CRM, chat, audit, usage, and identity data. An operator-only offboarding action, never an agent tool.

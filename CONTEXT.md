# CRM for friends

Chat-only single-tenant CRM for freelancer friends; a code-mode agent turns chat into data operations against a fixed Postgres schema.

## Language

**Owner**:
The freelancer a CRM instance belongs to; the only user of that instance.
_Avoid_: User, tenant, friend

**Client**:
A person the Owner sells to. Name required; contact details optional.
_Avoid_: Customer, contact, account

**Service**:
A catalog offering the Owner sells, priced as amount × unit. Belongs to the catalog, never to a Client.
_Avoid_: Product, rate, session type

**Unit**:
How a Service is charged: `hour` (price per hour) or `flat` (price per occurrence — session, visit, job).
_Avoid_: Billing type, pricing model

**Soft delete**:
The only delete: rows get `deleted_at`, never removed. Agent has no hard-delete capability.

**Audit log**:
Append-only record of every agent tool call (tool, input, ok, timestamp), written in the tool bridge.

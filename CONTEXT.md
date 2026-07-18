# CRM for friends

Chat-only single-tenant CRM for freelancer friends; a code-mode agent turns chat into data operations against a fixed Postgres schema.

## Language

**Owner**:
The freelancer a CRM instance belongs to; the only user of that instance.
_Avoid_: User, tenant, friend

**Instance**:
One Owner's copy of the app with its own private database. Nothing is shared between Instances; distribution means many Instances, never one shared deploy.
_Avoid_: Tenant, multitenancy

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
A scheduled block of the Owner's time delivering one Service to exactly one adult Client, online or in person. Never a group; the Client attending is the Client paying.
_Avoid_: Booking, session, lesson, class

**Money**:
All amounts are whole Chilean pesos stored as integers. CLP has no minor unit — there are no cents anywhere.
_Avoid_: Cents, currency field

**Payment**:
Money actually received from a Client, usually tied to one Appointment. Revenue-collected questions sum Payments; revenue-earned questions sum completed Appointments.
_Avoid_: Invoice, charge, transaction

**Soft delete**:
The only delete: rows get `deleted_at`, never removed. Agent has no hard-delete capability.

**Audit log**:
Append-only record of every agent tool call (tool, input, ok, timestamp), written in the tool bridge.

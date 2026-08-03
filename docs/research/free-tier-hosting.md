# Free-tier hosting: is there a genuinely $0 alternative to Render for CRM v1?

Researched 2026-08-02. Primary sources only (provider pricing/docs pages, first-party changelogs, the `isolated-vm` repo). Follow-on to [managed-hosting.md](./managed-hosting.md), which picked Render at ~$25–35/mo after ruling free Render out: free web services "spin down … 15 minutes without receiving any inbound traffic" and free Postgres has no PITR ([render free](https://render.com/docs/free)).

Hard requirements carried over: (1) long-lived Node container that can load the `isolated-vm` native addon with a ~128 MB V8 isolate; (2) SSE streams lasting minutes; (3) Postgres reachable with transaction-scoped `SET LOCAL`; (4) invite-only, tens of users — cold start is a judgment call, not an automatic disqualifier.

## Verdict

**Yes, one stack is genuinely free and clears requirements 1–3: Google Cloud Run (scale-to-zero, request-based billing) + Neon Free.** It is free by *allowance*, not by plan — the free tier is "applied as a spending based discount" ([Cloud Run pricing](https://cloud.google.com/run/pricing)) — so it degrades into a small bill rather than an outage when exceeded. At our sizing (1 vCPU / 1 GiB) the free CPU allowance works out to **~50 hours of billed instance time per month**, and overage is ~$0.10/hour. Realistic outcome: **$0–10/mo**, not a hard $0.

A second candidate is worth 20 minutes in a dashboard before deciding: **Northflank's Sandbox tier** is the only free tier in the field that advertises *always-on* container compute plus a free managed Postgres — "Always-on-compute – no sleeping :) · 2× free services · 1× free database" ([pricing](https://northflank.com/pricing)) — but it publishes **no vCPU/RAM figures for free workloads** and says the tier "should not be used for production applications" ([docs](https://northflank.com/docs/v1/application/billing/pricing-on-northflank)).

Everything else fails on a distinction that matters more than the headline number: trial ≠ credit ≠ expiring ≠ free.

| Candidate | Kind of "free" | Fails on |
|---|---|---|
| **Cloud Run + Neon Free** | Permanent monthly allowance, per billing account | — (cold start only) |
| **Northflank Sandbox** | Permanent free tier, card required | Free resource size undocumented |
| **Oracle Always Free** | Permanent, "never expire" | Self-managed everything; idle-reclamation policy; A1 capacity |
| **Koyeb Free** | Permanent free instance | 0.1 vCPU / 512 MB; free Postgres capped at **5 h/month** |
| **Fly.io** | **None** for new orgs since 2024-10-07 | Not free at all (~$2–7/mo instead) |
| **Railway Free** | $1 of credit/month | $1 buys ~0.1 GB-month of RAM — hours, not a month |
| **Railway Trial** | One-time $5 grant | Trial, not a plan |
| **Render Free** | Permanent app tier, **expiring** DB | 15-min spin-down; free Postgres "expire 30 days after creation" |
| **Supabase Free** (DB only) | Permanent, pausing | No backups at all; 500 MB; 1-week inactivity pause |
| **Aiven Free** (DB only) | Permanent | 1 GB storage, "single backup only", no connection pooling |
| **Prisma Postgres Free** (DB only) | Permanent | 100 k operations/month ceiling |

### What free costs us versus paid Render

| | Paid Render (~$25–35/mo) | Cloud Run + Neon Free ($0–10/mo) |
|---|---|---|
| Process model | Always-on container | Scales to zero; cold start on first request |
| First-request latency | none | container cold start + Neon resume ("within a few hundred milliseconds", [Neon](https://neon.com/docs/introduction/scale-to-zero)) |
| SSE ceiling | 100 min | 60 min max, **5 min by default** — must be raised explicitly |
| Warm in-process state | yes (pool, caches, in-flight isolates) | no — every scale-to-zero drops it |
| DB storage | GBs, $0.30/GB/mo | **0.5 GB/project**, hard |
| PITR | 3 days (Hobby) / 7 days (Pro) | **6 hours, ≤1 GB-month** |
| Bills | one | two (GCP + Neon) |
| Migrations | pre-deploy hook | roll your own (Cloud Build step or Cloud Run Job) |
| Failure mode when exceeded | fixed bill | silent overage → needs a budget alert |

The two compromises that actually bite are **0.5 GB of database** and **a 6-hour PITR window**. For an invite-only CRM holding text rows for tens of Owners, 0.5 GB is years of headroom; a 6-hour restore window is not a real backup story — it needs a nightly `pg_dump` to object storage to be honest about durability.

## Recommendation

1. **Ship v1 on Cloud Run + Neon Free** if the goal is "$0 until it has users". Configure: 1 GiB memory / 1 vCPU, `min-instances=0`, request timeout raised to 3600 s, request-based billing, a GCP **budget alert at $1**, and a nightly `pg_dump` cron (Cloud Run Job) because 6 h of PITR is not a backup.
2. **Move to paid Render the moment either of these is true**: the free CPU allowance is regularly exhausted (~50 h/mo), or cold starts on the first chat message of the day become the thing people complain about. The migration is cheap — same `node .output/server/index.mjs`, same Postgres wire protocol.
3. **Check Northflank's Sandbox in the dashboard first** (10 minutes): if a free service can be sized ≥1 GB RAM, it beats Cloud Run outright — always-on, one provider, one dashboard, free Postgres addon — and it is the only free tier that avoids cold starts without self-hosting.
4. **Do not** take Oracle Always Free unless the "no self-hosting" constraint from [managed-hosting.md](./managed-hosting.md) is explicitly reversed. It is the most *capable* free option and the most *work*.

---

## Per-candidate findings

### Google Cloud Run + Neon Free — the only $0 stack that clears reqs 1–3

**Requirement 1 (native addon):** Cloud Run runs an arbitrary OCI container, so `isolated-vm` builds and loads exactly as on any container host. Memory is configurable per service, so the 128 MB isolate sits inside a 1 GiB instance rather than fighting a 512 MB cap.

**Requirement 2 (SSE):** "Cloud Run supports streaming HTTP responses. No configuration is required to enable the feature. The server has to respond with a `Transfer-Encoding: chunked` response header" ([HTTPS requests](https://docs.cloud.google.com/run/docs/triggering/https-request)). The ceiling is the request timeout: "The timeout is set by default to 5 minutes (300 seconds)" and can be "extended up to 60 minutes (3600 seconds)" ([request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)). **The default would kill a long chat turn** — this must be set at deploy time. 60 min is below Render's 100 min but far above anything a chat turn needs.

**Requirement 3 (Postgres / `SET LOCAL`):** Neon over the public pooled endpoint. Neon runs "PgBouncer … `pool_mode=transaction`" ([pooling](https://neon.com/docs/connect/connection-pooling)) and its own RLS guide uses the transaction-local form our design depends on — ``tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`)`` ([RLS query execution](https://neon.com/docs/guides/rls-query-execution)). Analysis unchanged from [managed-hosting.md](./managed-hosting.md#set-local-under-transaction-pooling).

**Requirement 4 (cold start) — the honest part.** Two cold starts stack:

- *Neon:* "After 5 min" of inactivity the compute suspends, and on the Free plan "this setting is fixed" — it cannot be disabled ([plans](https://neon.com/docs/introduction/plans), [scale to zero](https://neon.com/docs/introduction/scale-to-zero)). Resume "reactivates automatically within a few hundred milliseconds". Negligible.
- *Cloud Run:* scaling from zero means a container start. Google's own mitigations are "minimum instances" and "startup CPU boost … to temporarily increase CPU allocation during instance startup in order to reduce startup latency"; requests queue meanwhile — "Requests will pend for up to 3.5 times average startup time of container instances of this service, or 10 seconds, whichever is greater" ([general tips](https://docs.cloud.google.com/run/docs/tips/general)). Google publishes no cold-start latency number, so **this must be measured with our actual image**, not assumed. A Node SSR bundle plus a native addon is not a hello-world container.

Setting `min-instances=1` removes the cold start and removes the free tier at the same time — see the cost math below.

**The free tier, exactly.** Two different allowances, one per billing mode, both stated on [Cloud Run pricing](https://cloud.google.com/run/pricing):

- Request-based billing: "CPU - First **180,000 vCPU-seconds free** per month · RAM - First **360,000 GiB-seconds free** per month · Requests - **2 million requests free** per month".
- Instance-based billing: "CPU - First **240,000 vCPU-seconds free** per month · RAM - First **450,000 GiB-seconds free** per month".

Plus the governing sentence: "The free tier usage is aggregated across projects by billing account and resets every month; you are billed only for usage past the free tier. The free tier is applied as a spending based discount using Tier 1 pricing." The same numbers appear on [Google's always-free list](https://docs.cloud.google.com/free/docs/free-cloud-features), which also caps free egress at "1 GB of outbound data transfer from North America per month".

Billing mode matters for a streaming app: request-based means "CPU is only allocated during request processing"; instance-based means "CPU is allocated for the entire container instance lifecycle" ([billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings)). An in-flight SSE response *is* request processing, so request-based billing does not throttle mid-stream. Anything we want to do *after* the response closes would be throttled — we don't have such work.

**Cost math (do this before believing "free"):**

- A month is ~2,628,000 s. Always-on at 1 vCPU therefore needs ~2.63 M vCPU-seconds — **11× the largest free allowance**. Free is only reachable with scale-to-zero.
- At 1 vCPU / 1 GiB, CPU is the binding constraint: 180,000 vCPU-s ÷ 3600 = **50 hours of billed instance time per month** free (memory would allow 100 h).
- Overage, request-based, tier 1 default: CPU $0.000024/vCPU-s, memory $0.0000025/GiB-s, requests $0.40 per million ⇒ **~$0.095 per extra instance-hour**. Doubling to 100 h costs ~$4.80.
- `min-instances=1` (no cold starts) at instance-based rates ($0.000018/vCPU-s, $0.000002/GiB-s) is ~$52/mo before the free discount, ~$47 after. **Always-on Cloud Run is more expensive than Render**, not less.

50 hours/month is the number to reason about: tens of Owners each having a handful of multi-minute chat turns per day fits, but an idle browser tab holding an SSE stream open burns instance-time at full rate. **Close idle streams server-side** or the allowance leaks away doing nothing.

**Friction to price in:** no pre-deploy hook, so `drizzle-kit migrate` becomes a Cloud Build step or a separate Cloud Run Job; two vendors, two bills; a GCP billing account (card) is required even for free-tier usage; and the image lives in Artifact Registry, whose storage is billed separately from Cloud Run.

### Northflank Sandbox — the only free *always-on* container, and the least documented

The pricing page states the Sandbox tier plainly: "Always-on-compute – no sleeping :) · 2× free services · 1× free database · 2× free cron jobs" ([pricing](https://northflank.com/pricing)). The docs repeat the shape — "This free plan allows you to deploy: 2 services · 2 jobs · 1 addon · Up to 1 BYOC cluster" — with an explicit warning: "Our free tier is a great way to explore the platform, spin up hobby projects, or test new ideas. However, it should not be used for production applications" ([pricing on Northflank](https://northflank.com/docs/v1/application/billing/pricing-on-northflank)).

If the free service can hold ≥1 GB RAM, this is the best answer in the whole document: always-on Node container (req 1 ✅, req 2 ✅ — no serverless timeout to fight), a first-party managed **PostgreSQL 12–18 addon with backups** ([databases](https://northflank.com/docs/v1/application/databases-and-persistence/deploy-a-database)) for req 3, one provider, one dashboard.

What is **not** published anywhere first-party: the vCPU/RAM allotted to a free service, or the storage of the free addon. The only concrete anchor is the plans API, whose example response is `nf-compute-20` = "cpuResource: 0.2 … ramResource: 512 … amountPerMonth: 4.4" ([list plans](https://northflank.com/docs/v1/api/miscellaneous/list-plans)). If the free tier pins workloads to something that size, it lands in the same 512 MB / 0.2 vCPU hole as Koyeb and Render Free. A card is required regardless — "we only verify the card. Your card is only charged at the end of the billing cycle" ([pricing FAQ](https://northflank.com/pricing)).

**Action: verify in the dashboard.** This is a 10-minute question with a large payoff.

### Oracle Cloud Always Free — genuinely free, genuinely self-hosting

The most *capable* free compute in existence, and the one that breaks our stated constraints.

- Allowance: "All tenancies get the first 1,500 OCPU hours and 9,000 GB hours per month for free for VM instances using the VM.Standard.A1.Flex shape, which has an Arm processor. For Always Free tenancies, this is equivalent to **2 OCPUs and 12 GB of memory**", plus "a total of 200 GB of Block Volume storage" and two x86 `VM.Standard.E2.1.Micro` instances (1 GB RAM each) ([Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)).
- Permanence: "After your trial ends, your account remains active. There is no interruption to the availability of the Always Free Resources you have provisioned"; Always Free offerings "never expire" ([Free Tier overview](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm)). The $300 / 30-day trial is a separate thing and its resources are reclaimed.
- ARM is fine for `isolated-vm`: releases ship prebuilt binaries for `linux-arm64` and `linuxmusl-arm64` alongside `linux-x64` ([releases](https://github.com/laverdet/isolated-vm/releases)).

Three reasons it still loses:

1. **It is self-hosting.** OS patching, Postgres install/tuning/backups/PITR, TLS, reverse proxy, monitoring — all ours. [managed-hosting.md](./managed-hosting.md) opens with "no self-hosting, no k8s"; taking this option means reversing that decision, not slipping past it.
2. **The idle-reclamation policy is aimed squarely at a low-traffic invite-only CRM.** "Idle Always Free compute instances may be reclaimed by Oracle. Oracle will deem virtual machine and bare metal compute instances as idle if, during a 7-day period, the following are true: CPU utilization for the 95th percentile is less than 20%; Network utilization is less than 20%; Memory utilization is less than 20%" ([Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)). Our service will sit near-idle by design. Keeping it alive means either paying (the doc notes this applies to Always Free, not paid) or manufacturing load — which is exactly the kind of thing that quietly rots.
3. **Capacity.** A1 instances must be created in the tenancy home region and "out of host capacity" for `VM.Standard.A1.Flex` is a long-running, region-dependent reality ([Oracle Free Tier FAQ](https://www.oracle.com/cloud/free/faq/)). You may simply not be able to provision one.

### Koyeb — free, but sized for a demo

Koyeb does still have a permanent free instance: "One `free` web Service in the Frankfurt or Washington, D.C. regions with **512MB of RAM, 0.1 vCPU**, and 2GB of SSD" plus "One free PostgreSQL database limited to **5 hours of active time** and 1GB of storage" ([pricing FAQ](https://www.koyeb.com/docs/faqs/pricing)). Sleep behaviour is documented: free instances "scale down to zero when they don't receive any traffic for 1 hour" ([instances](https://www.koyeb.com/docs/reference/instances)).

Fails on two counts. **Req 1:** 512 MB total for Node SSR + a 128 MB isolate, on 0.1 vCPU, is not a serious runtime for a V8-isolate workload — note that `isolated-vm` is reported to fail to build entirely on "1 Core with 256 MiB of RAM" ([issue #428](https://github.com/laverdet/isolated-vm/issues/428)); we would depend on prebuilts and still be CPU-starved at runtime. **Req 3:** 5 hours of database uptime per month is a toy, so the DB has to come from Neon anyway — losing the one-provider advantage. Paid escape hatch if the platform is otherwise liked: `eco-small` (0.5 vCPU / 1 GB) at $5.36/mo ([instances](https://www.koyeb.com/docs/reference/instances)).

### Fly.io — no free tier for new organizations

Free allowances are legacy-only: the pricing page lists "Up to 3 shared-cpu-1x 256mb VMs" and "3GB persistent volume storage (total)" **for organizations on deprecated Hobby/Launch/Scale plans** ([pricing](https://fly.io/docs/about/pricing/)). Billing docs confirm: "New customers and all new organizations (including those created by previously existing customers) are billed monthly for resource usage", plans were "deprecated … as of October 7, 2024", and the $5 trial credit applied only to legacy Hobby signups ([billing](https://fly.io/docs/about/billing/)).

Fly's autostop/autostart does make it *cheap* — with Machines in a "`stopped` or `suspended` state" you "don't pay for their CPU and RAM", and "starting a Machine from a `suspended` state is faster than starting a Machine from a `stopped` state" ([autostop/autostart](https://fly.io/docs/launch/autostop-autostart/)) — but cheap is not free, and [managed-hosting.md](./managed-hosting.md) already flagged Fly's undocumented proxy behaviour for long-lived streams as a risk for req 2. **Excluded: not a free tier.**

### Railway — Free plan exists, but $1 of credit is not a month

Railway's plan table does list a Free plan at $0 — "For running small apps with $1 of free credit per month" — alongside a Trial with "a free one-time grant of $5", and Hobby at $5/mo including $5 of usage ([pricing plans](https://docs.railway.com/reference/pricing/plans)). Against Railway's own rates (RAM $10/GB/mo, vCPU $20/vCPU/mo, from the same page), $1/month buys roughly 0.1 GB-month of RAM — i.e. a service that runs for hours, not a month. The Trial's $5 is one-time. **Excluded: credit-based, not free.** Railway's SSE ceiling (15 min hard, 5 min idle) and unmanaged database from [managed-hosting.md](./managed-hosting.md) apply on top.

### Render Free — the baseline, restated precisely

For the record, since this is what "free Render" actually means: web services "spin down … 15 minutes without receiving any inbound traffic" and spin back up on the next request — "This process takes about one minute"; each workspace gets "750 Free instance hours" per month, after which free services are suspended; and critically **"Free Render Postgres databases expire 30 days after creation"** with a 14-day grace period before deletion, one per workspace, 1 GB ([free](https://render.com/docs/free)). Instance sizes: Free web = "512 MB" RAM / "0.1" CPU, free Postgres = "256 MB" / "0.1" CPU ([compute plans](https://render.com/docs/compute-plans)).

The ~1-minute spin-up is the disqualifier even before the expiring database: it is 60× Cloud Run's queue-tolerance heuristic and would be the first thing every Owner experiences each morning.

### Free Postgres options (for whichever compute wins)

| Provider | Free storage | Sleep / pause | Backup / PITR | Verdict for us |
|---|---|---|---|---|
| **Neon** | "0.5 GB/project", "100 CU-hours/project" ([plans](https://neon.com/docs/introduction/plans)) | scale-to-zero after 5 min, **cannot disable** on Free; resume "within a few hundred milliseconds" ([scale to zero](https://neon.com/docs/introduction/scale-to-zero)) | "6 hours, up to 1 GB-month" history retention | ✅ Best. Transaction pooler + documented `set_config(...,true)` RLS pattern |
| **Supabase** | "500 MB database size (Shared CPU • 500 MB RAM)" ([pricing](https://supabase.com/pricing)) | "Free projects are paused after 1 week of inactivity. Limit of 2 active projects" — "a few user requests to the database each day over the previous week is enough to keep the project from being paused" ([project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)) | **none on Free**; PITR is a $100/mo add-on on paid | ⚠️ The pause is survivable for DB-only use (our app queries daily), but **zero backups** on Free makes it a single point of total data loss. [managed-auth.md](./managed-auth.md) already ruled the pause disqualifying for auth |
| **Aiven** | "1 CPU · 1 GB RAM · 1 GB storage"; "Free plans do not have any time limitations" but Aiven "reserves the right to shut down services if we believe they … are unused for an extended period of time" ([pricing](https://aiven.io/pricing)) | not documented | "Single backup only for disaster recovery" | ⚠️ No connection pooling on Free; 1 GB storage; same idle-shutdown risk pattern as Oracle |
| **Prisma Postgres** | "500 MB", "100,000 operations included", "No credit card required" ([pricing](https://www.prisma.io/pricing)) | not documented | not documented for Free | ⚠️ An operations *quota* is the wrong shape for an agent that fires many small tool queries per chat turn |
| **Koyeb PG** | 1 GB, "**5 hours of active time**" ([pricing FAQ](https://www.koyeb.com/docs/faqs/pricing)) | n/a | n/a | ❌ |
| **Render PG** | 1 GB, **expires after 30 days** ([free](https://render.com/docs/free)) | n/a | none | ❌ |
| **Northflank addon** | undocumented | always-on per pricing page | "Native or disk" backups for PostgreSQL ([databases](https://northflank.com/docs/v1/application/databases-and-persistence/deploy-a-database)) | ❓ Verify |

---

## Requirement-by-requirement

### 1. `isolated-vm` on a free tier

Two facts that reframe this from [managed-hosting.md](./managed-hosting.md):

- **Prebuilt binaries exist.** The README only documents building from source and lists per-distro toolchains ("Ubuntu: `python g++ build-essential`", "Alpine: `python3 make g++`") with "This project requires nodejs version 16.x (or later)" ([README](https://github.com/laverdet/isolated-vm)) — but releases from v6.0.2 (2025-10-16) ship tarballs for `darwin-arm64`, `linux-arm64`, `linux-x64`, `linuxmusl-arm64`, `linuxmusl-x64`, `win32-x64` ([releases](https://github.com/laverdet/isolated-vm/releases)). So **arm64 is a first-class target** — Oracle Ampere, or any ARM instance, is not a blocker.
- **Building from source needs a real machine.** A reporter on "1 Core with 256 MiB of RAM" had the kernel kill the C++ compile, and found builds only succeeded at 1–2 threads (≈537 s / ≈256 s) ([issue #428](https://github.com/laverdet/isolated-vm/issues/428)). Any free tier where the *build* runs on the same 512 MB instance as the app is a hazard. Cloud Run sidesteps this — the image is built by Cloud Build, not by the serving instance.

Runtime memory is the real constraint everywhere: 128 MB isolate + Node SSR does not fit comfortably in 512 MB (Render Free, Koyeb Free, possibly Northflank Sandbox). Cloud Run is the only free option where **we choose the memory**.

### 2. SSE

| Option | Ceiling | Verdict |
|---|---|---|
| Cloud Run | default 300 s, max 3600 s ([timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)); streaming needs only `Transfer-Encoding: chunked` ([HTTPS requests](https://docs.cloud.google.com/run/docs/triggering/https-request)) | ✅ once raised — **the 300 s default is a trap** |
| Northflank | plain container behind their proxy; no documented request/idle timeout | ❓ undocumented — test before trusting |
| Oracle VM | our own nginx/Caddy, our own timeouts | ✅ total control |
| Koyeb Free | scale-to-zero at 1 h idle; no documented stream timeout | ❓ |
| Railway Free | 15 min hard, 5 min idle, heartbeats mandatory ([SSE guide](https://docs.railway.com/guides/sse-vs-websockets)) | ⚠️ |

Note the interaction with Cloud Run billing: a held-open SSE connection is billable instance time for its full duration. Requirement 2 and the free allowance pull against each other — **idle stream reaping is a cost control, not just hygiene**.

### 3. `SET LOCAL` / pooling

Unchanged from [managed-hosting.md](./managed-hosting.md#set-local-under-transaction-pooling): transaction-mode pooling is safe because the server connection is pinned for the whole `BEGIN…COMMIT`. Neon Free exposes the same PgBouncer transaction-mode pooler as paid Neon ([pooling](https://neon.com/docs/connect/connection-pooling)), so nothing about the free tier changes the RLS design. Aiven Free is the exception worth flagging: its free plan lacks connection pooling entirely ([pricing](https://aiven.io/pricing)) — fine for one Node process, but it removes the fallback.

The silent-bypass risk (a `SET LOCAL` outside a transaction "emits a warning and otherwise has no effect") is identical on free and paid, and remains the highest-severity open item in the whole hosting question.

### 4. Cold start — the judgment call

Honest ranking of what an Owner experiences on the first message after a quiet period:

| Stack | Cold start | Documented? |
|---|---|---|
| Northflank Sandbox | none — "no sleeping" | Yes ([pricing](https://northflank.com/pricing)) |
| Oracle Always Free | none (but reclamation risk) | Yes |
| **Cloud Run + Neon** | container start (unmeasured) + <1 s Neon resume | Partially — Google documents *mitigations*, not latency |
| Koyeb Free | container start after 1 h idle | Sleep documented, latency not |
| Render Free | **"about one minute"** | Yes ([free](https://render.com/docs/free)) |

Render Free's minute is the only number any provider states, and it is the only one that is clearly unacceptable. Cloud Run's is probably a few seconds for a Node image, but **that is an assumption until measured**, and it is the single measurement that decides this recommendation.

---

## Open caveats

- **Cloud Run cold start with our actual image is unmeasured.** Node SSR + `isolated-vm` + a pooled PG connection. If it is >5 s, free stops being worth it. Measure before committing.
- **The free tier is a discount, not a wall.** Cloud Run's free tier is "aggregated across projects by billing account" and applied as a spending-based discount — exceeding it produces a bill, not an error. A budget alert at ~$1 is mandatory, not optional.
- **50 free instance-hours/month assumes 1 vCPU.** Sizing down stretches it proportionally; sizing up (if 1 GiB proves tight for the isolate) shrinks the memory allowance to 360,000 GiB-s ÷ instance GiB.
- **6 hours of PITR is not a backup.** Free either way, so a nightly `pg_dump` to object storage is the actual durability story. Where does the dump go, and is *that* free?
- **Artifact Registry storage** for the container image is billed separately from Cloud Run and is not covered by the Cloud Run free tier — small, but not zero.
- **Migrations have no home.** Cloud Run has no pre-deploy hook; `drizzle-kit migrate` needs to become a Cloud Build step or a Cloud Run Job with a direct (non-pooled) `DATABASE_URL`.
- **Northflank's free resource sizes are unpublished.** If ≥1 GB RAM, the recommendation flips to Northflank. Verify in the dashboard before building anything on Cloud Run.
- **Neon's 0.5 GB is per project, and the audit log grows forever.** [CONTEXT.md](../../CONTEXT.md) says the audit log is "Retained for the Owner's lifetime". That is the row set most likely to hit 0.5 GB first — model it before assuming years of headroom.
- **Two providers, two failure domains, two on-call surfaces** for a one-operator project. Render's single-bill/single-dashboard property was a real reason it won; free gives it up.
- **Does "free" survive contact with the region requirement?** Owners are Chile-centric. Cloud Run's free tier is quoted "based on us-central1 pricing" and the free egress allowance is "from North America"; `southamerica-west1` (Santiago) is a listed region but is not tier 1. Latency vs free-tier applicability is an unresolved trade.

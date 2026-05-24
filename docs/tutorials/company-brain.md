# Tutorial: Extend your personal brain into a company brain

This tutorial picks up where the [personal brain tutorial](personal-brain.md) leaves off. You already have a working agent (OpenClaw on Render, talking to you on Telegram, with GBrain as memory and Supabase storing embeddings). Now you want your whole team to use it as shared institutional memory, with each person seeing only what they're allowed to see.

**Time:** about 90 more minutes on top of the personal-brain install.
**Cost:** under $100 a month sustained for a 25-person company.

If you haven't done the personal-brain install yet, [start there first](personal-brain.md). Come back when you've got the agent responding to you on Telegram. This tutorial assumes that's already working.

I'm Garry Tan. I built GBrain to run my own AI agents at Y Combinator. After a couple of months of multi-user features landing (parallel sync across team sources, per-user OAuth scoping, leak-free isolation across every read path), it's finally usable as a company brain too. This is the recipe I'd run if I were standing it up for a 10-50 person company today.

---

## Part 1: The mental model

### What changes when you go from personal to company

The personal brain you built is a single-user system: one git repo, one agent, your stuff. The company brain is the same architecture with three additions:

1. **Multiple sources** inside the same brain. Your meeting notes are one source. Each teammate's customer notebook is another. The shared company wiki is a third. They live in the same database but stay independent.
2. **Per-user logins** with scopes. Each teammate gets their own OAuth credential. The credential decides which sources they can read and write to. Alice writes to her customer source, reads hers plus the shared one. Bob writes to internal-ops, reads his plus the shared one. Neither can see the other's writes.
3. **Per-person folders, crons, and skills.** The shared brain has shared structure, but each teammate gets their own subfolder for their own work, their own scheduled tasks (weekly digest, customer follow-ups), and their own scoped skills.

### What this is NOT

It is **not** a different install. The agent runtime, Supabase backend, GBrain CLI, and AlphaClaw harness from the personal brain stay exactly as you set them up. We're adding to that stack, not replacing it.

It is also **not** a thin-client-everywhere setup. Your personal agent stays as it is (OpenClaw + Telegram). Each teammate adds their own client of choice (Claude Code, Cursor, Claude Desktop, their own OpenClaw, whatever) and points it at the brain.

### What you get that one person's brain doesn't

- **Shared memory.** The whole team queries the same brain. The contract notes that alice wrote on Tuesday show up when bob asks about that customer on Friday, with citations back to alice's notes.
- **Scoped privacy.** Performance reviews don't leak into customer queries. Legal docs don't leak into sales searches. We fuzz-tested this across every read path and got zero leaks.
- **One sync pipeline.** Your brain git repo (or several if you want them isolated per team) feeds the brain. Everyone sees the latest.
- **One operating burden.** One server to monitor, not one per user.

---

## Part 2: Switch the brain backend to multi-user Postgres

The personal-brain install uses Supabase as the embeddings layer but the GBrain runtime itself might be using PGLite (single-machine) depending on which path you took. For a company brain, you want a real Postgres for the runtime too. If your personal-brain install is already on Postgres or Supabase end-to-end, skip to Part 3.

If you're on PGLite, migrate:

```bash
gbrain migrate --to supabase
```

This copies every page, chunk, embedding, link, and config over to your Supabase project. Run from the agent host machine, same one you set up in the personal-brain tutorial. Takes a few minutes per 10K pages.

Verify:

```bash
gbrain doctor
gbrain stats
```

Page count and chunk count should match what you had on PGLite.

---

## Part 3: Carve up the brain into sources

The personal brain has one source (called `default`) holding everything. For a company brain we want multiple. The right shape depends on your org. Here's a typical starting point for a 10-50 person company:

```bash
# A shared all-hands source for content everyone reads
gbrain sources add shared --path /srv/brain-repos/shared --name "Shared company wiki"

# A scoped source for sales/customer notes
gbrain sources add customers --path /srv/brain-repos/customers --name "Customer notes"

# A scoped source for internal-only docs (legal, HR, performance, board)
gbrain sources add internal --path /srv/brain-repos/internal --name "Internal-only"
```

Each `--path` is a directory on disk where you've checked out a git repo. Create them:

```bash
sudo mkdir -p /srv/brain-repos
sudo chown $USER /srv/brain-repos
cd /srv/brain-repos
git clone git@github.com:your-org/shared-wiki.git shared
git clone git@github.com:your-org/customers.git customers
git clone git@github.com:your-org/internal-docs.git internal
```

You can also keep the existing personal-brain repo as one of the sources. Just pick the role it plays (probably `shared` if it's already org-wide content).

### Per-person folder structure inside each source

Inside each source, give each teammate their own subfolder. This is the structure I run:

```
customers/
├── alice-example/                      ← alice's customer notebook
│   ├── customers/
│   │   ├── acme-co.md
│   │   └── widget-systems.md
│   └── meetings/
│       └── 2026-05-21-acme-renewal.md
├── bob-example/                        ← bob's customer notebook
│   └── customers/
│       └── orbit-bio.md
└── shared-customers/                   ← things both can see
    └── all-active-deals.md
```

Two things this structure buys you:

1. **Each teammate's writes go to their own folder** even though they're in the same source. No accidental overwrites.
2. **You can later split a person's folder into its own source** (if alice leaves and a new person takes her accounts, you can move `alice-example/` to a new source named after the new person and adjust scoping accordingly).

Same shape for `internal/`: `internal/alice-example/` for her HR docs, `internal/bob-example/` for his, `internal/legal/` for legal docs everyone can read, etc.

Now sync everything:

```bash
gbrain sync --all
```

Each source syncs in parallel under its own lock so they don't step on each other. Output looks like:

```
[shared]    100/100 pages
[customers] 240/240 pages
[internal]   85/85 pages
✓ all sources synced
```

Check the dashboard:

```bash
gbrain sources status
```

You should see all three sources with recent sync timestamps and page counts.

---

## Part 4: Expose the brain over HTTP MCP with OAuth

The personal brain talks to you through the AlphaClaw harness over Telegram. For a company brain we need a path that each teammate's AI client can hit independently. The HTTP MCP server is that path.

```bash
gbrain serve --http --port 3131 --bind 0.0.0.0
```

The `--bind 0.0.0.0` is important. By default the server binds to localhost only, which is correct for a personal install but blocks remote teammates. Setting `0.0.0.0` accepts connections from any interface.

The server prints an admin bootstrap token to stderr on first start. Save it. You'll use it once for the admin dashboard.

For development, tunnel the local server out via ngrok:

```bash
ngrok http 3131 --domain your-brain.ngrok.app
```

For production, put your server behind a real hostname with a real TLS certificate. Let's call your final URL `https://brain.acme-co.com` for the rest of this tutorial.

Re-run the server with the public URL so the OAuth discovery metadata matches what clients hit:

```bash
gbrain serve --http --port 3131 --bind 0.0.0.0 --public-url https://brain.acme-co.com
```

You should be able to hit `https://brain.acme-co.com/health` and get `{"status":"ok"}` back.

---

## Part 5: Register one OAuth client per teammate

Each teammate (or each AI agent for a teammate) gets their own OAuth client. The client controls what they can write and what they can read.

```bash
# Alice (sales): writes customers/alice-example, reads customers + shared
gbrain auth register-client alice-example \
  --grant-types client_credentials \
  --scopes read,write \
  --source customers \
  --federated-read customers,shared

# Bob (ops): writes internal/bob-example, reads internal + shared
gbrain auth register-client bob-example \
  --grant-types client_credentials \
  --scopes read,write \
  --source internal \
  --federated-read internal,shared

# Carol (legal): writes shared/legal, reads all three
gbrain auth register-client carol-example \
  --grant-types client_credentials \
  --scopes read,write \
  --source shared \
  --federated-read shared,customers,internal
```

Each `register-client` command prints a `client_id` and a `client_secret`. Save both for each teammate. They go into the teammate's local agent config.

A note on the flags:

- `--scopes read,write` lets the client query the brain and write new pages. You can omit `write` for read-only clients (executive summaries, dashboards). The `admin` scope is needed for operational commands like `gbrain remote doctor` and is usually reserved for your own admin client.
- `--source` controls write authority. A client can only write to one source. Within that source, your folder convention from Part 3 keeps each person's writes in their own subfolder.
- `--federated-read` controls read scope. A client can read from one or more sources.

### Verify the scoping actually scopes

Before you hand the brain to teammates, verify isolation. Two terminal windows on your local machine using each client's credentials:

```bash
# Terminal 1, as alice
export GBRAIN_REMOTE_CLIENT_ID=<alice's client_id>
export GBRAIN_REMOTE_CLIENT_SECRET=<alice's client_secret>
export GBRAIN_REMOTE_MCP_URL=https://brain.acme-co.com/mcp

gbrain search "performance review" --remote
```

Alice should see results only from `customers` and `shared`. The performance-review notes live in `internal`, which she's not scoped to read. She shouldn't see them.

```bash
# Terminal 2, as bob (export his credentials similarly)
gbrain search "performance review" --remote
```

Bob should see the performance-review notes from `internal`, plus anything related from `shared`. He shouldn't see anything that lives only in `customers`.

If both queries return correctly scoped results, isolation is working.

---

## Part 6: Set up per-person crons

The personal-brain install runs the dream cycle (overnight enrichment) once per night for one user. A company brain needs per-person crons because each teammate has their own context: alice wants a 7am customer-pipeline digest, bob wants a 9am ops-status report, carol wants a contract-compliance check every Monday.

Each cron is just a scheduled `gbrain agent run` call scoped to the teammate's client credentials. The schedule lives in the workspace repo (the one AlphaClaw deployed in the personal-brain tutorial), in a `crons/` directory. A typical layout:

```
your-org/myagent/
└── crons/
    ├── alice-example/
    │   └── 07am-customer-digest.md
    ├── bob-example/
    │   └── 09am-ops-status.md
    └── carol-example/
        └── monday-contract-compliance.md
```

Each cron file declares its schedule and the prompt that the agent runs:

```markdown
---
schedule: "0 7 * * *"
client: alice-example
---

# Customer pipeline digest

Pull every customer page in customers/alice-example/ that had activity in
the last 7 days. For each, summarize what changed and what the next action
is. Output as a markdown digest, post to Slack #alice-customers, save a
copy to customers/alice-example/digests/YYYY-MM-DD-pipeline.md.
```

The `client:` field tells the cron runner which OAuth client to use, which enforces the scoping. Alice's cron can only read alice's sources and write to alice's folder. It cannot accidentally touch bob's customer notes.

To install the cron schedule, commit the file to the workspace repo and let AlphaClaw pick it up on next deploy. The cron-scheduler skill (one of the 60 that GBrain installed) handles the dispatch.

---

## Part 7: Add per-person skills

The 60+ skills GBrain installs are generic. Your team probably wants a few that are specific to them. Examples:

- `onboarding-new-hire`. Only carol (HR) runs this. Walks through generating a welcome packet, scheduling intro meetings, provisioning accounts.
- `customer-success-followup`. Only alice (sales) runs this. Pulls latest customer page, drafts a follow-up email, posts to her review queue.
- `weekly-team-digest`. Only you (admin) run this. Aggregates everyone's published pages into one weekly summary.

Skills are just markdown files in the workspace repo's `skills/` directory. The shape:

```
your-org/myagent/
└── skills/
    ├── onboarding-new-hire/
    │   └── SKILL.md
    ├── customer-success-followup/
    │   └── SKILL.md
    └── weekly-team-digest/
        └── SKILL.md
```

Each `SKILL.md` declares the trigger (verbs in plain English the agent listens for) and the procedure. Use the `gbrain skillify scaffold <name>` command to generate the boilerplate:

```bash
gbrain skillify scaffold onboarding-new-hire
```

That creates the directory + SKILL.md + routing entry. Edit the SKILL.md to describe the procedure, commit, deploy. The agent picks up the new skill on next request.

Per-person scoping for skills is handled at the routing layer: a skill can declare `allowed_clients: [carol-example]` in its frontmatter. If alice asks her agent to run that skill, the agent refuses with "this skill is scoped to carol-example."

---

## Part 8: Connect each teammate's AI client

Each teammate runs their AI client (Claude Code, Cursor, Claude Desktop, OpenClaw, Hermes, whatever) configured to point at your brain server through their OAuth credentials.

Recommended path for each teammate: the thin-client install. On their machine:

```bash
curl -fsSL https://bun.sh/install | bash
bun install -g github:garrytan/gbrain

gbrain init --mcp-only \
  --issuer-url https://brain.acme-co.com \
  --mcp-url https://brain.acme-co.com/mcp \
  --oauth-client-id <their client_id> \
  --oauth-client-secret <their client_secret>
```

The thin-client install creates a local config that knows how to talk to your brain but never opens its own database. Most CLI commands route through the remote server transparently.

Now they configure their AI client. For Claude Desktop, the teammate adds an MCP server entry in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "company-brain": {
      "command": "gbrain",
      "args": ["serve"]
    }
  }
}
```

When Claude Desktop launches, it talks to the local `gbrain serve` stdio bridge, which forwards every request to your remote brain over HTTPS with their OAuth token attached. From Claude Desktop's perspective it's just one MCP server.

For Claude Code, Cursor, OpenClaw, Hermes, and other clients, per-client setup steps live in [`docs/mcp/`](../mcp/). They all follow the same shape: point the agent at the local `gbrain serve` bridge, which knows about the remote.

---

## Part 9: First real query as a teammate

Have alice run a real query from her machine. The interesting verb is `gbrain think`, which gives back a synthesized answer instead of raw pages.

```bash
gbrain think "What's the latest update from acme-co? When did we last talk to them?"
```

What alice gets back, assuming the brain has been syncing for a week and her sources contain a customer page for acme-co and several meeting notes:

```
## Answer

The most recent customer contact with acme-co was a renewal-discussion
meeting on 2026-05-18, attended by alice-example and acme-co's CTO. Key
points discussed [customers/alice-example/meetings/2026-05-18-acme-renewal]:

- They are upgrading their plan from team to enterprise.
- Annual contract value is moving from $48K to $180K.
- Decision driver: a new compliance requirement they have to meet by Q3.

Prior contact was a quarterly check-in on 2026-04-03 [customers/alice-example/meetings/2026-04-03-acme-q2-checkin].

**Gap noted:** No customer-success notes have been filed since the
2026-05-18 renewal meeting. If a follow-up has happened, it's not in
the brain yet.
```

Three things to notice:

1. **Sourced.** Every claim cites the meeting note it came from.
2. **Synthesized.** Alice didn't read three pages and stitch them together. The brain did.
3. **Honest about gaps.** The brain knows what it doesn't know and says so, instead of inventing a follow-up that didn't happen.

That last part is the gap analysis. It's the part of the brain layer that nobody else ships.

Bob asking the same question would get nothing about acme-co. He's not scoped to read `customers`. He'd see his own internal-ops content if he asked something relevant to that. Carol asking would see both, because she's scoped to read all three sources.

---

## Part 10: Operating the company brain

Three commands do most of the operational work.

### Background daemon: `gbrain autopilot`

The personal-brain install already turned this on. For a company brain, the same autopilot covers all your sources because they live in one database. It runs every five minutes; on a healthy brain (health score 95+) it sleeps; on a brain that's drifting it submits targeted maintenance jobs.

### Self-healing: `gbrain doctor --remediate`

```bash
gbrain doctor --remediate --yes --target-score 90 --max-usd 5
```

Computes a dependency-ordered plan of maintenance jobs that would raise the brain's health score to the `--target-score`, runs the plan, refuses to spend past the `--max-usd` cap. Safe to cron.

### Monitoring: `gbrain sources status` and the admin dashboard

```bash
gbrain sources status
```

Returns a per-source dashboard: when each source last synced, how many pages, how many embedded, how many unacked sync failures. The at-a-glance health check.

The admin dashboard at `https://brain.acme-co.com/admin` shows live request volume, registered OAuth clients, recent activity, and brain stats. Use the admin bootstrap token from Part 4 to log in the first time, then register additional admin users from inside the dashboard.

---

## Part 11: Cost and speed expectations

Real numbers from the published benchmark, running the default stack (GBrain with ZeroEntropy for embedding + reranker):

- **Embedding cost:** $0.05 per million tokens. For comparison, GBrain configured with OpenAI is $0.13 (2.6× more expensive), Voyage is $0.18 (3.6× more).
- **Ingest speed:** about 22 seconds for a small test corpus of 164 pages on the host machine. For a 10K-page corpus, expect about 20 minutes the first time, then most syncs are incremental and finish in seconds.
- **Query latency:** about 122 ms median for a `gbrain search`. For comparison, the same query through GBrain with OpenAI takes about 282 ms.
- **Synthesized-answer latency:** a few seconds, dominated by the Anthropic API.
- **Retrieval quality:** on the public LongMemEval benchmark, GBrain hits 97.60% recall at the top 5 retrieved sessions, beating the previous published state of the art at 96.6%. On the in-house BrainBench corpus of relational queries, GBrain beats commodity vector retrieval by 38 percentage points, because the graph layer surfaces relationships that vector similarity alone misses.

Full methodology and per-run receipt JSONs live in [the gbrain-evals repo](https://github.com/garrytan/gbrain-evals/blob/main/docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md).

For a 25-person company at sustained use, expect about $35 a month in embeddings (ZeroEntropy at $0.05/million tokens), $50 a month in Anthropic calls for the synthesized-answer queries, plus your hosting bill. Under $100 a month for the AI side at most companies your size.

---

## Part 12: Common gotchas

### "My teammate can't see anything"

Check `gbrain auth list` on the host and confirm their client has `--source` set to a source that actually exists. Empty or null `--source` means the client falls through to the `default` source, which probably has no content if you set up three named sources.

### "Sync is slow and feels stuck"

The first sync embeds every page, which takes time. Check `gbrain sources status` for the live page count. If it's climbing you're not stuck, you're just embedding. If you've got a 10K-page corpus and ZeroEntropy is being throttled, the per-source parallel sync looks like progress on three sources at once rather than one source moving fast.

### "I see a page I shouldn't see"

This shouldn't happen, but if you suspect it, run `gbrain search <query> --remote --json` as the constrained client and inspect the `source_id` field on every returned result. Every row should be in the client's `--federated-read` set. If one isn't, file an issue with the exact slug and source IDs.

### "The synthesized answer is wrong"

The brain layer is grounded in the retrieved pages. If the retrieved pages contain bad information, the answer will too. The gap-analysis note often catches this: if the answer says "based on retrieved pages from date X" and date X is six months ago, the brain is telling you the information is stale. Run `gbrain sync --all` to refresh and try again.

### "OAuth `/token` endpoint returns 401 for my client"

Verify the client secret matches what was printed at register-client time. The server stores only a SHA-256 hash; if you lost the original, you have to revoke the client and re-register. Use `gbrain auth revoke-client <client_id>` and re-run `register-client`.

### "Postgres connection is exhausting"

Each parallel sync worker opens its own pool. With three sources and the default four workers per source, you can hit your Postgres connection limit if it's set low. Either reduce the worker count with `gbrain sync --all --parallel 2 --workers 2`, or raise your Postgres `max_connections` to at least 100. Supabase's free tier defaults to 60, which is tight.

### "I want to add a fourth teammate but they need access to all three sources"

```bash
gbrain auth register-client diana-example \
  --grant-types client_credentials \
  --scopes read,write \
  --source shared \
  --federated-read shared,customers,internal
```

That's it. Add or rotate teammates as the org grows.

---

## What you built

You now have the personal-brain agent from the previous tutorial, plus a multi-user shared layer on top: three federated sources holding shared, customer, and internal-only content; per-person folders inside each source so teammates' writes don't collide; per-person OAuth clients with scoped read and write; per-person crons that run on each teammate's own schedule with their own scoping; per-person skills the agent only runs for the right person. Each teammate queries the brain in plain English through their AI client and gets back synthesized, sourced answers that are correctly scoped.

What to do next:

- **Wire ingestion** from external systems (Granola, Linear, Slack) using the [ingestion source contract](../skillpack-anatomy.md). Most companies want their meetings auto-ingested so the brain stays current without anyone typing notes.
- **Set up team-specific dashboards** through the admin UI. Each team lead can have their own view of brain health and activity.
- **Explore the rest of the brain layer.** `gbrain whoknows` (find the expert on a topic), `gbrain find_trajectory` (how a metric changed over time), `gbrain founder scorecard` (especially useful for VC and ops teams), the contradiction-detection cycle that surfaces conflicts between different people's notes.

If you're building in this space (which YC has flagged as the [company-brain category in its Request for Startups](https://www.ycombinator.com/rfs#company-brain)), you might as well build on this. Everything described above is open source, MIT licensed, and what I run in production behind my own AI agents.

Questions, gotchas, or wins worth sharing? Open an issue at [github.com/garrytan/gbrain](https://github.com/garrytan/gbrain/issues).

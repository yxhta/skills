---
name: design-doc
description: Write an effective software design document, based on the approach from refactoringenglish.com's "How to Write an Effective Design Document". Use whenever the user wants to write, draft, review, or improve a design doc, technical design, RFC, or 設計ドキュメント/デザインドック — and also when they're planning a project that involves multiple people, months of work, cross-team coordination, or high-cost decisions, even if they never say "design doc" explicitly.
argument-hint: '[project or feature to design] [known constraints]'
---

# Writing an Effective Design Doc

A design doc exists to force deliberate thinking about high-cost decisions *before* implementation, and to let other people meaningfully critique and coordinate on those decisions. It is not an implementation blueprint, a task list, or a formality. Every choice below follows from that purpose.

## Step 1: Decide whether a design doc is warranted

Before writing anything, check the project against these risk indicators:

- Requires multiple people coordinating work
- Spans more than ~3 months of full-time development
- Will run in production for years
- Involves cross-team collaboration
- Has ambiguous goals or requirements
- Carries catastrophic risk (security, legal, data loss)

One "yes" suggests a design doc has value; two or more makes it nearly essential. If none apply, say so — recommend a lighter artifact (a short note, an issue comment) or none at all. Writing a heavyweight doc for a two-day change wastes everyone's time and erodes trust in the docs that matter.

Scale the depth to the risk: a doc can be one page or twenty. Match the team's stakes, not a template's length.

## Step 2: Gather what you need before drafting

A design doc written from thin air will be generic and useless. Before drafting, establish (from the conversation, the codebase, linked tickets — or by asking the user):

1. **The problem and its motivation** — why now, what breaks if nothing is done, prior attempts and why they failed
2. **The hard decisions** — which choices would be expensive to reverse (language, architecture, storage, protocol, data model)
3. **Constraints** — budget, deadlines, infrastructure, compliance, team skills
4. **Stakeholders and readers** — who must sign off, who will read this without any prior context
5. **Alternatives already on the table** — the "why not X?" questions reviewers will inevitably ask

If key facts are missing and the user is available, ask targeted questions rather than inventing plausible-sounding details. Fabricated specifics (invented latency numbers, made-up team constraints) are worse than an explicit `TODO(author)` marker, because they look authoritative.

## Step 3: Select sections by "penalty for being wrong"

The single filter for what belongs in the doc: **what's the penalty for being wrong?**

- **Include** decisions whose reversal costs weeks of rework: architecture, storage backend, language/framework, public interfaces, data retention.
- **Exclude** decisions reversible in hours: UI pagination style, internal naming, minor library picks. Documenting these turns the doc into a micromanaging blueprint and buries the decisions that matter.

Not every doc needs every section. Pick from the catalog below based on what's actually at stake, and omit sections that would be empty or perfunctory.

## Section catalog

### Header

- **Title** — short, speakable, distinctive, conceptually evocative. "RecencyBank" beats "Project Flying Silver Horse" and beats "Design Document for the New Caching Layer v2".
- **Metadata** — author + contact, creation date, status (draft / in review / approved / implemented), authoritative URL if the doc lives somewhere canonical.

### Context

- **Objective** — one sentence, plain language, understandable by any stakeholder including non-engineers.
- **Background** — why this project exists, what problem it solves, what was tried before. This section must stand alone: assume the reader arrived with zero context and no one available to explain. This is the most commonly under-written section — a reader who doesn't understand the "why" can't evaluate any decision that follows.
- **Related documents** — PM specs, test plans, design docs of adjacent systems, previous iterations.

### Goals and scope

- **Goals** — high-level outcomes framed as user/team/company benefit, never as implementation.
  - Bad: "Add Kubernetes to our infrastructure"
  - Good: "Minimize outages caused by version deployments"
  The implementation choice belongs in the design sections, where it can be challenged; a goal stated as an implementation smuggles the conclusion past review.
- **Non-goals** — explicitly fence off what's out of scope. Readers fill silence with assumptions; a caching project should say whether it's app-specific or intended as reusable infrastructure, because someone will assume the one you didn't mean.

### Making it concrete

- **Scenarios** — step-by-step walkthroughs of the completed system in realistic use. A reader should be able to picture the finished thing working.
- **Diagrams** — data flow, component interactions, trust boundaries. Use editable, text-friendly formats (Mermaid, D2, Excalidraw, draw.io) and link the source. Never lock a diagram into a whiteboard photo or a screenshot nobody can edit. In Markdown docs, prefer Mermaid so the diagram lives in the doc itself.
- **Glossary** — define internal tools and jargon for newer teammates and external stakeholders. Better still, define terms inline at first use so readers don't have to jump around.

### Technical design

- **Interfaces** — API/CLI specifications, file formats, rough UI sketches, code structure examples. Rough is fine; the point is to expose the shape of the contract for critique.
- **Dependencies and infrastructure** — languages, hosting, where data persists. Focus on the hard-to-change choices; skip trivially swappable ones.
- **Constraints** — hardware, budget, client requirements, dependency availability.

### Service quality

- **SLOs** — measurable targets, because "performant" is uncheckable. Example: "50th-percentile HTTP latency ≤ 200ms at 1,000 req/s". Cover availability, latency, and scale as relevant.
- **Monitoring and alerting** — how SLO violations get detected, and what triggers a page vs. a ticket.
- **Timeline** — milestones that each deliver a useful artifact (mockups before implementation, a walking skeleton before features), not just calendar dates.

### Risk

- **Security** — threat model, attack surface, trust boundaries.
- **Privacy** — what sensitive data exists, retention, access controls, encryption at rest and in transit.
- **Legal** — regulatory compliance, contracts, open-source licensing.
- **Logging** — what's captured, retention, access, and what sensitive data must be excluded.

### Decisions and open questions

- **Open issues** — unresolved problems, honestly stated, each with the problem, candidate solutions, and a next step. An open issue with a next step invites help; one without reads as neglect.
- **Resolved issues** — moved from Open once decided, discussion retained. The reasoning trail is often more valuable than the decision itself.
- **Alternatives considered** — preempt the "why not X?" questions. Cover the strong contenders with the decisive factor for rejection; don't pad with strawmen nobody would have suggested. If reviewers keep asking about an option you didn't list, that's a signal it belonged here.

## Step 4: Draft, then self-review

Write the doc in the language the user is working in (e.g. Japanese docs for a Japanese-speaking team), keeping code, API names, and established technical terms as-is.

Before presenting the draft, check it against the failure modes that make design docs useless:

1. **Does the Background stand alone?** Could a new hire with zero context understand why this project exists?
2. **Are Goals outcomes, not implementations?** Any goal naming a technology should be reframed.
3. **Are Non-goals present?** If you can't think of any, you haven't found the scope boundary yet.
4. **Is every section earning its place?** Delete sections that restate the obvious or document trivially-reversible choices.
5. **Are quality claims measurable?** Replace "fast", "scalable", "reliable" with numbers or delete them.
6. **Are open questions honest?** A doc claiming everything is decided is either trivial or hiding something; reviewers trust docs that show their uncertainty.
7. **Would a skeptical senior engineer's first three "why not X?" questions be answered** by Alternatives Considered?

## After drafting

Remind the user that the doc's purpose is fulfilled through review: share it with the team, collect feedback on the high-cost decisions, and move Open Issues to Resolved as they settle. Offer to iterate on specific sections rather than regenerating the whole doc.

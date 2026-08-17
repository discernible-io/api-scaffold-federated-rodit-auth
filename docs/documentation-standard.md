# Documentation Standard

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-24

These principles govern how all documentation in this repository is written and maintained.

1. **Single Source of Truth**: [`api-docs/swagger.json`](../api-docs/swagger.json) is authoritative for all endpoints in this repository (see [Service-relative links](#service-relative-links))
2. **No Duplication**: Technical details live in one place; other docs reference them. The only exception is a **convenience procedure** (principle **19**): a step-by-step how-to that would otherwise force readers to assemble steps from multiple authoritative documents.
3. **Layered Complexity**:
   - **Operational**: `docs/` — deployment, configuration, and operations
   - **Interactive**: Runtime API (`/api-docs`, [`api-docs/swagger.json`](../api-docs/swagger.json)) — live exploration
4. **Cross-Referencing**: Docs link to each other and to runtime endpoints
5. **Offline Availability**: All docs are static files (no database lookups required)
6. **Self-Contained Topics**: When treating a subject, keep it self-contained and to the point. Mention things once rather than spreading related information across multiple places in the same document
7. **Positive, Actionable Guidance**: Write instructions as clear actions the reader can execute immediately. Prefer "Do X with Y result" over prohibitions, and use "Avoid X by doing Y" only when risk context is required.
8. **Consistent Terminology**: Keep one terminology lane per document so the guidance remains immediately actionable
9. **Descriptive File Names**: File names define the topic of each document and must be carefully chosen. A file's name should clearly indicate its subject matter without requiring the reader to open it. Use the preferred **document type** in the name when it applies (principle **20**)
10. **Complete Indexing**: All documentation files must be referenced at least once in `README.md`. Every document in the codebase should be discoverable through the master index to ensure no documentation is orphaned or forgotten
11. **Meaningful Cross-References**: Documents should reference other files only when the target materially improves reader outcomes. Every cross-reference must be purposeful—removing it should make the document less useful
12. **Proven Reference Implementation**: When documenting a pattern, convention, or deployment shape, provide a **proven reference implementation**—a concrete, working example readers can follow or compare against—not placeholders alone.

    - **Pin versions when possible** — package versions, image tags, config schema versions, API contract versions, git refs, or similar — so the example stays reproducible and auditable.
    - **Label the reference clearly** — for example *Reference (SignSanctum)*, *Reference (SignPortal)*, *Reference (clienttestapi)* — and give real paths, commands, and values from that implementation.
    - **Prefer what is deployed or maintained** — reference a service, workflow, or client that exists in the codebase or is known to run in production/staging; do not invent hypothetical layouts.
    - Do not use *this repo* as a stand-in for a different named service.
    - If no proven implementation exists yet, say so explicitly and link to the tracked work; do not present an aspirational example as if it were live.

    **Example (deployment path):**

    | Reference | Content |
    | --- | --- |
    | Reference (SignSanctum) | Deploy to `~/signsanctum-app` using the host layout in [`cicd-deployment-standard.md`](cicd-deployment-standard.md). |
    | Reference (SignPortal) | Deploy to `~/signportal-app` with the same pattern; call out any SignPortal-specific env keys or nginx paths from that repo’s pinned config. |

13. **Reference Examples Stay Stable**: Concrete references in documentation (for example *Reference (clienttestapi)*, *Reference (SignSanctum)*, or other service names and paths) illustrate a reusable pattern. Do **not** update those references to match a different consuming repository unless someone explicitly asks for that change.
14. **Service-relative links**: Paths such as `../src/app.js`, `../config/default.json`, `../api-docs/swagger.json`, and `../scripts/*.sh` are written for **`docs/` at the root of this repository**. They resolve beside application code. Prefer service-relative links over hard-coding a hosting URL so the same markdown works across clones.
15. **Editor notice in document headers**: Every markdown file under `docs/` must include the following blockquote immediately after the document title (or, if the file uses YAML frontmatter, immediately after the closing `---` of that frontmatter):
    > **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

    Do not remove or reword this notice when updating other sections. New documents added under `docs/` must include it before the first body section.
16. **Visible document date**: Include the document creation date in the body (for example on the line immediately after the editor notice), formatted as `YYYY-MM-DD`. Readers should not need file metadata or version control to know when the document was created.
17. **Structure labels stay internal**: The principles and labels in this standard (for example *Single Source of Truth*, *No Duplication*, *documented only in this section*) guide authors and maintainers. In end-user documentation—guides, MCP resources, API descriptions, policies, and similar reader-facing material—do **not** expose that internal structure by default. Tell readers what to use and how to act. Surface structure or meta-labels only when doing so clearly serves another principle above (for example a purposeful cross-reference to the authoritative section, or wording that helps the reader complete a task without hunting duplicate copies).
18. **Avoid documentation sprawl**: Do not proliferate indices, quick-reference cards, “start here” pages, or orientation guides that cover the same navigation job. Prefer **one** entry point per audience or topic (for example a single README section, one quick-reference doc, or one setup guide)—then link outward to authoritative detail. Add a new index or quick-reference file only when it has a **distinct, non-overlapping** role that cannot be a section in an existing doc without making that doc unwieldy. If two documents both answer “where do I start?” or “what are the paths/URIs?”, merge or demote one to a cross-reference rather than maintaining parallel “30-second,” “quick,” and “complete” indexes for the same surface. **Only `README.md` is meta**—navigation, discovery, and pointers to other docs belong there. Every other document should be **content-rich** (procedures, schemas, examples, troubleshooting) rather than **metadata-rich** (tables of links, “start here” chains, or restatements of what other files contain).
19. **Convenience procedures (controlled duplication)**: Duplicate technical detail only when you need a **step-by-step how-to** so readers can complete a procedure in one place instead of piecing it together from several authoritative documents.

    - **Purpose** — end-to-end execution (deploy, rotate credentials, onboard a service), not parallel summaries, indexes, or “quick” restatements of the same topic (principles **2**, **6**, and **18** still apply).
    - **Authoritative links** — every duplicated fact must cite the section or file that owns it; readers must be able to jump to the source of truth.
    - **Convenience notice** — include a short note near the top of the procedure (for example immediately after the editor notice) stating that the document is a **convenience copy** for workflow, that **authoritative changes belong in the owning sections first**, and that this how-to should be updated afterward only when needed to keep the steps accurate.

    **Example (notice block):**

    > **Convenience document:** This how-to assembles steps from authoritative sections so you can run the procedure in one place. Change the owning documents first ([`configuration-standard.md`](configuration-standard.md), [`cicd-deployment-standard.md`](cicd-deployment-standard.md), …); update this file only to reflect those changes in the walkthrough.

    Name convenience procedures as **howto** documents (principle **20**), for example `deploy-service-howto.md`.

20. **Preferred document types**: Assign each document one primary type from the table below and reflect it in the file name (principle **9**). Other terminology (guide, runbook, checklist, constitution, …) is admissible when no preferred type fits, but prefer the types below so readers and maintainers can predict content and maintenance expectations.

    | Type | Use for | File name pattern |
    | --- | --- | --- |
    | **standard** | Programming, documentation, and architecture rules for authors and maintainers | `*-standard.md` (for example [`logging-standard.md`](logging-standard.md)) |
    | **policy** | User-facing rules—access, usage, compliance, and product behavior readers must follow | `*-policy.md` |
    | **howto** | Step-by-step procedures and “how to” walkthroughs (including convenience procedures, principle **19**) | `*-howto.md` |
    | **plan** | Backlogs, roadmaps, and explicit lists of work to do | `*-plan.md` |

    When a document spans types (for example a plan that embeds how-to steps), pick the type that matches its **primary** purpose and link to the other form instead of blending suffixes.

## Service-relative links

This section expands principle **14** above. When adding or reviewing links:

- **Inside `docs/`** — use same-directory names (`configuration-standard.md`) or paths relative to the current file.
- **Into application code** — use `../` from `docs/` (for example `../src/app.js`). Valid only when `docs/` is at the consuming repo root.
- **Into sibling repos** — use `../../<repo>/...` when documenting shared infra; document that the path is optional and local to the operator layout.
- **Do not** rewrite service-relative links to absolute hosting URLs solely to satisfy link checkers.

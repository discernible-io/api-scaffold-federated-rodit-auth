# Allowed Fallback Standard

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-24

## What is allowed

Two kinds of fallback are explicitly allowed:

1. **Config fallback** — falling back across configuration layers or defaults that are defined and reviewed as part of the product’s configuration model.
2. **RPC fallback** — falling back between RPC endpoints or transport strategies that are documented and intentional for resilience (for example, a primary and an alternate RPC path).

These are permitted because they are bounded, observable, and part of the intended operational design.

**Logging:** Whenever an allowed fallback is taken, it **must be logged** with enough context to audit the decision (for example: that a fallback occurred, what was skipped or failed, and what was used instead). Silent fallbacks are not allowed.

## What is forbidden

**Any other fallback pattern is forbidden.** Additional fallbacks (silent retries against unrelated paths, heuristic “try something else,” implicit secondary behavior, etc.) tend to mask real failures, blur accountability, and make incidents harder to diagnose. Prefer failing fast and surfacing errors over hiding them behind extra fallback layers.

## Multiple ways to achieve the same outcome

To keep behavior understandable and maintainable, the same logical result might be reachable by two or more mechanisms (for example, different code paths or configuration switches). That is acceptable only when those mechanisms are **mutually exclusive**: at most one of them applies in a given context. Overlapping or stacked paths for the same outcome creates ambiguous precedence, harder testing, and hidden coupling—avoid that by making alternatives explicit and non-overlapping.

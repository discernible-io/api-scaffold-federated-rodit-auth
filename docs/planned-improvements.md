# Planned improvements

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-24

Cross-service backlog referenced by the standards. Items are numbered for stable cross-references; add new rows rather than renumbering existing ones.

| # | Area | Improvement | Status |
| --- | --- | --- | --- |
| 10 | Error handling | Migrate route handlers from ad hoc `res.status(...).json({ error, message?, requestId })` to SDK `errorResponse.sendError()` per [`error-handling-standard.md`](error-handling-standard.md) | Done in this scaffold (2026-06-18); open elsewhere |
| 11 | Error handling | Align global error middleware in `src/app.js` with the standard compact error body and `sendError()` (including `415`, `404`, and uncaught errors) | Done in this scaffold (2026-06-18); open elsewhere |

## Notes

- Track progress in this repository. Keep item numbers stable (other docs may cite them).
- When an item is completed in a service, note the service name and date in the **Status** column or close the row—do not delete the number (other docs may cite it).

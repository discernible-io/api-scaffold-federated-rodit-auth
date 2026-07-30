# Branching model

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-29

## What happened

1. All migration work landed on **`development`** while **`main`** stayed on the pre-migration stack (SDK 6.x, legacy routes).
2. **`legacy`** was created from the old **`main`** tip to preserve that history (`git branch legacy main`).
3. **`development`** was merged into **`main`** so **`main`** is again the primary line with SDK 9.x, CRUDA showcase, and compliance work.
4. **`legacy`** is an **archive only** — no routine commits; use it to diff or rebuild the old stack if needed.

## Branches today

| Branch | Purpose | Auto-deploy |
|--------|---------|-------------|
| **`main`** | Production SLC (`slc.discernible.io:8443` API + `/play`, `/watch`) | Yes |
| **`development`** | Development tier (`slc.dihola.io`, `NODE_ENV=development`) | Yes |
| **`legacy`** | Frozen snapshot of pre-migration `main` | No |

## Day-to-day workflow

- Feature work → branch from **`development`** → PR into **`development`**.
- Promote to **main** → merge **`development`** into **`main`** (or PR), then push **`main`**.

```bash
git checkout main
git merge development
git push origin main
```

## Do not

- Commit new features on **`legacy`** (archive).
- Force-push **`legacy`** unless deliberately rewriting the archive (avoid).

## One-time setup (already done locally)

```bash
# Archive old main
git branch legacy main
git push -u origin legacy

# Promote development to main
git checkout main
git merge development
git push origin main
```

Optional: tag the archive for clarity:

```bash
git tag legacy-pre-sdk9 main^{/-1}   # or: git tag -a legacy-v6.0.0 legacy -m "Pre SDK 9 migration"
git push origin legacy-v6.0.0
```

<!--
Thanks for contributing to OpenYabby!
Please fill in the sections below. Skip what isn't relevant.
-->

## Summary

<!-- One or two sentences: what does this change and why. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Docs only
- [ ] Build / CI / tooling

## Test plan

<!-- How did you verify this works? -->

- [ ] `npx vitest run` passes locally
- [ ] Manually exercised the affected surface (voice / channel / runner / connector — specify):

## Checklist

- [ ] Conventional commit style (`feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `chore: ...`)
- [ ] If a new DB migration was added: file is **idempotent** (`IF NOT EXISTS` / `ON CONFLICT`) **and** the filename is added to the explicit list in `server.js` `startup()`
- [ ] README / CHANGELOG updated if user-facing
- [ ] No secrets, real API keys, or personal paths in the diff
- [ ] No new committed runtime artifacts (logs, `memory.db`, test outputs)

## Related issues

<!-- e.g. Closes #123, Refs #456 -->

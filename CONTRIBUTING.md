# Contributing

- Commit messages follow Conventional Commits: `type(scope): lowercase summary`
  (`feat`, `fix`, `docs`, `test`, `chore`, `ci`, `refactor`). One feature per commit.
- `npm run check` (typecheck, lint, tests) must pass before a pull request is opened.
- `registry/boards.csv` changes only through a reviewed pull request; use the
  "Add a company" issue template to request one.
- No new third-party script, CDN or dependency without a reason written in the pull request.
  Prefer the platform (`fetch`, `URL`, `crypto.subtle`, `node:sqlite`) over packages.
- Treat every string from outside the repository as untrusted; parse it with a zod schema once at
  the boundary.

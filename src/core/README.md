<!-- @generated — DO NOT EDIT. -->

# Vendored `@jotnow/core`

Every file in this directory is a generated copy of a module from
`packages/core/src` in the private jotnow repository, emitted by
`pnpm --filter @jotnow/core emit:mcp-core` and checked in so that
`packages/mcp` stays a self-contained, publishable package with no workspace
dependency. CI re-runs the generator and fails on any difference, so editing
anything here is always the wrong fix: change the source module instead.

The emitted set is the transitive closure of relative imports from core's public
barrel (`index.ts`) — tests and test-only modules are reached by nothing and so
are never vendored. See `plans/desktop-app.md` §4.5 for the decision.

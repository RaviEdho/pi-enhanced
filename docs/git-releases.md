# Git release workflow

Run `/git release ship` to choose a version and send a `vX.Y.Z` tag to a tag-triggered CI workflow. **No `.pi/git-release.json` or other Pi-specific file is needed.** The extension does not build or publish assets itself. For example, Volt runs Windows CI on `main` pushes and publishes a release only when it receives a matching version tag and the build passes. For a package that uses staged npm publishing instead, use [`/git release npm`](npm-releases.md); that workflow does not require tags.

## What Pi uses

- The root `package.json` supplies the current stable `X.Y.Z` version. Pi ships from `origin`’s default branch and creates an annotated `vX.Y.Z` tag. It doesn’t change or create your CI workflow.
- For a plain npm project, Pi uses `npm version X.Y.Z --no-git-tag-version --ignore-scripts --workspaces=false` and verifies the manifest and any tracked npm lockfiles. npm’s version hooks are not run.
- When `package.json` already defines both `version:set` and `version:check`, Pi runs those with `X.Y.Z` and `vX.Y.Z` respectively. This is how Volt keeps its npm, Cargo, and Tauri versions in sync. Projects with detected Cargo/Tauri companion files or another package manager need the two scripts; Pi won’t fall back to bumping just `package.json` there. Review the scripts before approving them. They run with your permissions.
- The bump may only modify recognized, tracked version files: `package.json`, supported lockfiles, and Cargo or Tauri manifests at the root or under `src-tauri/`. If your script needs to update other files, prepare and commit the version manually, then ship that exact version without running the bump.
- With a `github.com` origin and a working `gh` CLI, Pi can look up matching tag-push Actions runs and the GitHub release without extra configuration.

## Ship or check a release

- **`/git release ship`**: pick Patch, Minor, Major, or Custom from a menu that shows the next version numbers. Skip the version menu with `/git release ship patch`, `minor`, `major`, or an exact version such as `0.2.3`.
- **Release notes**: after choosing the version, skip the notes, write them yourself, or ask the selected model to draft them from commit subjects since the latest reachable stable `vX.Y.Z` tag. Review and edit any draft before the normal release approvals. The approved Markdown becomes the body of the annotated tag. A CI workflow must read that body to use it as the release description; an existing workflow that generates its own notes will keep doing so until updated.
- Start on `origin`’s default branch with a clean working tree. Approve any version commands, review the version changes and outgoing commits, then confirm the commit, tag, and push. If your committed version already matches an explicit version, Pi tags that commit without creating another one. The remote must support atomic pushes; Pi never force-pushes.
- **`/git release push v0.2.3`**: retry after a rejected or interrupted push. This reuses the annotated local tag, which must still point at the release branch’s current commit. It won’t move or overwrite a tag. Check status first if the push outcome was unclear.
- **`/git release status v0.2.3`**: check whether the tag is local or remote, and, on GitHub, whether a matching workflow has run or a release is available. A pushed tag is not confirmation of publication.
- **`/git release [previous-tag]`** or **`/git changelog [previous-tag]`**: draft release notes with AI without changing or pushing Git refs.

Shipping requires a trusted project and an interactive session outside Plan Mode. The AI draft is optional; manual notes and skipping work without a model. Cancelling the notes editor stops before any version changes. Cancelling after the bump leaves version edits in the working tree. If the push fails after the commit and tag, both stay local for inspection and retry.

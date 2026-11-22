# npm releases

Pushing to `main` does **not** publish to npm. Stage a version first, then approve it with npm two-factor authentication (2FA) to make it live. No Git tag or GitHub Release is required.

## First release from your terminal (one time)

Commit the changes you want to ship and push them with `git push origin main`, or merge a PR into `main`. Start from a clean local checkout of the exact commit on `origin/main`. Use Node 24, npm 11.15 or newer, and an npm account with 2FA enabled.

**1. Check the package before staging.**

```bash
npm ci
npm run typecheck
npm audit
npm pack --dry-run --ignore-scripts
```

Stop if a check fails. Review the version and file list from `npm pack`; investigate any audit findings before approving a release. Deprecation and pending install-script notices are not audit findings. Don't approve dependency hooks just to silence a warning.

**2. Stage the package.**

```bash
npm login
npm stage publish --ignore-scripts
npm stage list pi-enhanced
```

The first staging can create a public `0.0.0-stage` placeholder, but the staged version and contents are not live. This step starts locally because the package must exist before you can configure its trusted publisher.

**3. Review, approve, and verify.** Review the version and contents under **Staged Packages** on npmjs.com, or replace `STAGE_ID` below with the ID from `npm stage list`. Approval requires 2FA.

```bash
npm stage view STAGE_ID
npm stage approve STAGE_ID
npm view pi-enhanced version
```

`npm view` should report the version you just approved.

## Configure Trusted Publishing

After the first release, add a GitHub Actions trusted publisher under **Settings → Trusted publishing** for [`pi-enhanced`](https://www.npmjs.com/package/pi-enhanced):

| Field | Value |
| --- | --- |
| Organization or user | `RaviEdho` |
| Repository | `pi-enhanced` |
| Workflow filename | `npm-release.yml` |
| Environment | Leave blank |
| Allowed actions | Stage only; leave direct publishing and dist-tag changes disabled |

Configure it when the next release is ready: npm expires unvalidated trust configurations after two days. After verifying the workflow works, set **Publishing access** to **Require two-factor authentication and disallow tokens**.

## Subsequent releases

1. From a clean working tree, run `/git release npm bump` (or select **Prepare npm version commit** from `/git`). Choose `patch`, `minor`, or `major`, review the version changes in both npm files, and approve the local `chore(release): v<version>` commit. You can also specify the bump directly, e.g. `/git release npm bump patch`. The action does not tag, push, or stage the release. Push or merge the commit to `main` yourself. Outside Pi, the equivalent preparation is `npm version patch --no-git-tag-version --ignore-scripts` followed by a manual commit.
2. With the [GitHub CLI](https://cli.github.com/) signed in, run `/git release npm` in Pi (or select **Stage npm release** from `/git`). Confirm the package name, version, and exact commit from `origin`’s `main`. Pi opens no browser and does not use local changes. Follow the Actions link in its notification. If `main` changed between review and dispatch, the run fails before packaging; review the new commit and try again.

   To start the workflow without Pi:

   ```bash
   gh workflow run npm-release.yml --ref main
   gh run list --workflow npm-release.yml --limit 5
   gh run watch RUN_ID --exit-status
   ```

   Replace `RUN_ID` with the ID of the new run from the list. You can also use **Actions → Stage npm release → Run workflow** on GitHub. The optional `expected_sha` input pins the review to a commit: the workflow refuses to package any other commit. Leave it blank to use `main` as of dispatch. The workflow type-checks, packs, and stages the tarball without a stored npm token; success means **staged**, not published.

3. Run `npm stage list pi-enhanced`, review and approve the new stage as above, then check `npm view pi-enhanced version`.

Users can install the approved version with `pi install npm:pi-enhanced`.

## Use this workflow in another repository

`/git release npm` supports GitHub.com repositories with a GitHub `origin`, a root `package.json` on `main`, and this [staging workflow](https://github.com/RaviEdho/pi-enhanced/blob/main/.github/workflows/npm-release.yml) merged to `main`. If you adapt the workflow, keep its filename, the `expected_sha` check before packaging, and the `npm stage publish` step. Configure a stage-only trusted publisher for that repository on npm.

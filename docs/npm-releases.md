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

1. Run `/git release npm` or select **Release to npm** from the `/git` menu. From a clean working tree, choose **Patch**, **Minor**, or **Major** to review the bump in `package.json` and `package-lock.json`. Choose **Commit only** or **Commit & Push** for `chore(release): v<version>`. The push option is available when the branch tracks a remote branch. The review shows the destination, and an ordinary push can include earlier unpushed commits. No Git tag is created. Outside Pi, the equivalent preparation is `npm version patch --no-git-tag-version --ignore-scripts` followed by a manual commit.
2. If the bump is pushed directly to `origin/main` and is still its tip, Pi continues to the staging review. If the version is already on `main`, or the bump reaches it later (for example, after a PR merge), run `/git release npm` and choose **Stage current version** without bumping again. If the push fails, check the upstream and push the existing commit instead of bumping again.

   With the [GitHub CLI](https://cli.github.com/) signed in, confirm the package name, version, and exact commit. **Stage current version** uses the current `origin/main` tip, including any newer changes, and ignores local changes. Follow the Actions link in Pi’s notification. If `main` changes between review and dispatch, the run fails before packaging; choose **Stage current version** again and review the new commit.

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

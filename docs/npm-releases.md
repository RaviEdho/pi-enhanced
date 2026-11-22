# npm releases

The **Stage npm release** workflow packages `main` and submits the tarball to npm using [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/). It runs only when manually dispatched. An npm maintainer must approve the staged version with 2FA before users can install it. No npm token, Git tag, or GitHub Release is needed.

## First release (one time)

1. Merge the workflow and package changes to `main`. On a clean checkout of `main`, use Node 24 and npm 11.15 or newer. Confirm your npm account has 2FA enabled.
2. Run `npm ci`, `npm run typecheck`, and `npm pack --dry-run`. Review the version and files to be shipped.
3. Run `npm login`, then `npm stage publish --ignore-scripts`. For a new name this creates a public placeholder (`0.0.0-stage`); the actual version and contents are not live yet. Review and approve the staged release in **Staged Packages** on npmjs.com, or use `npm stage list pi-enhanced` and `npm stage approve <stage-id>`.

The initial staging is local because there is no package settings page to configure the workflow's trust relationship before the package exists.

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

1. Update the version in `package.json` and `package-lock.json` together (for example with `npm version patch --no-git-tag-version`). Review and merge the version change to `main`.
2. On GitHub, go to **Actions → Stage npm release → Run workflow** and select `main`. The workflow runs type checking, packs the project, and stages that tarball.
3. Review the staged version on npmjs.com and approve it with 2FA. Verify the published version with `npm view pi-enhanced version`.

Users can install the published version with `pi install npm:pi-enhanced`.

# Releasing

octonet is published to npm from a maintainer's machine. Every published version gets a git tag `vX.Y.Z`
on the exact commit it was published from, and a GitHub release whose notes come from CHANGELOG.md.

## Versioning

octonet is 0.x, so:

- **minor** (`0.3.0` → `0.4.0`) for anything breaking or behavioural, and for new features
- **patch** (`0.3.0` → `0.3.1`) for fixes that don't change behaviour callers rely on

Breaking changes are always called out in the CHANGELOG, with what callers need to change.

## Steps

1. **Prepare the release in a PR.** Bump `version` in package.json and add a `## X.Y.Z` section at the top of
   CHANGELOG.md (Added / Changed / Fixed / Internal). Merge it once CI is green.

2. **Publish from an up-to-date master.**

   ```sh
   git switch master && git pull
   git status                      # must be clean: what you publish is what you tag
   corepack yarn install --immutable
   npm publish --access public     # prepublishOnly cleans dist/ and rebuilds
   ```

   `npm publish --dry-run` shows the tarball without publishing.

3. **Tag the published commit and push the tag.**

   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

   npm records the commit it published from, so you can check the tag matches:
   `npm view @noxecane/octonet@X.Y.Z gitHead` should equal `git rev-parse vX.Y.Z^{commit}`.

4. **Create the GitHub release** from that version's CHANGELOG section:

   ```sh
   awk '/^## X.Y.Z/{f=1;next} /^## /{f=0} f' CHANGELOG.md > /tmp/notes.md
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/notes.md --verify-tag
   ```

Never move or delete a tag once its version is on npm.

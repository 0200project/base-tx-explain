#!/bin/sh
#
# The site gate and the site deploy, bound in one process.
#
# WHY THIS EXISTS. site/ does not auto-deploy. Publishing it means: clone the
# separate Pages repo, set the pseudonymous git identity in that fresh clone,
# rsync with three exact --exclude flags, commit, push. That sequence has been
# typed by hand six times in one night, and every step has a way to go quietly
# wrong:
#
#   - Forget --exclude=CNAME and the custom domain dies.
#   - Forget to set user.name/user.email in a fresh clone and the commit lands
#     under the founder's real name on a pseudonymous org. That happened on
#     2026-08-20 and needed an amend and a force-push inside a minute.
#   - Forget `gh auth switch` and it pushes as the wrong account.
#   - rsync reads the WORKING TREE, so anything half-finished sitting under
#     site/ ships whether or not it was ever committed.
#
# scripts/deploy.sh exists for the same reason on the server side, after the
# server gate was defeated twice in one day by being piped into `tail`. A
# pipeline's exit status is the last command's, so the block was swallowed and
# the deploy ran anyway. The rule "don't pipe the gate" did not survive contact
# with a tired session trimming output. This removes the seam the same way: the
# check and the push live in one script with no exit status to lose between
# them.
#
#   scripts/site-deploy.sh [message]
#
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
PAGES_REPO="https://github.com/0200project/0200project.github.io.git"
WORK="${SITE_DEPLOY_WORK:-${TMPDIR:-/tmp}/0200project-pages}"
IDENTITY_NAME="0200project"
IDENTITY_EMAIL="0200project@users.noreply.github.com"

die() { printf '\n  SITE DEPLOY BLOCKED: %s\n\n' "$1" >&2; exit 1; }

# ---- 1. the gate. Not piped, not backgrounded, nothing to swallow exit 1.
sh "$ROOT/scripts/site-check.sh"

# ---- 2. uncommitted site/ work is somebody's draft, and rsync would ship it
DIRTY="$(git -C "$ROOT" status --porcelain -- site)"
if [ -n "$DIRTY" ]; then
  printf '\n%s\n' "$DIRTY" >&2
  die "uncommitted changes under site/.

  rsync copies the working tree, not a commit, so these WILL be published
  with no commit to review or trace them back to. If they are another
  session's work in progress, wait rather than committing for them."
fi

# ---- 3. the right GitHub account
if ! gh auth status 2>/dev/null | grep -q 'Logged in to github.com account 0200project'; then
  die "gh is not authenticated as 0200project. Run: gh auth switch --user 0200project"
fi

# ---- 4. a fresh clone every time. A stale one silently deploys against an old
#         base and can revert somebody else's push on top of it.
rm -rf "$WORK"
git clone --quiet "$PAGES_REPO" "$WORK" || die "could not clone the Pages repo"

# Global git config is unset on this machine, so a fresh clone commits as the
# machine's default identity and leaks a real name onto a pseudonymous org.
git -C "$WORK" config user.name  "$IDENTITY_NAME"
git -C "$WORK" config user.email "$IDENTITY_EMAIL"

ACTUAL="$(git -C "$WORK" config user.name)"
[ "$ACTUAL" = "$IDENTITY_NAME" ] || die "git identity did not take (got '$ACTUAL')"

# ---- 5. CNAME carries the custom domain. README and .nojekyll belong to the
#         Pages repo, not to site/. Deleting any of them breaks the site.
rsync -a --delete \
  --exclude=CNAME --exclude=README.md --exclude='.nojekyll' --exclude='.git' \
  "$ROOT/site/" "$WORK/"

for f in CNAME .nojekyll; do
  [ -e "$WORK/$f" ] || die "$f is missing from the Pages tree after rsync. Do not push."
done

if [ -z "$(git -C "$WORK" status --porcelain)" ]; then
  printf '\nsite-deploy: no changes to publish; the live site already matches site/.\n'
  exit 0
fi

printf '\nsite-deploy: publishing\n'
git -C "$WORK" status --short | sed 's/^/  /'

SRC_COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)"
MSG="${1:-Publish site/ from $SRC_COMMIT}"

git -C "$WORK" add -A
git -C "$WORK" commit --quiet -m "$MSG (main $SRC_COMMIT)"
git -C "$WORK" push --quiet origin main

printf '\nsite-deploy: pushed %s -> pages %s\n' "$SRC_COMMIT" "$(git -C "$WORK" rev-parse --short HEAD)"
printf 'site-deploy: the CDN caches for ~10 minutes. Verify against the object store\n'
printf '             rather than the edge if you need to confirm sooner:\n'
printf '             gh api repos/0200project/0200project.github.io/contents/<path>\n'

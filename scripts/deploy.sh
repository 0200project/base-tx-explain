#!/bin/sh
# The gate and the deploy, bound in one process.
#
# WHY THIS EXISTS. predeploy.sh correctly exits 1 when it blocks — and it was
# still defeated twice on 2026-08-26, because it was invoked as
# `predeploy.sh | tail -3 && fly deploy`. A pipeline's exit status is the LAST
# command's, so `tail`'s 0 swallowed the block and the && chain deployed anyway.
# The second time, that shipped another session's work with the gate's
# typecheck and tests never having run against the combined tree. (It passed,
# verified after the fact. That is luck, not process.)
#
# The rule "don't pipe the gate" will not survive contact with the next tired
# session trimming output. This mechanism removes the seam instead: the
# decision and the action live in the same script, and there is no exit status
# to lose between them. Deploy with:
#
#   scripts/deploy.sh
#
# Anything the caller pipes or tails afterwards is cosmetic.
set -e
cd "$(dirname "$0")/.."
bash scripts/predeploy.sh
exec fly deploy --now

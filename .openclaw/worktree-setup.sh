#!/usr/bin/env bash
# Runs in each new OpenClaw-managed worktree before any agent touches it.
# A nonzero exit aborts worktree creation, so a proposal can never start
# from a checkout whose tests do not pass. See docs/OPENCLAW.md.
set -euo pipefail
npm ci
npm test

#!/usr/bin/bash
# Rolls out what is on GitHub's main branch to vps-main: copies these Quadlet units, then the build unit clones
# or updates ~/projects/login42/repo from https://github.com/zoeleu/login42, rebuilds, and the service restarts.
#   deploy/vps/deploy.sh [ssh-target]   (default ubuntu@vps-main)
# Push first: the VPS builds GitHub's main, not this checkout. Secrets (.env, backup.env) are created once, by hand.
set -euo pipefail
target=${1:-ubuntu@vps-main}
here=$(cd "$(dirname "$0")" && pwd)
tar -C "$here" -cz --exclude=deploy.sh --exclude=.env --exclude=backup.env . | ssh "$target" 'mkdir -p ~/projects/login42 && tar -C ~/projects/login42 -xz'
ssh "$target" 'cd ~/projects/login42 && ./setup.sh && systemctl --user restart login42-build.service && systemctl --user restart login42.service && journalctl --user -u login42-build.service -n 50 --no-pager | grep -o "login42-build: .*" | tail -1 && systemctl --user --no-pager status login42.service | head -5'

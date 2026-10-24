#!/usr/bin/bash
# Copies the service source and units to vps-main, (re)builds the image and restarts the service.
#   deploy/vps/deploy.sh [ssh-target]   (default ubuntu@vps-main)
# Secrets are not copied: ~/projects/login42/.env and backup.env are created once, by hand.
set -euo pipefail
target=${1:-ubuntu@vps-main}
root=$(cd "$(dirname "$0")/../.." && pwd)
# Streams tarballs (no rsync needed on either side); app/ is replaced wholesale so deleted files disappear.
tar -C "$root/server" -cz --exclude=node_modules --exclude='.env*' --exclude='.dev.vars*' --exclude='*.sqlite*' --exclude=test . |
	ssh "$target" 'rm -rf ~/projects/login42/app.new && mkdir -p ~/projects/login42/app.new && tar -C ~/projects/login42/app.new -xz && rm -rf ~/projects/login42/app && mv ~/projects/login42/app.new ~/projects/login42/app'
tar -C "$root/deploy/vps" -cz --exclude=deploy.sh --exclude=.env --exclude=backup.env . | ssh "$target" 'tar -C ~/projects/login42 -xz'
ssh "$target" 'cd ~/projects/login42 && ./setup.sh && systemctl --user restart login42-build.service && systemctl --user restart login42.service && systemctl --user --no-pager status login42.service | head -5'

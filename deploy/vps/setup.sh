#!/usr/bin/bash
# Links the Quadlet units into the user's systemd generator directory and reloads, like pelican/setup.sh.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ~/.config/containers/systemd
for unit in login42.build login42-data.volume login42.container restic-backup.build login42-restic-cache.volume login42-backup.container; do
	ln -sf "$PWD/$unit" ~/.config/containers/systemd/"$unit"
done
systemctl --user daemon-reload

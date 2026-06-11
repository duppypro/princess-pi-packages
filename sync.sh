#!/bin/bash

# Sync script to push and pull extensions to/from the global ~/.pi/agent/extensions directory.

GLOBAL_DIR="$HOME/.pi/agent/extensions"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/extensions"

if [ "$1" == "--pull" ]; then
    echo "🔄 Pulling from global ~/.pi/agent/extensions to local repository..."
    cp -r "$GLOBAL_DIR/"* "$REPO_DIR/"
    echo "✅ Pull complete."
elif [ "$1" == "--push" ]; then
    echo "🔄 Pushing from local repository to global ~/.pi/agent/extensions..."
    mkdir -p "$GLOBAL_DIR"
    cp -r "$REPO_DIR/"* "$GLOBAL_DIR/"
    echo "✅ Push complete."
else
    echo "Usage:"
    echo "  ./sync.sh --pull    # Pull latest from ~/.pi/agent/extensions into this repo"
    echo "  ./sync.sh --push    # Push local repo changes to ~/.pi/agent/extensions"
    exit 1
fi
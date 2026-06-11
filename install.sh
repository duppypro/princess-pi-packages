#!/bin/bash
# Install script for Princess-Pi Packages (Global Extensions)

set -e

# Target global extensions directory
GLOBAL_EXT_DIR="$HOME/.pi/agent/extensions"

echo "👑 Cloning/linking Princess-Pi custom global extensions..."

# Create directory if it does not exist
mkdir -p "$GLOBAL_EXT_DIR"

# Get the directory of the script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Copy files
echo "📦 Copying files from $SCRIPT_DIR/extensions/ to $GLOBAL_EXT_DIR/ ..."
cp -r "$SCRIPT_DIR/extensions/"* "$GLOBAL_EXT_DIR/"

echo "✅ Extensions successfully copied to $GLOBAL_EXT_DIR!"
echo "🔄 If you have an active Pi session running, type '/reload' in the prompt to load the new extensions immediately."
echo "🚀 Wherever you launch pi-coding-agent from now on, these extensions will load automatically!"

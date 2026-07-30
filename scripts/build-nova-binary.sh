#!/bin/bash
# Build nova binary for Tauri sidecar

set -e

NOVA_DIR="../nova/packages/nova"
BINARY_NAME="nova"

# Get current platform
OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
    Darwin)
        case "$ARCH" in
            arm64) TARGET="aarch64-apple-darwin" ;;
            x86_64) TARGET="x86_64-apple-darwin" ;;
            *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
        esac
        ;;
    Linux)
        case "$ARCH" in
            x86_64) TARGET="x86_64-unknown-linux-gnu" ;;
            aarch64) TARGET="aarch64-unknown-linux-gnu" ;;
            *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
        esac
        ;;
    MINGW*|MSYS*|CYGWIN*)
        TARGET="x86_64-pc-windows-msvc"
        ;;
    *)
        echo "Unsupported OS: $OS"
        exit 1
        ;;
esac

echo "Building nova binary for $TARGET..."

# Check if bun is available
if ! command -v bun &> /dev/null && [ ! -f ~/.bun/bin/bun ]; then
    echo "Error: bun is not installed. Install with: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

BUN_CMD="bun"
if ! command -v bun &> /dev/null; then
    BUN_CMD="$HOME/.bun/bin/bun"
fi

# Build dependencies first
cd ../nova
npm run build:offline

# Build nova binary
cd packages/nova
$BUN_CMD build --compile ./dist/bun/cli.js --outfile dist/$BINARY_NAME-bin

# Create binaries directory in src-tauri
mkdir -p ../../nova-studio/src-tauri/binaries

# Copy binary with target triple name
cp dist/$BINARY_NAME-bin ../../nova-studio/src-tauri/binaries/$BINARY_NAME-$TARGET

# On Windows, add .exe extension
if [[ "$TARGET" == *windows* ]]; then
    mv ../../nova-studio/src-tauri/binaries/$BINARY_NAME-$TARGET ../../nova-studio/src-tauri/binaries/$BINARY_NAME-$TARGET.exe
fi

echo "✓ Nova binary built: src-tauri/binaries/$BINARY_NAME-$TARGET"

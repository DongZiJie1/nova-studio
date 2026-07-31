#!/bin/bash
# Build nova binary for Tauri sidecar
# Uses the published npm package (not local source)

set -e

PACKAGE_NAME="@dongzijie1/nova"
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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building nova binary for $TARGET from npm package..."

# Check if bun is available
if ! command -v bun &> /dev/null && [ ! -f ~/.bun/bin/bun ]; then
    echo "Error: bun is not installed. Install with: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

BUN_CMD="bun"
if ! command -v bun &> /dev/null; then
    BUN_CMD="$HOME/.bun/bin/bun"
fi

# Create temp directory and install npm package
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo "Installing $PACKAGE_NAME from npm..."
cd "$TMPDIR"
npm init -y > /dev/null 2>&1
npm install "$PACKAGE_NAME"

# Compile to single binary
ENTRY="$TMPDIR/node_modules/$PACKAGE_NAME/dist/bun/cli.js"
if [ ! -f "$ENTRY" ]; then
    echo "Error: Entry point not found at $ENTRY"
    exit 1
fi

echo "Compiling binary..."
$BUN_CMD build --compile "$ENTRY" --outfile "$TMPDIR/$BINARY_NAME-bin"

# Copy binary to src-tauri/binaries/
BINARIES_DIR="$SCRIPT_DIR/../src-tauri/binaries"
mkdir -p "$BINARIES_DIR"

cp "$TMPDIR/$BINARY_NAME-bin" "$BINARIES_DIR/$BINARY_NAME-$TARGET"

# On Windows, add .exe extension
if [[ "$TARGET" == *windows* ]]; then
    mv "$BINARIES_DIR/$BINARY_NAME-$TARGET" "$BINARIES_DIR/$BINARY_NAME-$TARGET.exe"
fi

# Show result
ls -lh "$BINARIES_DIR/$BINARY_NAME-"*
echo "✓ Nova binary built: $BINARIES_DIR/$BINARY_NAME-$TARGET"

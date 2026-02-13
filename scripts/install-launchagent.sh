#!/bin/bash
# Install mac-dash as a LaunchAgent (runs on login)
set -e

LABEL="com.macdash.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN_PATH="$(which bun)"
LOG_DIR="$HOME/Library/Logs/mac-dash"

echo "mac-dash LaunchAgent Installer"
echo "================================"
echo "  Project: $PROJECT_DIR"
echo "  Bun:     $BUN_PATH"
echo "  Plist:   $PLIST_PATH"
echo ""

# Ensure log directory
mkdir -p "$LOG_DIR"

# Build the client first
echo "Building client..."
cd "$PROJECT_DIR"
bun run build

# Unload existing if present
if launchctl list | grep -q "$LABEL"; then
  echo "Unloading existing service..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Create plist
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$BUN_PATH</string>
        <string>server/index.ts</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PORT</key>
        <string>7227</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/stdout.log</string>

    <key>StandardErrorPath</key>
    <string>$LOG_DIR/stderr.log</string>

    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
EOF

echo "Loading LaunchAgent..."
launchctl load -w "$PLIST_PATH"

echo ""
echo "Done! mac-dash is now running at http://localhost:7227"
echo "It will start automatically on login."
echo ""
echo "To uninstall:"
echo "  launchctl unload -w $PLIST_PATH"
echo "  rm $PLIST_PATH"

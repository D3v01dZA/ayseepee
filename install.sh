#!/bin/sh
set -ex

SERVICE_USER="${1:-}"
if [ -z "$SERVICE_USER" ]; then
  echo "Usage: sudo ./install.sh <username>"
  echo "The service will run as the specified user."
  exit 1
fi

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_FILE=/etc/systemd/system/ayseepee.service
ENV_FILE="$INSTALL_DIR/.env"

# Check for root
if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo ./install.sh <username>)"
  exit 1
fi

# Verify user exists
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "User '$SERVICE_USER' does not exist. Create it first."
  exit 1
fi

# Check for node
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node 22+ first."
  exit 1
fi

# Build
cd "$INSTALL_DIR"
npm ci
npm run build

# Create env file if it doesn't exist
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
PORT=3000
API_KEY=changeme
ANTHROPIC_API_KEY=changeme
EOF
  chmod 600 "$ENV_FILE"
  chown "$SERVICE_USER":"$SERVICE_USER" "$ENV_FILE"
  echo "Created $ENV_FILE — edit it with your actual keys"
else
  echo "$ENV_FILE already exists, skipping"
fi

# Install systemd service
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=ayseepee agent server
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
EnvironmentFile=$ENV_FILE

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ayseepee

echo "ayseepee installed and running on port 3000 as user '$SERVICE_USER'"
echo "Edit $INSTALL_DIR/.env and restart: systemctl restart ayseepee"

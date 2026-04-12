FROM node:22-bookworm

# Common development utilities the agent may need
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    jq \
    ripgrep \
    fd-find \
    tree \
    make \
    gcc \
    g++ \
    python3 \
    python3-pip \
    python3-venv \
    openssh-client \
    ca-certificates \
    gnupg \
    less \
    vim-tiny \
    unzip \
    zip \
    && rm -rf /var/lib/apt/lists/* \
    # Docker CLI (for agent to use docker commands in workspaces)
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# fd is installed as fdfind on Debian
RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd

# Build the server
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
COPY public/ public/
RUN npm run build

# Workspace mount point
RUN mkdir -p /workspace

ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]

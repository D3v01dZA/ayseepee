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

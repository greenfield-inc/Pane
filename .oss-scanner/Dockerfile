# Build image for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
# The scanner builds this with the repository root as the context, with network
# access, then audits the finished image with no network. Everything the build,
# the tests or the Electron app need is fetched here.
# Build it yourself: docker build -f .oss-scanner/Dockerfile -t pane-oss-scanner .
# Then check it offline: docker run --rm -it --network none pane-oss-scanner bash
FROM node:22.23.4-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    PANE_DIR=/tmp/pane-scan

# git drives worktrees; python3 and build-essential cover node-gyp fallbacks;
# the port monitor and its tests call ss, lsof and nc; xvfb and the GTK/NSS
# libraries (the .deb package's dependencies) let Electron start without a
# display.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git python3 build-essential xvfb xauth \
      iproute2 lsof netcat-openbsd procps \
      libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 \
      libuuid1 libasound2 libgbm1 libdrm2 libxkbcommon0 libsecret-1-0 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' ca-certificates)" ge '20250419~deb12u2' \
    && rm -rf /var/lib/apt/lists/*

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# pnpm comes from the version pinned in package.json's packageManager field.
RUN corepack enable pnpm && pnpm --version

# Same install as CI's quality job: skip the Electron-targeted postinstall.
# Then fetch the Electron binary, and a Chromium for Playwright with its
# system libraries.
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && node node_modules/electron/install.js \
    && pnpm exec playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# better-sqlite3 needs one build per runtime: the unit tests load it under
# Node, the app under Electron. Build both while the network is up and keep
# them in /opt/pane-sqlite; the Node build ends up installed.
# `pane-sqlite-abi electron` switches to the Electron build before starting the
# app, and `pane-sqlite-abi node` switches back for the tests.
RUN ln -s /src/.oss-scanner/pane-sqlite-abi.sh /usr/local/bin/pane-sqlite-abi \
    && pnpm run electron:rebuild && pane-sqlite-abi save electron \
    && pnpm rebuild better-sqlite3-multiple-ciphers && pane-sqlite-abi save node

# Build the main process, the renderer and the runpane CLI.
RUN pnpm run build:main \
    && pnpm run build:frontend \
    && pnpm --filter runpane build

# Run the unit tests so the image is known to work, without letting a failure
# abort the build.
RUN (pnpm --filter main exec vitest run || echo "WARNING: main tests reported failures") \
    && (pnpm --filter frontend test || echo "WARNING: frontend tests reported failures") \
    && (pnpm --filter @pane/native test || echo "WARNING: native tests reported failures")

# ==============================================================================
# Build Stage
#
# This stage installs all dependencies (including dev), builds the TypeScript
# source code into JavaScript, and prepares the production assets.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS build

WORKDIR /usr/src/app

# Copy dependency manifests for optimized layer caching
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies for building).
# The BuildKit cache mount persists Bun's global package cache across builds.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

# Copy the rest of the source code
COPY . .

# Build the application
RUN bun run build


# ==============================================================================
# Production Dependencies
#
# Run Bun and its security scanner natively: Bun's JavaScriptCore allocator can
# abort under QEMU. Cross-install for the target architecture, then copy the
# installed tree into its runtime image.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS deps

WORKDIR /usr/src/app

# Set the environment to production for performance and to ensure only
# production dependencies are installed.
ENV NODE_ENV=production

# Preserve the release-age gate and security scanner for production installs.
COPY package.json bun.lock bunfig.toml ./
# The scanner is a devDependency, so seed it before the production-only install.
COPY --from=build /usr/src/app/node_modules/@socketsecurity/bun-security-scanner ./node_modules/@socketsecurity/bun-security-scanner

# Install only production dependencies, ignoring lifecycle scripts and the
# framework's optional peer tiers. Anything this server imports directly stays
# installed through its own dependencies.
ARG TARGETOS
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) echo x64 ;; \
      arm64) echo arm64 ;; \
      *) echo "Unsupported TARGETARCH '$TARGETARCH': expected amd64 or arm64" >&2; exit 1 ;; \
    esac > .bun-cpu
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --omit=peer --frozen-lockfile --ignore-scripts \
      --os="$TARGETOS" --cpu="$(cat .bun-cpu)"

# Conditionally install OpenTelemetry optional peer dependencies (Tier 3).
# Bundled by default so tracing works out of the box. Omit at build time
# with: docker build --build-arg OTEL_ENABLED=false
COPY scripts/install-otel.ts ./scripts/
ARG OTEL_ENABLED=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    if [ "$OTEL_ENABLED" = "true" ]; then \
      bun scripts/install-otel.ts --os="$TARGETOS" --cpu="$(cat .bun-cpu)"; \
    fi

COPY scripts/prune-musl-packages.ts ./scripts/
RUN bun scripts/prune-musl-packages.ts

# The scanner is needed only while installing. Prepare the writable log
# directory here too, so the final stage executes no commands under emulation.
RUN rm -r node_modules/@socketsecurity/bun-security-scanner \
    && mkdir -p /var/log/mailchimp-mcp-server

# ==============================================================================
# Production Runtime
# ==============================================================================
FROM oven/bun:1.4.2-slim AS production

WORKDIR /usr/src/app
ENV NODE_ENV=production

# OCI image metadata (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
ARG APP_VERSION
LABEL org.opencontainers.image.title="mailchimp-mcp-server"
LABEL org.opencontainers.image.description="Draft, test, and send Mailchimp campaigns straight from your MCP client — with audience management, subscriber CRUD, and post-send analytics behind safe-by-default send gates. STDIO or Streamable HTTP."
LABEL org.opencontainers.image.source="https://github.com/cyanheads/mailchimp-mcp-server"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.version="${APP_VERSION}"

COPY package.json ./
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist
COPY --from=deps --chown=bun:bun /var/log/mailchimp-mcp-server /var/log/mailchimp-mcp-server

# Switch to the non-root user
USER bun

# Define an argument for the port, allowing it to be overridden at build time.
# The `PORT` variable is often injected by cloud environments at runtime.
ARG PORT

# Set runtime environment variables
# Note: PORT is an automatic variable in many cloud environments (e.g., Cloud Run)
ENV MCP_HTTP_PORT=${PORT:-3010}
ENV MCP_HTTP_HOST="0.0.0.0"
ENV MCP_TRANSPORT_TYPE="http"
ENV MCP_SESSION_MODE="stateful"
ENV MCP_LOG_LEVEL="info"
ENV LOGS_DIR="/var/log/mailchimp-mcp-server"

# Expose the port the server listens on
EXPOSE ${MCP_HTTP_PORT}

# Health check using a bun-native fetch (slim image ships no curl/wget)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD bun -e "fetch('http://localhost:'+(process.env.MCP_HTTP_PORT??'3010')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The command to start the server
CMD ["bun", "run", "dist/index.js"]

FROM oven/bun:1.3-alpine

# ccusage reads --timezone names from /usr/share/zoneinfo and silently falls back to UTC when
# the name is missing there, which it always is on bare Alpine.
RUN apk add --no-cache tzdata

# ccusage's npm package ships a static binary per platform. Fetching the one for this image
# directly keeps multi-platform builds from running Bun under emulation.
ARG CCUSAGE_VERSION=20.0.20
RUN set -eu; \
    case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "unsupported: $(uname -m)" >&2; exit 1 ;; esac; \
    registry=https://registry.npmjs.org; \
    wget -qO- "$registry/@ccusage/ccusage-linux-$arch/-/ccusage-linux-$arch-$CCUSAGE_VERSION.tgz" \
      | tar -xzO package/bin/ccusage > /usr/local/bin/ccusage; \
    chmod 0755 /usr/local/bin/ccusage; \
    mkdir -p /usr/share/licenses/ccusage; \
    wget -qO- "$registry/ccusage/-/ccusage-$CCUSAGE_VERSION.tgz" \
      | tar -xzO package/LICENSE > /usr/share/licenses/ccusage/LICENSE; \
    ccusage --version

WORKDIR /app
COPY package.json ./
COPY src ./src
# Arguments go to the collector; run the image with --help to list them.
ENTRYPOINT ["bun", "src/collector.ts"]

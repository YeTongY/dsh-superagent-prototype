FROM node:24-bookworm-slim AS build

ARG PNPM_VERSION=11.7.0
WORKDIR /opt/dsh-superagent
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN npm install --global "pnpm@${PNPM_VERSION}"
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime

ARG TARGETARCH
ARG DSH_VERSION=0.2.1-rc.3
ARG PNPM_VERSION=11.7.0
ARG GH_VERSION=2.104.0
ARG GLAB_VERSION=1.130.0
ARG REPORTER_BROWSER=0

# The release hashes were checked against the official GitHub and GitLab release assets.
ARG GH_AMD64_SHA256=98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e
ARG GH_ARM64_SHA256=cb34cefc6f4e77b90731374a2b737516bb8f3033c6ca46aa949e5344f68069e3
ARG GLAB_AMD64_SHA256=caf19cb4a842da7dbe4ecf146929f44e037fc733ab3f11945a1a48798497ed51
ARG GLAB_ARM64_SHA256=c94df210185fa4b17c5b8528004ad06572808b198a676ac227d26d5a86dd912b

RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates curl git jq openssh-client procps python3 tmux \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) gh_arch=amd64; gh_sha="${GH_AMD64_SHA256}"; glab_arch=amd64; glab_sha="${GLAB_AMD64_SHA256}" ;; \
      arm64) gh_arch=arm64; gh_sha="${GH_ARM64_SHA256}"; glab_arch=arm64; glab_sha="${GLAB_ARM64_SHA256}" ;; \
      *) echo "Unsupported Docker architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    gh_archive="gh_${GH_VERSION}_linux_${gh_arch}.tar.gz"; \
    curl --fail --location --retry 4 --retry-all-errors "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${gh_archive}" -o "/tmp/${gh_archive}"; \
    echo "${gh_sha}  /tmp/${gh_archive}" | sha256sum --check --status; \
    mkdir -p /tmp/gh; tar -xzf "/tmp/${gh_archive}" -C /tmp/gh; \
    install -m 0755 "/tmp/gh/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh; \
    glab_package="glab_${GLAB_VERSION}_linux_${glab_arch}.deb"; \
    curl --fail --location --retry 4 --retry-all-errors "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/${glab_package}" -o "/tmp/${glab_package}"; \
    echo "${glab_sha}  /tmp/${glab_package}" | sha256sum --check --status; \
    apt-get update; apt-get install --yes --no-install-recommends "/tmp/${glab_package}"; \
    rm -rf /tmp/gh "/tmp/${gh_archive}" "/tmp/${glab_package}" /var/lib/apt/lists/*

RUN npm install --global --omit=dev \
    --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
    "@deepseek-ai/dsh@${DSH_VERSION}" "pnpm@${PNPM_VERSION}"

WORKDIR /opt/dsh-superagent
COPY --from=build --chown=node:node /opt/dsh-superagent/ /opt/dsh-superagent/
COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/dsh-superagent-entrypoint
COPY --chown=node:node docker/profile.patch.yml /opt/dsh-superagent/docker/profile.patch.yml

ENV DSH_HOME=/data/dsh \
    DSH_SUPERAGENT_PROFILE=superagent \
    HOME=/home/node \
    DSH_SUPERAGENT_REPORTER_BROWSER=${REPORTER_BROWSER} \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production

RUN mkdir -p /ms-playwright \
 && if [ "${REPORTER_BROWSER}" = "1" ]; then \
      /opt/dsh-superagent/node_modules/.bin/playwright install --with-deps chromium; \
    fi \
 && rm -rf /var/lib/apt/lists/* \
 && chown -R node:node /ms-playwright

RUN chmod 0755 /usr/local/bin/dsh-superagent-entrypoint \
 && mkdir -p /data/dsh /data/superagent /data/gh /data/glab /data/work \
 && chown -R node:node /data

USER node
WORKDIR /opt/dsh-superagent
ENTRYPOINT ["/usr/local/bin/dsh-superagent-entrypoint"]
CMD ["run"]

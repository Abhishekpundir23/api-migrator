# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

FROM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npm run build:packages
COPY ops/publication-runner/image/prepare-runtime-root.mjs /tmp/prepare-runtime-root.mjs
RUN node /tmp/prepare-runtime-root.mjs /workspace /runtime-root

FROM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS node-root

FROM scratch
ENV PATH=/usr/local/bin:/usr/bin:/bin
COPY --from=node-root / /
COPY --from=build /runtime-root/ /
COPY --chmod=0555 ops/publication-runner/image/api-migrator-runner /usr/local/bin/api-migrator-runner

FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' ca-certificates)" ge 20250419+deb13u1 \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends jq python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/main

RUN yarn install

COPY .yarn .yarn
COPY .yarnrc.yml .yarnrc.yml
COPY package.json package.json
COPY yarn.lock yarn.lock
COPY services services
COPY packages packages

RUN find packages -mindepth 2 -maxdepth 2 -type f -name 'package.json' -exec sh -c "jq '.name' {}" \; | xargs yarn workspaces focus
RUN yarn run build:packages

ARG BASE

FROM $BASE as BUILD
WORKDIR /usr/main/services/compiler-orchestrator
RUN yarn workspaces focus @chicmoz/compiler-orchestrator
COPY . .
RUN yarn build

FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' ca-certificates)" ge 20250419+deb13u1 \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/main/services/compiler-orchestrator
COPY --from=BUILD /usr/main /usr/main

CMD ["yarn", "node", "--unhandled-rejections=strict", "--enable-source-maps", "./build/src/index.js"]

ARG BASE

FROM $BASE as BUILD
WORKDIR /usr/main/services/explorer-api

ARG VERSION_STRING
ENV VERSION_STRING $VERSION_STRING

RUN yarn workspaces focus @chicmoz/explorer-api
COPY . .
RUN yarn build
RUN yarn workspaces focus @chicmoz/explorer-api --production

FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' ca-certificates)" ge 20250419+deb13u1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/main/services/explorer-api

ARG VERSION_STRING
ENV VERSION_STRING $VERSION_STRING

COPY --from=BUILD /usr/main/.yarn /usr/main/.yarn
COPY --from=BUILD /usr/main/.yarnrc.yml /usr/main/.yarnrc.yml
COPY --from=BUILD /usr/main/package.json /usr/main/package.json
COPY --from=BUILD /usr/main/yarn.lock /usr/main/yarn.lock
COPY --from=BUILD /usr/main/node_modules /usr/main/node_modules
COPY --from=BUILD /usr/main/packages /usr/main/packages
COPY --from=BUILD /usr/main/services/explorer-api /usr/main/services/explorer-api

CMD ["yarn", "run", "start"]

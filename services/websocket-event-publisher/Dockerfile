ARG BASE

FROM $BASE as BUILD
WORKDIR /usr/main/services/websocket-event-publisher
RUN yarn workspaces focus @chicmoz/websocket-event-publisher
COPY . .
RUN yarn build

FROM node:22.23.4-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' ca-certificates)" ge 20250419+deb13u1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/main/services/websocket-event-publisher
COPY --from=BUILD /usr/main /usr/main

CMD ["yarn", "run", "start"]

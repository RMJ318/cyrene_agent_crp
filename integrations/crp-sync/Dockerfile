FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.cjs /app/server.cjs
USER node
ENV CRP_SYNC_CONFIG=/run/crp-sync/config.json CRP_SYNC_BIND=0.0.0.0 CRP_BEHIND_TLS_PROXY=1 CRP_SYNC_PORT=8790
CMD ["node", "/app/server.cjs"]

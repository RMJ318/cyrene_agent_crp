FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.cjs ./
COPY mcp.cjs ./
USER node
ENV NODE_ENV=production CRP_BIND_HOST=0.0.0.0 CRP_BEHIND_TLS_PROXY=1 CRP_PORT=8787
EXPOSE 8787
CMD ["node", "server.cjs"]

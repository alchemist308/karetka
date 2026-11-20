FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8080 KARETKA_DB_PATH=/data/karetka.sqlite
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mkdir -p /data && chown node:node /data
COPY --chown=node:node server ./server
COPY --chown=node:node dist ./dist
USER node
EXPOSE 8080
CMD ["node", "server/http.mjs"]

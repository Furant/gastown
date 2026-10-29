FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY web ./web
ENV NODE_ENV=production CONSOLE_HOST=0.0.0.0 CONSOLE_PORT=8770 CONSOLE_TRUST_PRIVATE_BIND=1
USER node
EXPOSE 8770
CMD ["node", "server/index.mjs"]

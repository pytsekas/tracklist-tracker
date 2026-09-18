# syntax=docker/dockerfile:1

# ---- stage 1: build the React client ----------------------------------------
FROM node:22-alpine AS client-build
WORKDIR /app
COPY package.json ./
COPY client/package.json ./client/
RUN npm install --workspace client --include-workspace-root --no-audit --no-fund
COPY client ./client
RUN npm --workspace client run build

# ---- stage 2: production dependencies for the server -------------------------
FROM node:22-alpine AS server-deps
WORKDIR /app
COPY package.json ./
COPY server/package.json ./server/
RUN npm install --workspace server --include-workspace-root --omit=dev --no-audit --no-fund

# ---- stage 3: runtime --------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini wget

# npm hoists workspace deps to the root node_modules; /app/server may or may not
# have a nested one, so take the whole server dir from the deps stage first and
# lay the source on top of it afterwards.
COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=server-deps /app/server ./server
COPY package.json ./
COPY server/src ./server/src
COPY --from=client-build /app/client/dist ./client/dist

RUN chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/src/index.js"]

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY control-plane/package.json control-plane/tsconfig.json ./control-plane/
COPY worker/package.json worker/tsconfig.json ./worker/
RUN npm ci
COPY control-plane ./control-plane
RUN npm run build --workspace @talos/control-plane

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY control-plane/package.json ./control-plane/
RUN npm ci --omit=dev --workspace @talos/control-plane --include-workspace-root=false
COPY --from=build /app/control-plane/dist ./control-plane/dist
COPY control-plane/sql ./control-plane/sql
RUN chown -R node:node /app
USER node
WORKDIR /app/control-plane
ENTRYPOINT ["node", "dist/index.js"]

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY testing-protocol/package.json testing-protocol/tsconfig.json testing-protocol/tsconfig.runtime.json ./testing-protocol/
COPY control-plane/package.json control-plane/tsconfig.json ./control-plane/
COPY worker/package.json worker/tsconfig.json ./worker/
RUN npm ci
COPY testing-protocol ./testing-protocol
COPY control-plane ./control-plane
RUN npm run build --workspace @talos/testing-protocol
RUN npm run build:runtime --workspace @talos/testing-protocol
RUN npm run build:runtime --workspace @talos/control-plane

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY testing-protocol/package.json ./testing-protocol/
COPY control-plane/package.json ./control-plane/
COPY worker/package.json ./worker/
RUN npm ci --omit=dev --workspace @talos/control-plane --include-workspace-root=false
COPY --from=build /app/testing-protocol/dist-runtime ./testing-protocol/dist
COPY --from=build /app/control-plane/dist-runtime ./control-plane/dist
COPY specs/talos-openapi.yaml ./specs/talos-openapi.yaml
RUN chown -R node:node /app
USER node
WORKDIR /app/control-plane
ENTRYPOINT ["node", "dist/index.js"]

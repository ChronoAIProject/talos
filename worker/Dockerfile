FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY testing-protocol/package.json testing-protocol/tsconfig.json testing-protocol/tsconfig.runtime.json ./testing-protocol/
COPY control-plane/package.json ./control-plane/
COPY worker/package.json worker/tsconfig.json worker/tsconfig.runtime.json ./worker/
RUN npm ci
COPY testing-protocol ./testing-protocol
COPY worker ./worker
RUN npm run build --workspace @talos/testing-protocol
RUN npm run build:runtime --workspace @talos/testing-protocol
RUN npm run build:runtime --workspace @talos/worker

FROM mcr.microsoft.com/playwright:v1.49.1-jammy
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY testing-protocol/package.json ./testing-protocol/
COPY control-plane/package.json ./control-plane/
COPY worker/package.json ./worker/
RUN npm ci --omit=dev --workspace @talos/worker --include-workspace-root=false
COPY --from=build /app/testing-protocol/dist-runtime ./testing-protocol/dist
COPY --from=build /app/worker/dist-runtime ./worker/dist
RUN chown -R pwuser:pwuser /app
USER pwuser
WORKDIR /app/worker
ENTRYPOINT ["node", "dist/cli/main.js", "run"]

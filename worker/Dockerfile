FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY control-plane/package.json control-plane/tsconfig.json ./control-plane/
COPY worker/package.json worker/tsconfig.json ./worker/
RUN npm ci
COPY worker ./worker
RUN npm run build --workspace @talos/worker

FROM mcr.microsoft.com/playwright:v1.49.1-jammy
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY control-plane/package.json control-plane/tsconfig.json ./control-plane/
COPY worker/package.json worker/tsconfig.json ./worker/
RUN npm ci --omit=dev --workspace @talos/worker --include-workspace-root=false
COPY --from=build /app/worker/dist ./worker/dist
RUN chown -R pwuser:pwuser /app
USER pwuser
WORKDIR /app/worker
ENTRYPOINT ["node", "dist/index.js"]

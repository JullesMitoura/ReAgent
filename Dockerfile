# ReAgent — multi-stage production image (non-root, reproducible install).
# Build:  docker build -t reagent .
# Run:    docker run --rm -it -v "$PWD:/workspace" -w /workspace --env-file .env -p 8787:8787 reagent
# REPL:   docker run --rm -it -v "$PWD:/workspace" -w /workspace --env-file .env reagent

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY ui/package.json ui/package.json
RUN npm ci
COPY . .
RUN npm run build:web && npm run build \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Drop privileges: the agent must not run as root inside the container.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin reagent \
  && mkdir -p /workspace \
  && chown -R reagent:reagent /app /workspace
COPY --from=build --chown=reagent:reagent /app/package.json /app/package-lock.json ./
COPY --from=build --chown=reagent:reagent /app/node_modules ./node_modules
COPY --from=build --chown=reagent:reagent /app/dist ./dist
COPY --from=build --chown=reagent:reagent /app/bin ./bin
COPY --from=build --chown=reagent:reagent /app/static ./static
COPY --from=build --chown=reagent:reagent /app/scripts ./scripts
USER reagent
WORKDIR /workspace
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENV REAGENT_BIND_HOST=0.0.0.0
ENTRYPOINT ["node", "/app/bin/reagent.js"]
CMD ["serve", "--no-open", "--host", "0.0.0.0", "--port", "8787"]

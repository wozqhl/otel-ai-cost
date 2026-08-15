# stdlib-only Node image; bind 0.0.0.0; USER node
FROM node:20-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node examples ./examples
COPY --chown=node:node openapi ./openapi
ENV NODE_ENV=production
USER node
EXPOSE 8792
# image HEALTHCHECK → /health (liveness; not /ready — drain/circuit/queue would flap)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8792/health || exit 1
CMD ["node", "src/cli.js", "serve", "--host", "0.0.0.0", "--port", "8792", "--in", "examples/spans.json"]

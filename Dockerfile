# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
ENV YARN_NODE_LINKER=node-modules
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases
RUN corepack enable && yarn install --immutable
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN yarn test

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=47016
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 47016
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'require("node:http").get("http://127.0.0.1:47016/health", r => process.exit(r.statusCode === 200 ? 0 : 1)).on("error", () => process.exit(1))'
CMD ["node", "dist/main.js"]

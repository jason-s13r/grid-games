# The first deployment config in this repository.
#
# Built from the workspace root rather than from this folder, because the app
# depends on three workspace packages by `workspace:*` and pnpm needs the whole
# tree to link them:
#
#   docker build -f apps/api/Dockerfile -t tessera-api .

FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
# The manifests first, so a change to source does not reinstall the world.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sim/package.json packages/sim/
COPY packages/protocol/package.json packages/protocol/
COPY packages/net/package.json packages/net/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @tessera/api...
COPY packages/sim packages/sim
COPY packages/protocol packages/protocol
COPY packages/net packages/net
COPY apps/api apps/api
RUN pnpm --filter @tessera/api... build
# The dev dependencies are a TypeScript compiler this image will never run again.
RUN pnpm install --frozen-lockfile --prod --filter @tessera/api...

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/packages packages
COPY --from=build /src/apps/api apps/api
# 0.0.0.0 rather than the CLI's own default: inside a container the loopback
# default that keeps a development board off the network keeps it off everything.
EXPOSE 8081
USER node
ENTRYPOINT ["node", "apps/api/dist/main.js", "--bind", "0.0.0.0"]

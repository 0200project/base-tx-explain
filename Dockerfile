FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# ⚠️ BAKED AT BUILD TIME, NEVER READ AT REQUEST TIME.
#
# A build identifier computed by the running process from a working tree would
# describe the REPO, not the IMAGE — and would be worse than no field at all,
# because it would look like an answer. These come in as build args and are
# frozen into the image, so /healthz reports what is actually running.
#
# GIT_DIRTY exists because `fly deploy` builds the WORKING DIRECTORY, not a
# commit. A sha alone can therefore lie: deploy with uncommitted changes and the
# image contains code that sha does not describe. Absent build args leave these
# empty and the endpoint reports "unknown" rather than an empty string.
ARG GIT_SHA=""
ARG GIT_DIRTY=""
ENV BUILD_SHA=$GIT_SHA
ENV BUILD_DIRTY=$GIT_DIRTY
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/index.js"]

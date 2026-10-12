FROM node:22-alpine AS build
# The lockfile is generated with npm 11; the npm 10 bundled in the image rejects it.
RUN npm install -g npm@11
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
RUN npm install -g npm@11
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME /app/data
CMD ["node", "dist/index.js"]

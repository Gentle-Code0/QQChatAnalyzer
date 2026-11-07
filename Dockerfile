FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json vite.config.ts index.html ./
COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm run build

FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data APP_PASSWORD_FILE=/run/secrets/app_password PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir /app/data && chown node:node /app/data
COPY --from=build /app/dist/server ./dist/server
USER node
EXPOSE 3000
CMD ["node", "dist/server/server/index.js"]

FROM nginx:stable-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/web /usr/share/nginx/html
EXPOSE 80

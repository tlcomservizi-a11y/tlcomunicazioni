FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production PORT=3100 AUTH_DIR=/data/sessione
VOLUME /data
EXPOSE 3100
HEALTHCHECK --interval=60s CMD wget -qO- http://localhost:3100/salute || exit 1
CMD ["node", "src/server.js"]

FROM weishaw/sub2api:latest

WORKDIR /app

ENV NODE_ENV=production
ENV CHROME_EXECUTABLE_PATH=/usr/bin/chromium

USER root
ENTRYPOINT []
HEALTHCHECK NONE

RUN apk add --no-cache nodejs npm chromium

COPY package*.json ./
RUN npm ci --omit=dev

COPY bin ./bin
COPY src ./src
COPY vendor ./vendor
COPY examples ./examples
COPY scripts ./scripts
COPY docs ./docs
COPY public ./public

EXPOSE 8083

CMD ["node", "bin/auto-relogin.js", "run"]

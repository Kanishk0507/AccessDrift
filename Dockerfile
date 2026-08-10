FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-liberation ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts=false

COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]

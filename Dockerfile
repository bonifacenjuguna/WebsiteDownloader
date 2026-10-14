# Playwright image ships Chromium + all system libs. Version MUST match package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy
WORKDIR /app
# jpegtran: lossless JPEG optimizing (same pixels, fewer bytes). Optional: without it JPEGs are simply left as they are.
RUN apt-get update && apt-get install -y --no-install-recommends libjpeg-turbo-progs && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
# /health answers on $PORT (Railway sets it); point the service health check at /health
EXPOSE 3000
CMD ["node", "src/index.js"]

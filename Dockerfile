FROM node:20-slim

# Install Chromium, Xvfb, and required system dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    xvfb \
    xauth \
    dbus \
    dbus-x11 \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROME_EXECUTABLE_PATH=/usr/bin/chromium
ENV DISPLAY=:99

# Verify chromium exists at build time so the image fails fast if it's missing
RUN which chromium && chromium --version

WORKDIR /app

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application files
COPY . .

# Rename extension folder to remove the space (avoids Linux --load-extension path issues)
RUN mv "/app/Yelp Extntino" /app/yelp-extension

# Make start script executable
RUN chmod +x /app/start.sh

# Persistent data lives on a Fly volume mounted at /data
# - /data/chrome-profile  → Chrome user profile
# - /data/exports         → Downloaded lead files
RUN mkdir -p /data/chrome-profile /data/exports /app/debug

EXPOSE 3000

CMD ["/app/start.sh"]

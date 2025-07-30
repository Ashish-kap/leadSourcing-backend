# FROM node:18-slim

# WORKDIR /app

# # Install dependencies for Puppeteer
# RUN apt-get update && apt-get install -y \
#     gconf-service \
#     libasound2 \
#     libatk1.0-0 \
#     libcairo2 \
#     libcups2 \
#     libfontconfig1 \
#     libgbm-dev \
#     libgdk-pixbuf2.0-0 \
#     libgtk-3-0 \
#     libicu-dev \
#     libjpeg-dev \
#     libnspr4 \
#     libnss3 \
#     libpango-1.0-0 \
#     libpangocairo-1.0-0 \
#     libpng-dev \
#     libx11-6 \
#     libx11-xcb1 \
#     libxcb1 \
#     libxcomposite1 \
#     libxcursor1 \
#     libxdamage1 \
#     libxext6 \
#     libxfixes3 \
#     libxi6 \
#     libxrandr2 \
#     libxrender1 \
#     libxss1 \
#     libxtst6 \
#     fonts-liberation \
#     libappindicator1 \
#     xdg-utils \
#     chromium \
#     && rm -rf /var/lib/apt/lists/*

# # Set Puppeteer to use system Chromium
# ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# COPY package*.json ./
# RUN npm ci --omit=dev

# COPY . .

# CMD ["node", "server.js"]


FROM node:18-slim

WORKDIR /app

# 1. Prevent Puppeteer from downloading Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# 2. Install dependencies and add Google Chrome repo
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       gnupg \
       wget \
       ca-certificates \
       fonts-liberation \
       libasound2 \
       libatk1.0-0 \
       libatk-bridge2.0-0 \
       libcairo2 \
       libcups2 \
       libdbus-1-3 \
       libdrm2 \
       libexpat1 \
       libfontconfig1 \
       libgbm1 \
       libgcc1 \
       libglib2.0-0 \
       libgtk-3-0 \
       libnspr4 \
       libnss3 \
       libpango-1.0-0 \
       libpangocairo-1.0-0 \
       libstdc++6 \
       libx11-6 \
       libx11-xcb1 \
       libxcb1 \
       libxcomposite1 \
       libxcursor1 \
       libxdamage1 \
       libxext6 \
       libxfixes3 \
       libxi6 \
       libxrandr2 \
       libxrender1 \
       libxss1 \
       libxtst6 \
       xdg-utils \
  && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor \
       > /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] \
      http://dl.google.com/linux/chrome/deb stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

# 3. Install your app dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# 4. Copy app code and launch
COPY . .
CMD ["node", "server.js"]

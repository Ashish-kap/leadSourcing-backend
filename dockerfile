# FROM node:21.7.3-slim

# # Install Chromium and dependencies
# RUN apt-get update && \
#     apt-get install -y --no-install-recommends \
#     chromium \
#     libnss3 \
#     libatk1.0-0 \
#     libatk-bridge2.0-0 \
#     libcups2 \
#     libdrm2 \
#     libxkbcommon0 \
#     libxcomposite1 \
#     libxdamage1 \
#     libxfixes3 \
#     libxrandr2 \
#     libgbm1 \
#     libasound2 \
#     libpangocairo-1.0-0 \
#     libxshmfence1 \
#     && rm -rf /var/lib/apt/lists/*


# # Set working directory to /app (matches your error logs)
# WORKDIR /app

# # Copy package files and install dependencies
# COPY package*.json ./
# RUN npm install

# # Copy application code
# COPY . .

# # Expose port
# EXPOSE 3000

# # Start application
# CMD ["node", "server.js"]

# FROM node:21.7.3-slim
FROM node:22-alpine

# Install Chromium and dependencies
RUN apk add --no-cache \
    chromium \
    nss \
    atk \
    at-spi2-atk \
    cups-libs \
    libdrm \
    libxkbcommon \
    libxcomposite \
    libxdamage \
    libxfixes \
    libxrandr \
    mesa-gbm \
    alsa-lib \
    pango \
    libxshmfence

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Expose port
EXPOSE 3000

# Start application
CMD ["node", "server.js"]

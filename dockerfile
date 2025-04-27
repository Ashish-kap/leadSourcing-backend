# FROM node:18-alpine

# WORKDIR /app

# COPY package*.json ./

# RUN npm install

# COPY . .

# EXPOSE 3000

# CMD ["node", "server.js"]


FROM node:18-alpine

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm ci --omit=dev  # Use clean install and skip dev dependencies

# Copy application files
COPY . .

# Use environment-defined port (required by Railway)
ENV PORT=8080
EXPOSE $PORT

# Start command (ensure this matches your entry file)
CMD ["node", "server.js"]
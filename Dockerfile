# Use a lightweight Node.js image
FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (skip Playwright browser download to save space/time for the Web UI)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Expose the port Render expects
EXPOSE 3000

# Start the web server
CMD ["npm", "run", "web"]

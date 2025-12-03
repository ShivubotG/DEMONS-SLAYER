# Official Playwright image with Node.js and all browser dependencies
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create logs and uploads directories
RUN mkdir -p logs uploads

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

# Run as non-root user
USER pwuser

# Start the application
CMD ["npm", "start"]

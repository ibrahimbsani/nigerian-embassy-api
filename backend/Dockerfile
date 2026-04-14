FROM node:18-alpine

# Install openssl for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package files first (better Docker layer caching)
COPY package*.json ./

# Install ALL dependencies (including devDeps needed for build)
RUN npm install

# Copy all source files
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build NestJS (produces /app/dist/)
RUN npm run build

# Verify dist/main.js exists
RUN ls -la dist/

EXPOSE 3000

# At runtime: run DB migrations then start the server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]

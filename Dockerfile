# Use a lightweight version of Node.js
FROM node:20-alpine

# Install FFmpeg (Critical for your thumbnail/compression code)
RUN apk add --no-cache ffmpeg

# Set the working directory inside the container
WORKDIR /app

# Copy dependency files first (for faster builds)
COPY package*.json ./

# Install the dependencies
RUN npm install

# Copy the rest of your app code
COPY . .

# Create the uploads folder manually to avoid permission issues
RUN mkdir -p uploads

# Expose the port your app uses
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
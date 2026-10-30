FROM node:22-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/ ./
COPY frontend/ ./frontend/
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV HOST=0.0.0.0 PORT=3000 PUBLIC_DIR=/app/frontend
EXPOSE 3000
USER node
CMD ["npm","start"]

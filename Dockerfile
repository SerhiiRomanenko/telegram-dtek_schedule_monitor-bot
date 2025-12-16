FROM node:18-slim

RUN apt update && apt install -y tesseract-ocr && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "index.js"]

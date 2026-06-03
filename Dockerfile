FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY . .

ENV PORT=8080
ENV STORAGE_DIR=/var/data
VOLUME ["/var/data"]
EXPOSE 8080

CMD ["npm", "start"]

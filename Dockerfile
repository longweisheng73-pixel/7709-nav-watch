FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV DASHBOARD_HOST=0.0.0.0

EXPOSE 5173

CMD ["npm", "start"]

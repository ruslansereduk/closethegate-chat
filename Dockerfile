FROM node:18-alpine

WORKDIR /app

# Копируем package.json и package-lock.json
COPY package.json package-lock.json ./

# Устанавливаем все зависимости (включая dev для сборки)
RUN npm ci

# Копируем исходный код
COPY . .

# Собираем TypeScript
RUN npm run build

# Удаляем исходники и dev зависимости, переустанавливаем только production
RUN rm -rf src tsconfig.json && \
    npm ci --omit=dev && \
    npm cache clean --force

EXPOSE 3001

CMD ["npm", "start"]

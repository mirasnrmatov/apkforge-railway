# Тек Node.js — APK build GitHub Actions-та жүреді (.github/workflows/build-apk.yml),
# сондықтан контейнерге Java мен Android SDK керек емес.
FROM node:20-slim

WORKDIR /app

# алдымен package.json (кэш үшін)
COPY package*.json ./
RUN npm install --omit=dev

# қалған кодты көшіру
COPY . .

# порт (Railway PORT айнымалысын береді)
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

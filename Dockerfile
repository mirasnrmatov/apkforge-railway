# Node.js + Java + Android SDK бар контейнер
FROM node:20-bookworm

# ---- Java 17 (Gradle build үшін) ----
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jdk-headless \
    unzip wget \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64

# ---- Android SDK ----
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk

# command-line tools жүктеу
RUN mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O /tmp/cmdtools.zip && \
    unzip -q /tmp/cmdtools.zip -d ${ANDROID_SDK_ROOT}/cmdline-tools && \
    mv ${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools ${ANDROID_SDK_ROOT}/cmdline-tools/latest && \
    rm /tmp/cmdtools.zip

ENV PATH=${PATH}:${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${ANDROID_SDK_ROOT}/platform-tools

# лицензияларды қабылдау + керекті пакеттерді орнату
RUN yes | sdkmanager --licenses > /dev/null 2>&1 || true && \
    sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0" > /dev/null 2>&1

# ---- қосымша коды ----
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

const fs = require('fs');
const path = require('path');

const baseConfig = require('./app.json');

const loadEnvFile = (filename) => {
  const filePath = path.join(__dirname, filename);
  if (!fs.existsSync(filePath)) {
    return;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      return;
    }
    const key = match[1];
    if (process.env[key]) {
      return;
    }
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  });
};

loadEnvFile('.env.local');
loadEnvFile('.env');

const googleMapsApiKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;

const config = {
  ...baseConfig.expo,
  android: {
    ...baseConfig.expo.android,
    config: {
      ...baseConfig.expo.android?.config,
      googleMaps: googleMapsApiKey
        ? {
            apiKey: googleMapsApiKey,
          }
        : baseConfig.expo.android?.config?.googleMaps,
    },
  },
};

module.exports = config;

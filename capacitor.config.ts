import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.rafaelminatto.minattoflix',
  appName: 'MinattoFlix',
  webDir: 'dist/native',
  backgroundColor: '#141414',
  ios: {
    contentInset: 'never',
    preferredContentMode: 'mobile',
  },
};

export default config;

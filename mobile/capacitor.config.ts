import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.dcouple.pane.mobile',
  appName: 'Pane',
  webDir: 'www',
  server: { androidScheme: 'https' },
  plugins: {
    Keyboard: { resize: 'body' },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
